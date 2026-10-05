/**
 * P1C bridge tests: candidate-result validation, dispatch idempotency, and the
 * authority-guarded outcome append.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BridgeError,
  parseCandidateResult,
  runDurableDispatch,
  type DispatchOutcome,
  type DispatchTransport,
} from "../src/bridge.ts";

/** A transport that answers each dispatch call from a queue, last answer repeating. */
function fakeTransport(outcomes: DispatchOutcome | DispatchOutcome[]) {
  const queue = Array.isArray(outcomes) ? [...outcomes] : [outcomes];
  const appends: { operationId: string; task: string; summary: string }[] = [];
  let calls = 0;
  const transport: DispatchTransport = {
    async dispatch() {
      calls += 1;
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    async appendOutcome(input) {
      appends.push({
        operationId: input.operationId,
        task: input.result.task,
        summary: input.result.summary,
      });
      return { seq: appends.length };
    },
  };
  return { transport, appends, dispatchCalls: () => calls };
}

test("a valid candidate result is parsed strictly", () => {
  assert.deepEqual(parseCandidateResult({ task: "task-1", verdict: "routine", summary: "ok" }), {
    task: "task-1",
    verdict: "routine",
    summary: "ok",
  });
  assert.deepEqual(
    parseCandidateResult({
      task: "fleet",
      verdict: "captain",
      summary: "needs a call",
      wake: "heartbeat",
      silent: true,
    }),
    { task: "fleet", verdict: "captain", summary: "needs a call", wake: "heartbeat", silent: true },
  );
});

test("a malformed candidate result is refused with a diagnosable reason", () => {
  const cases: unknown[] = [
    null,
    [],
    "text",
    { verdict: "routine", summary: "ok" },
    { task: "", verdict: "routine", summary: "ok" },
    { task: "t", verdict: "other", summary: "x" },
    { task: "t", verdict: "routine" },
    { task: "t", verdict: "routine", summary: "" },
    { task: "t", verdict: "routine", summary: "x", wake: 1 },
    { task: "t", verdict: "routine", summary: "x", silent: "yes" },
    { task: "t", verdict: "routine", summary: "x", extra: true },
  ];
  for (const value of cases) {
    assert.throws(
      () => parseCandidateResult(value),
      (error: unknown) => error instanceof BridgeError && error.code === "MALFORMED_RESULT",
    );
  }
});

test("a first dispatch appends under the operation key and records the receipt", async () => {
  const { transport, appends, dispatchCalls } = fakeTransport({
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "all clear" },
    replayed: false,
    receipt: null,
  });
  const result = await runDurableDispatch(
    { transport },
    { operationId: "op-1", prompt: "p", payload: {} },
  );
  assert.deepEqual(result, { seq: 1, replayed: false });
  assert.deepEqual(appends, [{ operationId: "op-1", task: "task-1", summary: "all clear" }]);
  // One execution dispatch; the sidecar owns the authority check and append.
  assert.equal(dispatchCalls(), 1);
});

test("a settled repeat with a receipt appends nothing", async () => {
  const { transport, appends, dispatchCalls } = fakeTransport({
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "all clear" },
    replayed: true,
    receipt: { seq: 4 },
  });
  const result = await runDurableDispatch(
    { transport },
    { operationId: "op-1", prompt: "p", payload: {} },
  );
  assert.deepEqual(result, { seq: 4, replayed: true });
  assert.deepEqual(appends, []);
  assert.equal(dispatchCalls(), 1);
});

test("a settled repeat without a receipt appends-or-gets exactly once under its key", async () => {
  const { transport, appends } = fakeTransport({
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "all clear" },
    replayed: true,
    receipt: null,
  });
  const result = await runDurableDispatch(
    { transport },
    { operationId: "op-1", prompt: "p", payload: {} },
  );
  assert.deepEqual(result, { seq: 1, replayed: true, reconciled: true });
  assert.deepEqual(appends, [{ operationId: "op-1", task: "task-1", summary: "all clear" }]);
});

test("an ownership replacement refuses the outcome append", async () => {
  const transport: DispatchTransport = {
    async dispatch() {
      return {
        ok: true,
        result: { task: "task-1", verdict: "routine", summary: "all clear" },
        replayed: false,
        receipt: null,
      };
    },
    async appendOutcome() {
      throw new BridgeError("AUTHORITY_STALE", "generation replaced");
    },
  };
  await assert.rejects(
    () => runDurableDispatch({ transport }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "AUTHORITY_STALE",
  );
});

test("an append that cannot decide stays unresolved", async () => {
  const transport: DispatchTransport = {
    async dispatch() {
      return {
        ok: true,
        result: { task: "task-1", verdict: "routine", summary: "all clear" },
        replayed: true,
        receipt: null,
      };
    },
    async appendOutcome() {
      throw new Error("outcome store unavailable");
    },
  };
  await assert.rejects(
    () => runDurableDispatch({ transport }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "RECONCILE_REQUIRED",
  );
});

test("two distinct operations with identical text each append under their own key", async () => {
  const outcome: DispatchOutcome = {
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "identical text" },
    replayed: false,
    receipt: null,
  };
  const { transport, appends } = fakeTransport(outcome);
  const first = await runDurableDispatch(
    { transport },
    { operationId: "op-1", prompt: "p", payload: {} },
  );
  const second = await runDurableDispatch(
    { transport },
    { operationId: "op-2", prompt: "p", payload: {} },
  );
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(appends.map((row) => row.operationId), ["op-1", "op-2"]);
});

test("a malformed sidecar result is refused before the outcome is appended", async () => {
  const { transport, appends } = fakeTransport({
    ok: true,
    result: { verdict: "routine" },
    replayed: false,
    receipt: null,
  });
  await assert.rejects(
    () => runDurableDispatch({ transport }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "MALFORMED_RESULT",
  );
  assert.deepEqual(appends, []);
});

test("a sidecar refusal is surfaced as a bridge error", async () => {
  const { transport, appends } = fakeTransport({ ok: false, code: "AUTHORITY_STALE", message: "stale" });
  await assert.rejects(
    () => runDurableDispatch({ transport }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "AUTHORITY_STALE",
  );
  assert.deepEqual(appends, []);
});
