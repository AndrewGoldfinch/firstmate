/**
 * P1C bridge tests: candidate-result validation and dispatch idempotency.
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

function fakeTransport(outcome: DispatchOutcome) {
  const receipts: { operationId: string; seq: number }[] = [];
  const transport: DispatchTransport = {
    async dispatch() {
      return outcome;
    },
    async recordReceipt(operationId, seq) {
      receipts.push({ operationId, seq });
    },
  };
  return { transport, receipts };
}

function fakeSink() {
  const appended: { summary: string; task: string }[] = [];
  const sink: OutcomeSink = {
    async append(result) {
      appended.push({ summary: result.summary, task: result.task });
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

test("a first dispatch appends the outcome and records the receipt", async () => {
  const { transport, receipts } = fakeTransport({
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
  assert.deepEqual(appended, [{ summary: "all clear", task: "task-1" }]);
  assert.deepEqual(receipts, [{ operationId: "op-1", seq: 1 }]);
});

test("a settled repeat with a receipt appends nothing", async () => {
  const { transport, receipts } = fakeTransport({
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
});

test("a settled repeat without a receipt is refused rather than blindly appended", async () => {
  const { transport, receipts } = fakeTransport({
    ok: true,
    result: { task: "task-1", verdict: "routine", summary: "all clear" },
    replayed: true,
    receipt: null,
  });
  const { sink, appended } = fakeSink();
  await assert.rejects(
    () => runDurableDispatch({ transport, sink }, { operationId: "op-1", prompt: "p", payload: {} }),
    (error: unknown) => error instanceof BridgeError && error.code === "RECONCILE_REQUIRED",
  );
  assert.deepEqual(appended, []);
  assert.deepEqual(receipts, []);
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
