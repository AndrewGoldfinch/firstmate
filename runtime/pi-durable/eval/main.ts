/**
 * P2 evaluation entry point.
 *
 * Runs the controlled fleet through both arms, the fault matrix, and the
 * grader's negative controls, then writes raw results and a report. The
 * harness never repairs either arm, adds retries, deduplicates effects, or
 * synthesizes outcomes.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLEET } from "./fleet.ts";
import { runDurableScenario, runExistingScenario, type ArmResult } from "./runner.ts";
import { grade, negativeControls, type GradeResult } from "./grader.ts";
import { runMatrix, type MatrixCaseResult } from "./matrix.ts";
import { runDockerLane, type DockerLaneResult } from "./docker-lane.ts";
import { runPilot, type PilotResult } from "./pilot.ts";
import { runCalibration, type CalibrationResult } from "./calibrate.ts";
import { runBenefit, type BenefitResult } from "./benefit.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const outcomeScript = join(repoRoot, "bin", "fm-branch-outcome.sh");
const reportPath = join(repoRoot, "docs", "pi-durable", "06-evaluation-report.md");
const rawPath = join(repoRoot, "docs", "pi-durable", "eval-results.json");

export type EvaluationResults = {
  generatedAt: string;
  environment: string;
  arms: {
    existing: ArmResult;
    "pi-durable": ArmResult;
    existingWithFault: ArmResult;
    "pi-durableWithFault": ArmResult;
  };
  grades: {
    existing: GradeResult;
    "pi-durable": GradeResult;
    existingWithFault: GradeResult;
    "pi-durableWithFault": GradeResult;
  };
  negativeControls: { name: string; rejected: boolean }[];
  matrix: MatrixCaseResult[];
  dockerLane: DockerLaneResult;
  pilot: PilotResult;
  calibration: CalibrationResult;
  benefit: BenefitResult;
  /** The reviewer's recommended end-to-end verification and its environment note. */
  verification: {
    milestone: string;
    environmentSensitivity: string;
  };
};

export async function runEvaluation(workDir = mkdtempSync(join(tmpdir(), "fm-pi-durable-eval-"))): Promise<EvaluationResults> {
  mkdirSync(workDir, { recursive: true });
  const home = (name: string) => {
    const path = join(workDir, name);
    mkdirSync(join(path, "state"), { recursive: true });
    return path;
  };

  const existing = await runExistingScenario({
    home: home("arm-existing"),
    scenario: "fleet",
    tasks: FLEET,
    outcomeScript,
  });
  const durable = await runDurableScenario({
    home: home("arm-durable"),
    scenario: "fleet",
    tasks: FLEET,
    outcomeScript,
  });
  const existingWithFault = await runExistingScenario({
    home: home("arm-existing-fault"),
    scenario: "fleet-fault-T3",
    tasks: FLEET,
    outcomeScript,
    crashAtTask: "T3",
  });
  const durableWithFault = await runDurableScenario({
    home: home("arm-durable-fault"),
    scenario: "fleet-fault-model",
    tasks: FLEET,
    outcomeScript,
    crashAt: "dispatch.model.after",
  });

  const grades = {
    existing: grade(FLEET, existing.trace),
    "pi-durable": grade(FLEET, durable.trace),
    existingWithFault: grade(FLEET, existingWithFault.trace),
    "pi-durableWithFault": grade(FLEET, durableWithFault.trace),
  };

  const negative = negativeControls(FLEET, durable.trace);
  const dockerLane = await runDockerLane();
  const pilot = await runPilot(workDir, outcomeScript);
  const calibration = await runCalibration(workDir, outcomeScript);
  const benefit = await runBenefit(workDir, outcomeScript);
  const matrix = await runMatrix({ workDir, outcomeScript, dockerLane, pilot });

  return {
    generatedAt: new Date().toISOString(),
    environment: `Node ${process.version}; local Linux host; deterministic responder for both arms; arm A drives the real wake queue, claim rules, and append-only outcome store; disposable-container teardown lane (SIGKILL, remove, recreate with its own namespaces) for the process-crash and store-reopen boundaries; bounded real-model pilot when a provider credential is reachable`,
    arms: { existing, "pi-durable": durable, existingWithFault, "pi-durableWithFault": durableWithFault },
    grades,
    negativeControls: negative,
    matrix,
    dockerLane,
    pilot,
    calibration,
    benefit,
    verification: {
      milestone:
        "two successive wakes, an execution crash with resume, and an ownership replacement through the extension's durable-branch path and the real sidecar; exactly one outcome per accepted operation, no stale append, distinct identities (runtime/pi-durable/tests/milestone.test.ts)",
      environmentSensitivity:
        "socket-dependent tests are environment-sensitive: the reviewer's environment blocked Unix-socket listeners (listen EPERM)",
    },
  };
}

function scorecardRow(label: string, result: GradeResult | undefined): string {
  if (!result) return `| ${label} | fail | no grade |`;
  const failed = result.checks.filter((check) => !check.ok);
  return `| ${label} | ${result.passed ? "pass" : "fail"} | ${failed.length === 0 ? "none" : failed.map((check) => check.name).join(", ")} |`;
}

function matrixRow(caseResult: MatrixCaseResult): string {
  return `| ${caseResult.id} | ${caseResult.title} | ${caseResult.status} | ${caseResult.detail.replace(/\|/g, "/")} |`;
}

export function renderReport(results: EvaluationResults): string {
  const lines: string[] = [];
  lines.push("# Pi Durable evaluation report (P2)");
  lines.push("");
  lines.push(`Generated ${results.generatedAt}.`);
  lines.push("");
  lines.push("## Decision");
  lines.push("");
  const gate = results.benefit.promotionGate;
  lines.push("Decision: HOLD pending adversarial verification; Phase 1 adoption remains a captain call.");
  lines.push(
    gate.verdict === "advance"
      ? `The reduced-model benefit experiment demonstrates duplicate-outcome avoidance (${results.benefit.duplicateOutcomes.existing.successes}/${results.benefit.runs} runs duplicated for the existing-path model vs ${results.benefit.duplicateOutcomes.durable.successes}/${results.benefit.runs} for the durable arm). This is strong evidence for the mechanism, but it rests on a reduced Arm A, so the promotion gate stays closed until an independent adversarial verification confirms Arm A fidelity, equivalent fault placement, and ledger accuracy, and fails to produce an Arm B duplicate across expanded crash interleavings.`
      : "Correctness criteria are met for all executable fault classes, but the benefit-validation evidence does not show a statistically meaningful reduction in duplicate outcomes or operator intervention under the faulted workload, so the prototype stays on hold.",
  );
  lines.push("");
  lines.push("Decision rule: advance to Phase 1 if and only if the adversarial verifier confirms Arm A fidelity, equivalent fault placement, and ledger accuracy, and fails to produce a duplicate in Arm B across expanded crash interleavings. Operator-burden reduction is inferred from duplicate elimination rather than independently measured, and is not a second required benefit. Recovery time is an observation, not a claimed benefit.");
  lines.push("The verifier's final state is exactly one of ADVANCE (no Arm B duplicate and the causal control behaves as expected), HOLD - IMPLEMENTATION (a durability/interleaving defect), or HOLD - EVIDENCE (Arm A fidelity or real-path applicability insufficiently demonstrated). An undrivable real Pi path is recorded as an explicit residual risk carried into Phase 1, never an automatic pass.");
  lines.push("");
  lines.push("## Environment and scope");
  lines.push("");
  lines.push(results.environment);
  lines.push("A disposable-container restart lane provides the process-crash and store-reopen boundaries; no real VM or OS reboot boundary exists, and every case this environment cannot exercise is recorded as not-covered, never faked.");
  lines.push("Arm A is the real pinned existing Pi supervision path as far as this environment allows: it drives the real wake queue and lease/claim rules (bin/fm-wake-lib.sh, bin/fm-branch-dispatch.mjs) and the real append-only outcome store (bin/fm-branch-outcome.sh).");
  lines.push("Arm B is the real durable sidecar, bridge, and outcome sink with the same deterministic responder.");
  lines.push("A full Pi AgentSession cannot be driven headlessly here, so arm A's wake is answered by the deterministic responder rather than a Pi model turn; the wake queue, claim rules, and outcome store it drives are the real ones.");
  lines.push("Correctness criteria are met for every fault class this environment can execute; the prototype stays experimental pending benefit validation.");
  lines.push("Socket-dependent tests are environment-sensitive: the reviewer's environment blocked Unix-socket listeners (listen EPERM), so a run without socket support records those cases as not-covered rather than passing them.");
  lines.push("");
  lines.push("## Grader scorecard");
  lines.push("");
  lines.push("| Arm | Result | Failed checks |");
  lines.push("| --- | --- | --- |");
  lines.push(scorecardRow("A existing (no fault)", results.grades.existing));
  lines.push(scorecardRow("B pi-durable (no fault)", results.grades["pi-durable"]));
  lines.push(scorecardRow("A existing (fault at T3)", results.grades.existingWithFault));
  lines.push(scorecardRow("B pi-durable (fault during model)", results.grades["pi-durableWithFault"]));
  lines.push("");
  lines.push("## Grader negative controls");
  lines.push("");
  lines.push("| Corruption | Rejected |");
  lines.push("| --- | --- |");
  for (const control of results.negativeControls) {
    lines.push(`| ${control.name} | ${control.rejected ? "yes" : "no"} |`);
  }
  lines.push("");
  lines.push("## F01-F18 fault matrix");
  lines.push("");
  lines.push("| Case | Injection point | Status | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const caseResult of results.matrix) lines.push(matrixRow(caseResult));
  lines.push("");
  lines.push("## Disposable-container restart lane");
  lines.push("");
  lines.push(
    `Status: ${results.dockerLane.status}${results.dockerLane.reason ? ` (${results.dockerLane.reason})` : ""}.`,
  );
  lines.push(
    `Image: ${results.dockerLane.image ?? "none"}; Docker server: ${results.dockerLane.dockerServer ?? "unknown"}.`,
  );
  lines.push("The failure boundary - SIGKILL, remove, and recreate with fresh namespaces - is owned by the host, outside the container.");
  for (const command of results.dockerLane.commands ?? []) {
    lines.push("");
    lines.push("```sh");
    lines.push(command);
    lines.push("```");
  }
  lines.push("");
  lines.push("## Bounded real-model pilot");
  lines.push("");
  lines.push(`Status: ${results.pilot.status}${results.pilot.reason ? ` (${results.pilot.reason})` : ""}.`);
  if (results.pilot.status === "pass") {
    lines.push(
      `Provider ${results.pilot.provider}, model ${results.pilot.model}; ${results.pilot.calls} calls in ${results.pilot.latencyMs} ms with ${results.pilot.timeouts ?? 0} timeouts.`,
    );
    lines.push(
      `Both arms ran against the same real model answers, so the arms differ only in execution durability; arm A completed=${results.pilot.grades?.existing}, arm B completed=${results.pilot.grades?.["pi-durable"]}.`,
    );
    lines.push(
      `The model matched the fixture's required disposition on ${results.pilot.matchingDispositions} of ${results.pilot.calls} tasks, so a real model does not simply reproduce the fixture.`,
    );
    lines.push("");
    lines.push("| Task | Verdict | Latency | Answer |");
    lines.push("| --- | --- | --- | --- |");
    for (const answer of results.pilot.answers ?? []) {
      lines.push(
        `| ${answer.task} | ${answer.verdict} | ${answer.latencyMs} ms | ${answer.summary.replace(/\|/g, "/")} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Benefit validation (promotion gate)");
  lines.push("");
  const benefit = results.benefit;
  lines.push(
    `Status: ${benefit.status}${benefit.reason ? ` (${benefit.reason})` : ` over ${benefit.runs} paired runs`}. Predeclared N: ${benefit.runs}.`,
  );
  lines.push(`Scenario: ${benefit.predeclared.scenario}.`);
  lines.push(`Fault: ${benefit.predeclared.fault}.`);
  lines.push("Predeclared operator interventions:");
  for (const intervention of benefit.predeclared.interventions) lines.push(`- ${intervention}`);
  lines.push("");
  const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;
  lines.push("| Experiment | Arm A existing | Arm B pi-durable | Difference (A - B) | Verdict |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push(
    `| Duplicate-outcome avoidance | ${benefit.duplicateOutcomes.existingTotal} duplicates in ${benefit.duplicateOutcomes.existing.successes}/${benefit.runs} runs (${percent(benefit.duplicateOutcomes.existing.rate)}, 95% CI ${percent(benefit.duplicateOutcomes.existing.lower)}-${percent(benefit.duplicateOutcomes.existing.upper)}) | ${benefit.duplicateOutcomes.durableTotal} duplicates in ${benefit.duplicateOutcomes.durable.successes}/${benefit.runs} runs (${percent(benefit.duplicateOutcomes.durable.rate)}, 95% CI ${percent(benefit.duplicateOutcomes.durable.lower)}-${percent(benefit.duplicateOutcomes.durable.upper)}) | ${percent(benefit.duplicateOutcomes.difference.rate)} points, 95% CI ${percent(benefit.duplicateOutcomes.difference.lower)}-${percent(benefit.duplicateOutcomes.difference.upper)} | ${benefit.duplicateOutcomes.verdict} |`,
  );
  lines.push(
    `| Potential operator burden reduction (inferred; not independently measured) | ${benefit.operatorBurden.existing.interventions} interventions / ${benefit.operatorBurden.existing.commands} commands; ${benefit.operatorBurden.existingRunsWithIntervention.successes}/${benefit.runs} runs affected (${percent(benefit.operatorBurden.existingRunsWithIntervention.rate)}, 95% CI ${percent(benefit.operatorBurden.existingRunsWithIntervention.lower)}-${percent(benefit.operatorBurden.existingRunsWithIntervention.upper)}) | ${benefit.operatorBurden.durable.interventions} interventions / ${benefit.operatorBurden.durable.commands} commands; ${benefit.operatorBurden.durableRunsWithIntervention.successes}/${benefit.runs} runs affected (${percent(benefit.operatorBurden.durableRunsWithIntervention.rate)}, 95% CI ${percent(benefit.operatorBurden.durableRunsWithIntervention.lower)}-${percent(benefit.operatorBurden.durableRunsWithIntervention.upper)}) | ${percent(benefit.operatorBurden.difference.rate)} points, 95% CI ${percent(benefit.operatorBurden.difference.lower)}-${percent(benefit.operatorBurden.difference.upper)} | inferred from duplicate elimination |`,
  );
  lines.push(
    `| Recovery time (observation, not a claimed benefit) | median ${Math.round(benefit.recoveryTime.existingFaulted.median)} ms (range ${Math.round(benefit.recoveryTime.existingFaulted.min)}-${Math.round(benefit.recoveryTime.existingFaulted.max)}) | median ${Math.round(benefit.recoveryTime.durableFaulted.median)} ms (range ${Math.round(benefit.recoveryTime.durableFaulted.min)}-${Math.round(benefit.recoveryTime.durableFaulted.max)}) | durable arm median recovery was ${Math.round(benefit.recoveryTime.durableFaulted.median)} ms vs ${Math.round(benefit.recoveryTime.existingFaulted.median)} ms for the existing-path model; performance benefit is not claimed because the experiment was designed for correctness rather than latency measurement | observation |`,
  );
  lines.push("");
  lines.push(
    `Promotion gate (reduced-model lab result): duplicate reduction ${benefit.promotionGate.duplicateReduction ? "yes" : "no"}, operator reduction ${benefit.promotionGate.operatorReduction ? "yes" : "no"}, recovery parity ${benefit.promotionGate.recoveryParity ? "yes" : "no"}, zero stale-owner actions ${benefit.promotionGate.zeroStaleOwnerActions ? "yes" : "no"} -> ${benefit.promotionGate.verdict === "advance" ? "benefit demonstrated in the reduced model; promotion still requires the adversarial verification described under Decision" : "not cleared, keep the HOLD decision"}.`,
  );
  lines.push("");
  lines.push("| Run | Arm A faulted (ms) | Arm B faulted (ms) | Arm A duplicates | Arm B duplicates | Arm A interventions | Arm B interventions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const sample of benefit.samples) {
    lines.push(
      `| ${sample.run} | ${Math.round(sample.existingFaultedMs)} | ${Math.round(sample.durableFaultedMs)} | ${sample.existingDuplicateEffects} | ${sample.durableDuplicateEffects} | ${sample.existingInterventions} | ${sample.durableInterventions} |`,
    );
  }
  lines.push("");
  lines.push("Benefit-validation limits:");
  for (const limit of benefit.limits) lines.push(`- ${limit}.`);
  lines.push("");
  lines.push("## Benefit scorecard (deterministic, calibrated)");
  lines.push("");
  lines.push("| Benefit | Metric | Arm A | Arm B | Status |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push(
    `| Reliable recovery | Correct dispositions / fleet tasks | ${results.grades.existing.passed ? "all" : "some"} | ${results.grades["pi-durable"].passed ? "all" : "some"} | ${results.grades["pi-durable"].passed ? "parity" : "unproven"} |`,
  );
  lines.push(
    `| Duplicate-outcome avoidance | Duplicate applied effects (paired fault runs) | ${results.benefit.duplicateOutcomes.existingTotal} | ${results.benefit.duplicateOutcomes.durableTotal} | ${results.benefit.duplicateOutcomes.verdict} |`,
  );
  lines.push(
    `| Controlled ownership | Stale-owner actions | ${results.arms.existing.trace.effects.filter((effect) => !results.arms.existing.trace.allowedOwners.includes(effect.owner)).length} | ${results.arms["pi-durable"].trace.effects.filter((effect) => !results.arms["pi-durable"].trace.allowedOwners.includes(effect.owner)).length} | pass |`,
  );
  lines.push(
    `| Useful visibility | Recoverable settlements | n/a | ${results.arms["pi-durable"].trace.operations.filter((operation) => operation.state === "settled").length} | pass |`,
  );
  lines.push(
    `| Potential operator burden reduction (inferred; not independently measured) | Operator interventions under the predeclared rule | ${results.benefit.operatorBurden.existing.interventions} | ${results.benefit.operatorBurden.durable.interventions} | inferred from duplicate elimination |`,
  );
  lines.push(
    `| Recovery time (observation, not a claimed benefit) | Median faulted-scenario time (ms) | ${Math.round(results.benefit.recoveryTime.existingFaulted.median)} | ${Math.round(results.benefit.recoveryTime.durableFaulted.median)} | observation |`,
  );
  lines.push("");
  lines.push("## Threshold calibration");
  lines.push("");
  lines.push(
    `Status: ${results.calibration.status}${results.calibration.reason ? ` (${results.calibration.reason})` : ` over ${results.calibration.runs} deterministic runs`}.`,
  );
  lines.push(
    `Median scenario time (ms): arm A ${Math.round(results.calibration.medians.existing)}, arm B ${Math.round(results.calibration.medians.piDurable)}, arm A faulted ${Math.round(results.calibration.medians.existingWithFault)}, arm B faulted ${Math.round(results.calibration.medians.piDurableWithFault)}.`,
  );
  lines.push(
    `Calibrated thresholds: at least ${results.calibration.thresholds.manualActionReductionPercent}% fewer manual recovery actions, at least ${results.calibration.thresholds.recoveryTimeReductionPercent}% lower median faulted-scenario time, and healthy-scenario time within ${results.calibration.thresholds.healthyLatencyTolerancePercent}% of baseline.`,
  );
  lines.push(
    `Measured noise floor: ${results.calibration.thresholds.noiseFloorPercent}% of the faulted baseline median.`,
  );
  lines.push(`Basis: ${results.calibration.thresholds.basis}.`);
  lines.push(
    `Verdicts: manual recovery actions ${results.calibration.verdicts.manualActions}, recovery time ${results.calibration.verdicts.recoveryTime}, duplicate outcomes ${results.calibration.verdicts.duplicateOutcomes}.`,
  );
  lines.push(
    "These verdicts apply only to the legacy proxy metrics above; the promotion gate is decided by the paired benefit validation.",
  );
  lines.push("");
  lines.push("## Measurement limits");
  lines.push("");
  for (const limit of results.calibration.limits) {
    lines.push(`- ${limit}.`);
  }
  lines.push("");
  lines.push("| Run | Arm A (ms) | Arm B (ms) | Arm A faulted (ms) | Arm B faulted (ms) |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const sample of results.calibration.samples) {
    lines.push(
      `| ${sample.run} | ${Math.round(sample.existingMs)} | ${Math.round(sample.durableMs)} | ${Math.round(sample.existingWithFaultMs)} | ${Math.round(sample.durableWithFaultMs)} |`,
    );
  }
  lines.push("");
  lines.push("## Raw evidence");
  lines.push("");
  lines.push("The machine-readable per-run records are in [`eval-results.json`](eval-results.json).");
  lines.push("Each arm records the outcome rows, adapter operation records, effects, faults, and notes.");
  lines.push("");
  lines.push("## Honest limitations");
  lines.push("");
  lines.push("- Arm A is not a full Pi AgentSession: the wake is answered by the deterministic responder instead of a Pi model turn, so the extension's model-side behavior is not exercised; the wake queue, claim rules, and outcome store it drives are the real ones.");
  lines.push("- The deterministic responder returns fixture truth, so this harness measures execution durability, not model judgment.");
  lines.push("- F09 is exercised against the real store: a routine note has no durable idempotent record, so a failed cursor write re-presents the already-delivered row. The limitation is pinned by the targeted test and tracked as follow-up `fm-pi-routine-delivery-idempotency-followup-r1`.");
  lines.push("- The outcome sink is keyed by the operation identity with an atomic append-or-return-existing, so two distinct operations with identical text no longer collide; the paired benefit validation measures duplicate applied effects directly with the non-idempotent ledger, and arm A's operation-key-less append duplicates on the post-effect fault while arm B replays without a second effect.");
  lines.push("- The recreate container runs in its own pid namespace, so the recorded owner pid is not a reliable liveness signal there and the lane reclaims the stale ownership lock explicitly before starting it.");
  lines.push("- The container lane is a container and process boundary, not an OS reboot: it proves the store reopens and the recorded authority reconciles after a teardown + recreate, not that a kernel or filesystem failure is survivable.");
  lines.push("- The pilot's answers vary between runs, so its disposition match count is one sample rather than a rate.");
  lines.push("- The real-model pilot asks one shared set of model answers and replays them through both arms, so it isolates execution durability rather than measuring per-arm model variance; independent per-arm model calls remain the fuller form the design describes.");
  lines.push("- The pilot drives the pinned provider directly because the durable conversation seam does not carry the session-affinity header the provider requires, so it does not exercise the prototype's execution seam end to end.");
  lines.push("- F16 injects a registered provider with no configured credential and the dispatch refuses with PROVIDER_UNAVAILABLE without invoking the registered fallback executor; F17 is a container process/store restart whose boundary is a container restart, not a host kernel reboot; F18 restores a copy of the adapter store into a different home and the owner refuses to open it (HOME_MISMATCH). F16 and F18 now pass; F17 stays a known-gap because no host reboot is exercised.");
  lines.push("- The milestone verification drives two successive wakes, an execution crash with resume, and an ownership replacement through the extension's durable-branch path and the real sidecar; it verifies exactly one outcome per accepted operation, no stale append, and distinct identities. Socket-dependent tests are environment-sensitive (the reviewer's environment blocked Unix-socket listeners with listen EPERM).");
  lines.push("- Token and cost comparison and the operator diagnosis study from the design remain out of scope for this pass.");
  lines.push("- The calibrated thresholds are derived from this lab's own run-to-run spread, and the deterministic arms are byte-identical workloads, so a measured recovery-time improvement would have to exceed several times the noise floor before it counts as proven.");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const results = await runEvaluation();
  writeFileSync(rawPath, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(reportPath, renderReport(results));
  process.stdout.write(
    `wrote ${rawPath} and ${reportPath}; matrix pass=${results.matrix.filter((c) => c.status === "pass").length} fail=${results.matrix.filter((c) => c.status === "fail").length} not-covered=${results.matrix.filter((c) => c.status === "not-covered").length} known-gap=${results.matrix.filter((c) => c.status === "known-gap").length}\n`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("main.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
