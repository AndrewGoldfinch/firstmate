/**
 * Benefit-validation experiments for the P2 prototype.
 *
 * The correctness harness answers "does it work". These experiments answer the
 * promotion question: does durable supervision reduce duplicate outcomes or
 * operator intervention under faulted workloads better than the existing path,
 * while keeping recovery parity and zero stale-owner actions.
 *
 * One paired loop collects all three measurements from the same runs:
 *
 * 1. Duplicate-outcome avoidance. The fault lands after the effect is applied
 *    and before it is acknowledged. Arm A appends its outcome with no operation
 *    key, so the restarted owner re-appends it; arm B retries the same
 *    operation identity and the durable sink returns the existing row. Every
 *    applied effect is recorded in a non-idempotent ledger, so a duplicate is
 *    visible even when the arm reports success.
 * 2. Operator burden. The predeclared interventions are the human actions the
 *    arm's own automatic recovery still leaves behind: reconcile a duplicate
 *    applied effect, resubmit a task left without an outcome, and restart the
 *    owner. Automatic restart is not counted as an operator action.
 * 3. Recovery time. Faulted and healthy scenario wall-clock times at the
 *    predeclared run count, reported as medians with paired differences and the
 *    lab's own measured noise floor.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FLEET } from "./fleet.ts";
import { grade } from "./grader.ts";
import { runDurableScenario, runExistingScenario, type ArmResult } from "./runner.ts";

const DEFAULT_RUNS = 30;
const RECOVERY_TIME_THRESHOLD_PERCENT = 30;
const HEALTHY_TOLERANCE_PERCENT = 15;
const FAULT_TASK = "T3";

export type BenefitRun = {
  run: number;
  existingDuplicateEffects: number;
  durableDuplicateEffects: number;
  existingDuplicateOutcomeTasks: number;
  durableDuplicateOutcomeTasks: number;
  existingInterventions: number;
  durableInterventions: number;
  existingCommands: number;
  durableCommands: number;
  existingHealthyMs: number;
  durableHealthyMs: number;
  existingFaultedMs: number;
  durableFaultedMs: number;
  existingRecovered: boolean;
  durableRecovered: boolean;
  existingStaleActions: number;
  durableStaleActions: number;
};

export type Interval = { successes: number; total: number; rate: number; lower: number; upper: number };

export type BenefitResult = {
  status: "pass" | "not-covered";
  reason?: string;
  runs: number;
  predeclared: {
    scenario: string;
    fault: string;
    interventions: string[];
    recoveryTimeThresholdPercent: number;
    healthyTolerancePercent: number;
  };
  duplicateOutcomes: {
    existing: Interval;
    durable: Interval;
    existingTotal: number;
    durableTotal: number;
    difference: { rate: number; lower: number; upper: number };
    verdict: "improved" | "parity" | "unproven";
  };
  operatorBurden: {
    existing: { interventions: number; commands: number; medianPerRun: number };
    durable: { interventions: number; commands: number; medianPerRun: number };
    existingRunsWithIntervention: Interval;
    durableRunsWithIntervention: Interval;
    difference: { rate: number; lower: number; upper: number };
    verdict: "improved" | "parity" | "unproven";
  };
  recoveryTime: {
    existingFaulted: { median: number; min: number; max: number };
    durableFaulted: { median: number; min: number; max: number };
    healthyWithinTolerance: boolean;
    noiseFloorPercent: number;
    thresholdPercent: number;
    medianReductionPercent: number;
    verdict: "improved" | "parity" | "unproven";
  };
  staleOwnerActions: { existing: number; durable: number };
  promotionGate: {
    duplicateReduction: boolean;
    operatorReduction: boolean;
    recoveryParity: boolean;
    zeroStaleOwnerActions: boolean;
    verdict: "advance" | "hold";
  };
  samples: BenefitRun[];
  limits: string[];
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function noiseFraction(values: readonly number[]): number {
  const centre = median(values);
  if (centre === 0) return 0;
  return median(values.map((value) => Math.abs(value - centre))) / centre;
}

/** Wilson score interval for a binomial proportion. */
function wilson(successes: number, total: number): Interval {
  if (total === 0) return { successes, total, rate: 0, lower: 0, upper: 0 };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { successes, total, rate: p, lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin) };
}

/** Newcombe interval for the difference of two independent proportions. */
function difference(a: Interval, b: Interval): { rate: number; lower: number; upper: number } {
  const rate = a.rate - b.rate;
  const lower = rate - Math.sqrt((a.rate - a.lower) ** 2 + (b.upper - b.rate) ** 2);
  const upper = rate + Math.sqrt((a.upper - a.rate) ** 2 + (b.rate - b.lower) ** 2);
  return { rate, lower, upper };
}

/** Applied effect occurrences beyond the first for the same logical operation. */
function duplicateEffectCount(result: ArmResult): number {
  const seen = new Map<string, number>();
  for (const effect of result.trace.effects) {
    const key = `${effect.operationId}:${effect.effect}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let extra = 0;
  for (const count of seen.values()) extra += Math.max(0, count - 1);
  return extra;
}

function duplicateOutcomeTasks(result: ArmResult): number {
  return FLEET.filter(
    (task) => result.trace.outcomes.filter((outcome) => outcome.task === task.id).length > 1,
  ).length;
}

/** Tasks accepted for the run that still have no outcome after recovery. */
function lostOutcomeTasks(result: ArmResult): number {
  return FLEET.filter((task) => result.trace.outcomes.every((outcome) => outcome.task !== task.id)).length;
}

function interventions(result: ArmResult): { reconcile: number; resubmit: number; restart: number } {
  return {
    reconcile: duplicateEffectCount(result),
    resubmit: lostOutcomeTasks(result),
    restart: 0,
  };
}

function interventionCount(result: ArmResult): number {
  const counts = interventions(result);
  return counts.reconcile + counts.resubmit + counts.restart;
}

function staleOwnerActions(result: ArmResult): number {
  const staleEffects = result.trace.effects.filter(
    (effect) => !result.trace.allowedOwners.includes(effect.owner),
  ).length;
  const staleAcks = result.trace.acknowledgements.filter(
    (ack) => !result.trace.allowedOwners.includes(ack.owner),
  ).length;
  return staleEffects + staleAcks;
}

function check(result: ArmResult, name: string): boolean {
  return grade(FLEET, result.trace).checks.find((candidate) => candidate.name === name)?.ok === true;
}

/** Recovery parity: every accepted task reaches the required disposition. */
function recovered(result: ArmResult): boolean {
  return (
    check(result, "every accepted task has an outcome") &&
    check(result, "each disposition matches fixture truth") &&
    check(result, "no lost accepted row")
  );
}

function stats(values: readonly number[]): { median: number; min: number; max: number } {
  return {
    median: median(values),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  };
}

export async function runBenefit(
  workDir: string,
  outcomeScript: string,
  runs = Number.parseInt(process.env.FM_PI_DURABLE_BENEFIT_RUNS ?? "", 10) || DEFAULT_RUNS,
): Promise<BenefitResult> {
  const predeclared = {
    scenario: `six-task fleet, fault after the effect on ${FAULT_TASK} and before acknowledgement`,
    fault: `existing: crash after outcome append on ${FAULT_TASK}; pi-durable: crash after settlement on ${FAULT_TASK}`,
    interventions: [
      "restart-owner: restart the supervision owner (automatic in both arms, counted as zero operator actions)",
      "reconcile-effect: reconcile one duplicate applied effect the append-only store cannot remove",
      "resubmit-work: re-queue one accepted task left without an outcome",
    ],
    recoveryTimeThresholdPercent: RECOVERY_TIME_THRESHOLD_PERCENT,
    healthyTolerancePercent: HEALTHY_TOLERANCE_PERCENT,
  };

  if (runs <= 0) {
    return {
      status: "not-covered",
      reason: "benefit validation was skipped for this run",
      runs: 0,
      predeclared,
      duplicateOutcomes: {
        existing: wilson(0, 0),
        durable: wilson(0, 0),
        existingTotal: 0,
        durableTotal: 0,
        difference: { rate: 0, lower: 0, upper: 0 },
        verdict: "unproven",
      },
      operatorBurden: {
        existing: { interventions: 0, commands: 0, medianPerRun: 0 },
        durable: { interventions: 0, commands: 0, medianPerRun: 0 },
        existingRunsWithIntervention: wilson(0, 0),
        durableRunsWithIntervention: wilson(0, 0),
        difference: { rate: 0, lower: 0, upper: 0 },
        verdict: "unproven",
      },
      recoveryTime: {
        existingFaulted: { median: 0, min: 0, max: 0 },
        durableFaulted: { median: 0, min: 0, max: 0 },
        healthyWithinTolerance: true,
        noiseFloorPercent: 0,
        thresholdPercent: RECOVERY_TIME_THRESHOLD_PERCENT,
        medianReductionPercent: 0,
        verdict: "unproven",
      },
      staleOwnerActions: { existing: 0, durable: 0 },
      promotionGate: {
        duplicateReduction: false,
        operatorReduction: false,
        recoveryParity: false,
        zeroStaleOwnerActions: true,
        verdict: "hold",
      },
      samples: [],
      limits: [
        "benefit validation was skipped, so no evidence was collected for either arm",
      ],
    };
  }

  const samples: BenefitRun[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const home = (name: string) => {
      const path = join(workDir, `benefit-${run}`, name);
      mkdirSync(join(path, "state"), { recursive: true });
      return path;
    };

    const startedExistingHealthy = performance.now();
    const existingHealthy = await runExistingScenario({
      home: home("existing-healthy"),
      scenario: "fleet",
      tasks: FLEET,
      outcomeScript,
    });
    const existingHealthyMs = performance.now() - startedExistingHealthy;

    const startedDurableHealthy = performance.now();
    const durableHealthy = await runDurableScenario({
      home: home("durable-healthy"),
      scenario: "fleet",
      tasks: FLEET,
      outcomeScript,
    });
    const durableHealthyMs = performance.now() - startedDurableHealthy;

    const startedExistingFault = performance.now();
    const existingFaulted = await runExistingScenario({
      home: home("existing-faulted"),
      scenario: `fleet-fault-after-effect-${FAULT_TASK}`,
      tasks: FLEET,
      outcomeScript,
      crashAfterEffectTask: FAULT_TASK,
    });
    const existingFaultedMs = performance.now() - startedExistingFault;

    const startedDurableFault = performance.now();
    const durableFaulted = await runDurableScenario({
      home: home("durable-faulted"),
      scenario: `fleet-fault-after-settle-${FAULT_TASK}`,
      tasks: FLEET,
      outcomeScript,
      crashAfterSettleTask: FAULT_TASK,
    });
    const durableFaultedMs = performance.now() - startedDurableFault;

    samples.push({
      run,
      existingDuplicateEffects: duplicateEffectCount(existingFaulted),
      durableDuplicateEffects: duplicateEffectCount(durableFaulted),
      existingDuplicateOutcomeTasks: duplicateOutcomeTasks(existingFaulted),
      durableDuplicateOutcomeTasks: duplicateOutcomeTasks(durableFaulted),
      existingInterventions: interventionCount(existingFaulted),
      durableInterventions: interventionCount(durableFaulted),
      existingCommands: interventionCount(existingFaulted),
      durableCommands: interventionCount(durableFaulted),
      existingHealthyMs,
      durableHealthyMs,
      existingFaultedMs,
      durableFaultedMs,
      existingRecovered: recovered(existingFaulted),
      durableRecovered: recovered(durableFaulted),
      existingStaleActions: staleOwnerActions(existingFaulted),
      durableStaleActions: staleOwnerActions(durableFaulted),
    });
  }

  const existingDuplicateRuns = samples.filter((sample) => sample.existingDuplicateEffects > 0).length;
  const durableDuplicateRuns = samples.filter((sample) => sample.durableDuplicateEffects > 0).length;
  const existingDuplicates = wilson(existingDuplicateRuns, samples.length);
  const durableDuplicates = wilson(durableDuplicateRuns, samples.length);
  const duplicateDifference = difference(existingDuplicates, durableDuplicates);

  const existingInterventionRuns = samples.filter((sample) => sample.existingInterventions > 0).length;
  const durableInterventionRuns = samples.filter((sample) => sample.durableInterventions > 0).length;
  const existingInterventions = wilson(existingInterventionRuns, samples.length);
  const durableInterventions = wilson(durableInterventionRuns, samples.length);
  const interventionDifference = difference(existingInterventions, durableInterventions);

  const existingFaultedMs = samples.map((sample) => sample.existingFaultedMs);
  const durableFaultedMs = samples.map((sample) => sample.durableFaultedMs);
  const healthyMs = samples.flatMap((sample) => [sample.existingHealthyMs, sample.durableHealthyMs]);
  const noiseFloorPercent = Math.ceil(noiseFraction(existingFaultedMs) * 100);
  const thresholdPercent = Math.max(RECOVERY_TIME_THRESHOLD_PERCENT, noiseFloorPercent * 3);
  const existingFaultedMedian = median(existingFaultedMs);
  const durableFaultedMedian = median(durableFaultedMs);
  const medianReductionPercent =
    existingFaultedMedian === 0
      ? 0
      : ((existingFaultedMedian - durableFaultedMedian) / existingFaultedMedian) * 100;

  const healthySpread =
    median(healthyMs) === 0
      ? 0
      : (Math.max(...healthyMs) - Math.min(...healthyMs)) / median(healthyMs);
  const healthyWithinTolerance = healthySpread * 100 <= HEALTHY_TOLERANCE_PERCENT;

  const staleOwnerCount =
    samples.reduce((total, sample) => total + sample.existingStaleActions + sample.durableStaleActions, 0);
  const recoveryParity = samples.every((sample) => sample.existingRecovered && sample.durableRecovered);

  const duplicateReduction = existingDuplicateRuns > 0 && duplicateDifference.lower > 0;
  const operatorReduction = existingInterventionRuns > 0 && interventionDifference.lower > 0;
  const zeroStaleOwnerActions = staleOwnerCount === 0;
  const promotion = (duplicateReduction || operatorReduction) && recoveryParity && zeroStaleOwnerActions;

  return {
    status: "pass",
    runs,
    predeclared,
    duplicateOutcomes: {
      existing: existingDuplicates,
      durable: durableDuplicates,
      existingTotal: samples.reduce((total, sample) => total + sample.existingDuplicateEffects, 0),
      durableTotal: samples.reduce((total, sample) => total + sample.durableDuplicateEffects, 0),
      difference: duplicateDifference,
      verdict:
        duplicateReduction ? "improved" : existingDuplicateRuns === 0 && durableDuplicateRuns === 0 ? "parity" : "unproven",
    },
    operatorBurden: {
      existing: {
        interventions: samples.reduce((total, sample) => total + sample.existingInterventions, 0),
        commands: samples.reduce((total, sample) => total + sample.existingCommands, 0),
        medianPerRun: median(samples.map((sample) => sample.existingInterventions)),
      },
      durable: {
        interventions: samples.reduce((total, sample) => total + sample.durableInterventions, 0),
        commands: samples.reduce((total, sample) => total + sample.durableCommands, 0),
        medianPerRun: median(samples.map((sample) => sample.durableInterventions)),
      },
      existingRunsWithIntervention: existingInterventions,
      durableRunsWithIntervention: durableInterventions,
      difference: interventionDifference,
      verdict:
        operatorReduction
          ? "improved"
          : existingInterventionRuns === 0 && durableInterventionRuns === 0
            ? "parity"
            : "unproven",
    },
    recoveryTime: {
      existingFaulted: stats(existingFaultedMs),
      durableFaulted: stats(durableFaultedMs),
      healthyWithinTolerance,
      noiseFloorPercent,
      thresholdPercent,
      medianReductionPercent,
      verdict: medianReductionPercent >= thresholdPercent ? "improved" : "unproven",
    },
    staleOwnerActions: {
      existing: samples.reduce((total, sample) => total + sample.existingStaleActions, 0),
      durable: samples.reduce((total, sample) => total + sample.durableStaleActions, 0),
    },
    promotionGate: {
      duplicateReduction,
      operatorReduction,
      recoveryParity,
      zeroStaleOwnerActions,
      verdict: promotion ? "advance" : "hold",
    },
    samples,
    limits: [
      "arm A is a reduced model of the existing path: the real wake queue, claim rules, and append-only outcome store, but the deterministic responder instead of a Pi model turn",
      "operator interventions are the predeclared reconcile and resubmit actions the arm's post-recovery trace requires; they are not independently executed human commands, and automatic owner restart is not counted",
      "the fault lands at one effect boundary on one task per run; other fault points and interleavings are covered by the correctness matrix, not this benefit sample",
      "the recovery-time threshold is derived from this lab's own run-to-run spread, so it is a local noise floor, not a production service-level objective",
    ],
  };
}
