/**
 * Outcome read-back test: the bridge reconciles a missing receipt from the
 * durable outcome rows, and refuses to infer absence from a truncated window.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { matchOutcomeRow } from "../src/outcome-sink.ts";
import type { CandidateResult } from "../src/bridge.ts";

const ROW = JSON.stringify({
  seq: 4,
  epoch: 1,
  task: "T1",
  verdict: "routine",
  summary: "disposition=ready_for_review; ok",
});

const RESULT: CandidateResult = {
  task: "T1",
  verdict: "routine",
  summary: "disposition=ready_for_review; ok",
};

test("a matching committed row is returned as its sequence", () => {
  assert.equal(matchOutcomeRow([ROW], RESULT), 4);
});

test("a different row proves the result is absent", () => {
  const other = JSON.stringify({ seq: 9, task: "T2", verdict: "routine", summary: "other" });
  assert.equal(matchOutcomeRow([other], RESULT), null);
  assert.equal(matchOutcomeRow([], RESULT), null);
});

test("a full window refuses instead of reporting absence", () => {
  const rows = [ROW, ROW];
  assert.throws(() => matchOutcomeRow(rows, { task: "T9", verdict: "routine", summary: "absent" }, 2));
});

test("a matching row without a sequence is refused rather than trusted", () => {
  const malformed = JSON.stringify({ task: "T1", verdict: "routine", summary: RESULT.summary });
  assert.throws(() => matchOutcomeRow([malformed], RESULT));
});
