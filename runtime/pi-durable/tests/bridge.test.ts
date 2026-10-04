/**
 * P1C bridge tests: candidate-result validation, dispatch idempotency, and the
 * authority recheck at the outcome mutation boundary.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BridgeError,
  parseCandidateResult,
  runDurableDispatch,
  type DispatchOutcome,
  type DispatchTransport,
  type OutcomeSink,
} from "../src/bridge.ts";

/** A transport that answers each dispatch call from a queue, last answer repeating. */
function fakeTransport(outcomes: DispatchOutcome | DispatchOutcome[]) {
  const queue = Array.isArray(outcomes) ? [...outcomes] : [outcomes];
  const receipts: { operationId: string; seq: number }[] = [];
  let calls = 0;
  const transport: DispatchTransport = {
    async dispatch() {
      calls += 1;
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    async recordReceipt(operationId, seq) {
      receipts.push({ operationId, seq });
    },
  };
  return { transport, receipts, dispatchCalls: () => calls };
}

function fakeSink() {
  const appended: { key: string; summary: string; task: string }[] = [];
  const sink: OutcomeSink = {
    async appendOrGet(operationKey, result) {
      appended.push({ key: operationKey, summary: result.summary, task: result.task });
      return appended.length;
    },
  };
  return { sink, appended };
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
  const { transport, receipts, dispatchCalls } = fakeTransport({
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "all clear" },
    replayed: false,
    receipt: null,
  });
  const { sink, appended } = fakeSink();
  const result = await runDurableDispatch(
    { transport, sink },
    { operationId: "op-1", prompt: "p", payload: {} },
  );
  assert.deepEqual(result, { seq: 1, replayed: false });
  assert.deepEqual(appended, [{ key: "op-1", summary: "all clear", task: "task-1" }]);
  assert.deepEqual(receipts, [{ operationId: "op-1", seq: 1 }]);
  // One execution dispatch plus one authority recheck at the mutation boundary.
  assert.equal(dispatchCalls(), 2);
});

test("a settled repeat with a receipt appends nothing", async () => {
  const { transport, receipts, dispatchCalls } = fakeTransport({
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "all clear" },
    replayed: true,
    receipt: { seq: 4 },
  });
  const { sink, appended } = fakeSink();
  const result = await runDurableDispatch(
    { transport, sink },
    { operationId: "op-1", prompt: "p", payload: {} },
  );
  assert.deepEqual(result, { seq: 4, replayed: true });
  assert.deepEqual(appended, []);
  assert.deepEqual(receipts, []);
  assert.equal(dispatchCalls(), 1);
});

test("a settled repeat without a receipt appends-or-gets exactly once under its key", async () => {
  const { transport, receipts } = fakeTransport({
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "all clear" },
    replayed: true,
    receipt: null,
  });
  const { sink, appended } = fakeSink();
  const result = await runDurableDispatch(
    { transport, sink },
    { operationId: "op-1", prompt: "p", payload: {} },
  );
  assert.deepEqual(result, { seq: 1, replayed: true, reconciled: true });
  assert.deepEqual(appended, [{ key: "op-1", summary: "all clear", task: "task-1" }]);
  assert.deepEqual(receipts, [{ operationId: "op-1", seq: 1 }]);
});

test("an ownership replacement after settlement refuses the append and the receipt", async () => {
  const { transport, receipts } = fakeTransport([
    {
      ok: true,
      result: { task: "task-1", verdict: "routine", summary: "all clear" },
      replayed: false,
      receipt: null,
    },
    { ok: false, code: "AUTHORITY_STALE", message: "generation replaced" },
  ]);
  const { sink, appended } = fakeSink();
  await assert.rejects(
    () => runDurableDispatch({ transport, sink }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "AUTHORITY_STALE",
  );
  assert.deepEqual(appended, []);
  assert.deepEqual(receipts, []);
});

test("an append-or-get that cannot decide stays unresolved", async () => {
  const { transport, receipts } = fakeTransport({
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "all clear" },
    replayed: true,
    receipt: null,
  });
  const sink: OutcomeSink = {
    async appendOrGet() {
      throw new Error("outcome store unavailable");
    },
  };
  await assert.rejects(
    () => runDurableDispatch({ transport, sink }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "RECONCILE_REQUIRED",
  );
  assert.deepEqual(receipts, []);
});

test("two distinct operations with identical text each append under their own key", async () => {
  const outcome: DispatchOutcome = {
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "identical text" },
    replayed: false,
    receipt: null,
  };
  const { transport } = fakeTransport(outcome);
  const { sink, appended } = fakeSink();
  const first = await runDurableDispatch(
    { transport, sink },
    { operationId: "op-1", prompt: "p", payload: {} },
  );
  const second = await runDurableDispatch(
    { transport, sink },
    { operationId: "op-2", prompt: "p", payload: {} },
  );
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(appended.map((row) => row.key), ["op-1", "op-2"]);
});

test("a malformed sidecar result is refused before the outcome is appended", async () => {
  const { transport } = fakeTransport({
    ok: true,
    result: { verdict: "routine" },
    replayed: false,
    receipt: null,
  });
  const { sink, appended } = fakeSink();
  await assert.rejects(
    () => runDurableDispatch({ transport, sink }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "MALFORMED_RESULT",
  );
  assert.deepEqual(appended, []);
});

test("a sidecar refusal is surfaced as a bridge error", async () => {
  const { transport } = fakeTransport({ ok: false, code: "AUTHORITY_STALE", message: "stale" });
  const { sink, appended } = fakeSink();
  await assert.rejects(
    () => runDurableDispatch({ transport, sink }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "AUTHORITY_STALE",
  );
  assert.deepEqual(appended, []);
});
