/**
 * Outcome sink tests: the store append is keyed by the operation identity, so
 * a retry returns the stored sequence and two distinct operations with
 * identical text get distinct rows.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { MAX_OPERATION_KEY_CHARS, createOutcomeSink } from "../src/outcome-sink.ts";

const scriptPath = fileURLToPath(new URL("../../../bin/fm-branch-outcome.sh", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "fm-pi-durable-sink-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function tempHome(name: string): string {
  const home = join(scratch, name);
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

function readRows(home: string): { seq: number; operationKey?: string; summary: string }[] {
  return readFileSync(join(home, "state", "branch-outcomes.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("the same operation key returns the stored sequence and appends once", async () => {
  const home = tempHome("same-key");
  const sink = createOutcomeSink({ scriptPath, env: { ...process.env, FM_HOME: home } });
  const result = { task: "fleet", verdict: "routine" as const, summary: "identical text" };
  const first = await sink.appendOrGet("op-a", result);
  const second = await sink.appendOrGet("op-a", result);
  assert.equal(first, 1);
  assert.equal(second, 1);
  const rows = readRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.operationKey, "op-a");
});

test("two distinct operations with identical text get distinct rows", async () => {
  const home = tempHome("distinct-keys");
  const sink = createOutcomeSink({ scriptPath, env: { ...process.env, FM_HOME: home } });
  const result = { task: "fleet", verdict: "routine" as const, summary: "identical text" };
  const first = await sink.appendOrGet("op-a", result);
  const second = await sink.appendOrGet("op-b", result);
  assert.equal(first, 1);
  assert.equal(second, 2);
  const rows = readRows(home);
  assert.deepEqual(rows.map((row) => row.operationKey), ["op-a", "op-b"]);
});

test("an invalid operation key is refused before the store is touched", async () => {
  const home = tempHome("bad-key");
  const sink = createOutcomeSink({ scriptPath, env: { ...process.env, FM_HOME: home } });
  const result = { task: "fleet", verdict: "routine" as const, summary: "text" };
  await assert.rejects(() => sink.appendOrGet("", result));
  await assert.rejects(() => sink.appendOrGet("bad\nkey", result));
  await assert.rejects(() => sink.appendOrGet("x".repeat(MAX_OPERATION_KEY_CHARS + 1), result));
});
