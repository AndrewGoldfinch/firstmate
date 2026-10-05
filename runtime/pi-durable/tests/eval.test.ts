/**
 * P2 harness test: the deterministic evaluation runs end to end and its
 * independent grader accepts the truthful traces and rejects every corrupted
 * one.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runEvaluation } from "../eval/main.ts";

const workDirs: string[] = [];

// The container lane and the real-model pilot are exercised by `npm run eval`;
// the unit test skips both so the suite stays fast and independent of a Docker
// daemon and of a reachable provider credential.
process.env.FM_PI_DURABLE_SKIP_DOCKER = "1";
process.env.FM_PI_DURABLE_SKIP_PILOT = "1";
process.env.FM_PI_DURABLE_CALIBRATION_RUNS = "2";
process.env.FM_PI_DURABLE_BENEFIT_RUNS = "2";

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

test("the deterministic harness grades both arms and rejects every corrupted trace", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "fm-pi-durable-eval-test-"));
  workDirs.push(workDir);
  const results = await runEvaluation(workDir);

  assert.equal(results.grades.existing.passed, true, "arm A must pass the fleet without a fault");
  assert.equal(results.grades["pi-durable"].passed, true, "arm B must pass the fleet without a fault");

  // Both arms complete the required recovery: the existing path re-presents
  // the interrupted wake and the durable path reattaches its accepted
  // operation, so no accepted task is lost.
  assert.equal(results.grades.existingWithFault.passed, true, "arm A must recover the interrupted task");
  assert.equal(results.grades["pi-durableWithFault"].passed, true, "arm B must recover the interrupted task");
  assert.equal(
    results.grades.existingWithFault.checks.find((check) => check.name === "no lost accepted row")?.ok,
    true,
  );
  assert.equal(
    results.grades["pi-durableWithFault"].checks.find((check) => check.name === "no lost accepted row")?.ok,
    true,
  );

  for (const control of results.negativeControls) {
    assert.equal(control.rejected, true, `grader must reject: ${control.name}`);
  }

  assert.equal(results.matrix.filter((caseResult) => caseResult.status === "fail").length, 0);
  assert.ok(results.matrix.filter((caseResult) => caseResult.status === "pass").length >= 10);
  assert.ok(results.matrix.some((caseResult) => caseResult.status === "not-covered"));
  assert.equal(results.dockerLane.status, "not-covered");
  assert.equal(results.pilot.status, "not-covered");
  assert.equal(results.calibration.status, "pass");
  assert.equal(results.calibration.samples.length, 2);
  assert.ok(results.calibration.thresholds.recoveryTimeReductionPercent >= 30);

  // Benefit validation: the post-effect fault must duplicate the existing
  // path's non-idempotent append and must be replayed once by the durable sink,
  // with recovery parity and no stale-owner action in either arm.
  assert.equal(results.benefit.status, "pass");
  assert.equal(results.benefit.runs, 2);
  assert.ok(
    results.benefit.duplicateOutcomes.existing.successes > 0,
    "arm A must show a duplicate applied effect after the post-effect fault",
  );
  assert.equal(results.benefit.duplicateOutcomes.durable.successes, 0, "arm B must replay without a duplicate effect");
  assert.equal(results.benefit.promotionGate.recoveryParity, true);
  assert.equal(results.benefit.promotionGate.zeroStaleOwnerActions, true);
  assert.equal(results.benefit.promotionGate.duplicateReduction, true);
  assert.equal(results.benefit.promotionGate.verdict, "advance");
});
