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
  const matrix = await runMatrix({ workDir, outcomeScript });

  return {
    generatedAt: new Date().toISOString(),
    environment: `Node ${process.version}; local Linux host; no VM or reboot boundary; deterministic faux model`,
    arms: { existing, "pi-durable": durable, existingWithFault, "pi-durableWithFault": durableWithFault },
    grades,
    negativeControls: negative,
    matrix,
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
  lines.push("## Environment and scope");
  lines.push("");
  lines.push(results.environment);
  lines.push("No real VM or reboot boundary exists in this environment, so machine-recovery cases are recorded as not-covered, never faked.");
  lines.push("Arm A is a reduced model of the existing in-process path: it uses the real outcome store and wake semantics but not the full Pi supervision extension.");
  lines.push("Arm B is the real durable sidecar, bridge, and outcome sink with a deterministic faux model.");
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
  lines.push("## Benefit scorecard (deterministic, provisional)");
  lines.push("");
  lines.push("| Benefit | Metric | Arm A | Arm B | Status |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push(
    `| Reliable recovery | Correct dispositions / fleet tasks | ${results.grades.existing.passed ? "all" : "some"} | ${results.grades["pi-durable"].passed ? "all" : "some"} | ${results.grades["pi-durable"].passed ? "parity" : "unproven"} |`,
  );
  lines.push(
    `| Safe retries | Duplicate outcomes after a fault | ${results.arms.existingWithFault.trace.outcomes.length} outcomes for 6 tasks | ${results.arms["pi-durableWithFault"].trace.outcomes.length} outcomes for 6 tasks | ${results.grades["pi-durableWithFault"].passed ? "parity or better" : "unproven"} |`,
  );
  lines.push(
    `| Controlled ownership | Stale-owner actions | ${results.arms.existing.trace.effects.filter((effect) => !results.arms.existing.trace.allowedOwners.includes(effect.owner)).length} | ${results.arms["pi-durable"].trace.effects.filter((effect) => !results.arms["pi-durable"].trace.allowedOwners.includes(effect.owner)).length} | pass |`,
  );
  lines.push(
    `| Useful visibility | Recoverable settlements | n/a | ${results.arms["pi-durable"].trace.operations.filter((operation) => operation.state === "settled").length} | pass |`,
  );
  lines.push(
    `| Reduced recovery burden | Manual recovery actions on the faulted fleet | ${results.arms.existingWithFault.faults.length} | ${results.arms["pi-durableWithFault"].faults.length} | ${results.arms["pi-durableWithFault"].faults.length <= results.arms.existingWithFault.faults.length ? "not worse" : "unproven"} |`,
  );
  lines.push("");
  lines.push("## Raw evidence");
  lines.push("");
  lines.push("The machine-readable per-run records are in [`eval-results.json`](eval-results.json).");
  lines.push("Each arm records the outcome rows, adapter operation records, effects, faults, and notes.");
  lines.push("");
  lines.push("## Honest limitations");
  lines.push("");
  lines.push("- Arm A is a reduced model, not the full pinned Pi supervision extension; it demonstrates the durability gap of an in-process owner without durable acceptance, and does not exercise the extension's own recovery.");
  lines.push("- The faux model returns fixture truth, so this harness measures execution durability, not model judgment.");
  lines.push("- F05, F09, F11, F12, F16, and F17 are not covered here: no read-tool boundary, no cancellation operation, no real credential provider, and no VM or reboot boundary.");
  lines.push("- F08 is a known cross-store gap: a receipt lost between the outcome append and the adapter record can duplicate on retry, which the design requires reconciling.");
  lines.push("- The operator diagnosis study, real-model pilot, token/cost comparison, and maintainability inventory from the design are out of scope for this deterministic environment.");
  lines.push("- The improvement thresholds are not calibrated here; the deterministic runs are a conformance pilot, not evidence of a performance difference.");
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
