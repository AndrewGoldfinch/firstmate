/**
 * Durable wake-batch identity tests: the extension's operation id is distinct
 * per accepted wake batch, survives a retry or process restart while the batch
 * is pending, and rotates after the batch completes.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

// Loaded dynamically with a non-literal specifier: the extension lib is a Pi
// runtime module outside this package's tsconfig program, and this test only
// needs its exported identity helpers at runtime.
type WakeIdentity = { operationId: string; batch: number };
const providerModule = (await import(
  fileURLToPath(new URL("../../../.pi/extensions/lib/fm-execution-provider.ts", import.meta.url))
)) as {
  durableWakeOperationId: (input: {
    stateDir: string;
    homeId: string;
    generation: number;
    wakeClaimId: string;
    rowIds: readonly string[];
  }) => WakeIdentity;
  markDurableWakeCompleted: (stateDir: string, operationId: string) => void;
};
const { durableWakeOperationId, markDurableWakeCompleted } = providerModule;

const scratch = mkdtempSync(join(tmpdir(), "fm-pi-durable-wake-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function stateDir(name: string): string {
  const dir = join(scratch, name, "state");
  return dir;
}

test("two successive wake batches get distinct operation identities", () => {
  const state = stateDir("successive");
  const first = durableWakeOperationId({
    stateDir: state,
    homeId: "/home/a",
    generation: 1,
    wakeClaimId: "gen-1",
    rowIds: ["1", "2"],
  });
  const second = durableWakeOperationId({
    stateDir: state,
    homeId: "/home/a",
    generation: 1,
    wakeClaimId: "gen-1",
    rowIds: ["3"],
  });
  assert.notEqual(first.operationId, second.operationId);
  assert.equal(second.batch, first.batch + 1);
});

test("a pending batch keeps its identity across a retry or restart", () => {
  const state = stateDir("retry");
  const input = {
    stateDir: state,
    homeId: "/home/a",
    generation: 2,
    wakeClaimId: "gen-2",
    rowIds: ["7", "8"],
  };
  const first = durableWakeOperationId(input);
  // A second call uses only the persisted record, exactly as a restarted
  // process would; the same pending batch must not mint a new identity.
  const retry = durableWakeOperationId({ ...input, rowIds: ["8", "7"] });
  assert.equal(retry.operationId, first.operationId);
  assert.equal(retry.batch, first.batch);
});

test("a completed batch rotates its identity on the next wake", () => {
  const state = stateDir("completed");
  const input = {
    stateDir: state,
    homeId: "/home/a",
    generation: 3,
    wakeClaimId: "gen-3",
    rowIds: ["9"],
  };
  const first = durableWakeOperationId(input);
  markDurableWakeCompleted(state, first.operationId);
  const next = durableWakeOperationId(input);
  assert.notEqual(next.operationId, first.operationId);
  assert.equal(next.batch, first.batch + 1);
});

test("the operation identity carries the home and generation", () => {
  const state = stateDir("named");
  const identity = durableWakeOperationId({
    stateDir: state,
    homeId: "/home/alpha",
    generation: 4,
    wakeClaimId: "gen-4",
    rowIds: [],
  });
  assert.ok(identity.operationId.startsWith("fm:/home/alpha:supervision:batch-1:"));
  assert.ok(identity.operationId.length <= 256);
});
