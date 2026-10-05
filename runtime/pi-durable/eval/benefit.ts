/**
 * Benefit-validation experiments for the P2 prototype.
 *
 * The correctness harness answers "does it work". These experiments answer the
 * promotion question: does durable execution avoid duplicate externally visible
 * note deliveries under a faulted workload better than the existing path, while
 * keeping recovery parity, refusing a superseded owner, and preserving the
 * causal role of operation-key deduplication.
 *
 * One paired loop collects all measurements from the same runs:
 *
 * 1. Duplicate-delivery avoidance. The fault lands after a routine note is
 *    delivered and before its acknowledgement. On the existing path the row
 *    stays unread, so the next reconciliation delivers the same logical note a
 *    second time; the operation-keyed durable sink rejects the repeated
 *    settlement, so it delivers the note once. Every delivery is recorded at
 *    the delivery boundary in a non-idempotent ledger, never from a replay flag.
 * 2. Stale-owner refusal. After a genuine owner replacement the superseded
 *    owner attempts the append it could otherwise re-apply, so the
 *    zero-stale-owner clause is non-vacuous rather than hardcoded to pass.
 * 3. Causal control. The same logical note appended twice through the real
 *    store keeps one row with an operation key and two rows without one, so the
 *    failure is recreated when deduplication is disabled.
 * 4. Recovery time. Faulted and healthy scenario wall-clock times at the
 *    predeclared run count, reported as medians with the lab's own measured
 *    noise floor and never part of the gate.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FLEET } from "./fleet.ts";
import { grade } from "./grader.ts";
import { runDedupCausalControl, runDurableScenario, runExistingScenario, type ArmResult } from "./runner.ts";

const DEFAULT_RUNS = 30;
const RECOVERY_TIME_THRESHOLD_PERCENT = 30;
const HEALTHY_TOLERANCE_PERCENT = 15;
const FAULT_TASK = "T3";

export type BenefitRun = {
  run: number;
  existingDeliveries: number;
  durableDeliveries: number;
  existingDuplicateDeliveries: number;
  durableDuplicateDeliveries: number;
  existingHealthyMs: number;
  durableHealthyMs: number;
  existingFaultedMs: number;
  durableFaultedMs: number;
  existingRecovered: boolean;
  durableRecovered: boolean;
  existingStaleAttempts: number;
  durableStaleAttempts: number;
  existingStaleAccepted: number;
  durableStaleAccepted: number;
};

export type Interval = { successes: number; total: number; rate: number; lower: number; upper: number };

export type BenefitResult = {
  status: "pass" | "not-covered";
  reason?: string;
  runs: number;
  predeclared: {
    scenario: string;
    fault: string;
    recoveryTimeThresholdPercent: number;
    healthyTolerancePercent: number;
  };
  duplicateDeliveries: {
    existing: Interval;
    durable: Interval;
    existingTotal: number;
    durableTotal: number;
    difference: { rate: number; lower: number; upper: number };
    verdict: "improved" | "parity" | "unproven";
  };
  staleOwner: { attempts: number; accepted: number; nonVacuous: boolean; verdict: "pass" | "fail" };
  causalControl: { withOperationKey: number; withoutOperationKey: number; recreated: boolean };
  recoveryTime: {
    existingFaulted: { median: number; min: number; max: number };
    durableFaulted: { median: number; min: number; max: number };
    healthyWithinTolerance: boolean;
    noiseFloorPercent: number;
    thresholdPercent: number;
    medianReductionPercent: number;
    verdict: "improved" | "parity" | "unproven";
  };
  promotionGate: {
    duplicateReduction: boolean;
    durablePrevented: boolean;
    staleOwnerVerified: boolean;
    recoveryParity: boolean;
    causalControlRecreated: boolean;
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

/** Deliveries beyond the first for the same logical note. */
function duplicateDeliveryCount(result: ArmResult): number {
  const seen = new Map<string, number>();
  for (const delivery of result.trace.deliveries) {
    seen.set(delivery.note, (seen.get(delivery.note) ?? 0) + 1);
  }
  let extra = 0;
  for (const count of seen.values()) extra += Math.max(0, count - 1);
  return extra;
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
    scenario: `six-task fleet, fault after the routine note on ${FAULT_TASK} is delivered and before its acknowledgement`,
    fault: `existing: crash after the routine note on ${FAULT_TASK} is delivered, before its cursor write; pi-durable: owner lost after settlement on ${FAULT_TASK}`,
    recoveryTimeThresholdPercent: RECOVERY_TIME_THRESHOLD_PERCENT,
    healthyTolerancePercent: HEALTHY_TOLERANCE_PERCENT,
  };
  const home = (name: string): string => {
    const path = join(workDir, name);
    mkdirSync(join(path, "state"), { recursive: true });
    return path;
  };

  // The causal control runs once against the real store, independently of both
  // arms: the dedup-disabled append must recreate the duplicate.
  const causalControl = runDedupCausalControl(outcomeScript, workDir);
  const causalRecreated = causalControl.withOperationKey === 1 && causalControl.withoutOperationKey > 1;

  const samples: BenefitRun[] = [];
  for (let run = 0; run < runs; run += 1) {
    const startedExistingHealthy = performance.now();
    const existingHealthy = await runExistingScenario({
      home: home(`run-${run}-existing-healthy`),
      scenario: "fleet",
      tasks: FLEET,
      outcomeScript,
    });
    const existingHealthyMs = performance.now() - startedExistingHealthy;

    const startedDurableHealthy = performance.now();
    const durableHealthy = await runDurableScenario({
      home: home(`run-${run}-durable-healthy`),
      scenario: "fleet",
      tasks: FLEET,
      outcomeScript,
    });
    const durableHealthyMs = performance.now() - startedDurableHealthy;

    const startedExistingFault = performance.now();
    const existingFaulted = await runExistingScenario({
      home: home(`run-${run}-existing-faulted`),
      scenario: `fleet-deliver-before-ack-${FAULT_TASK}`,
      tasks: FLEET,
      outcomeScript,
      deliverBeforeAckTask: FAULT_TASK,
    });
    const existingFaultedMs = performance.now() - startedExistingFault;

    const startedDurableFault = performance.now();
    const durableFaulted = await runDurableScenario({
      home: home(`run-${run}-durable-faulted`),
      scenario: `fleet-crash-after-settle-${FAULT_TASK}`,
      tasks: FLEET,
      outcomeScript,
      crashAfterSettleTask: FAULT_TASK,
      staleOwnerAfterSettleTask: FAULT_TASK,
    });
    const durableFaultedMs = performance.now() - startedDurableFault;

    samples.push({
      run,
      existingDeliveries: existingFaulted.trace.deliveries.length,
      durableDeliveries: durableFaulted.trace.deliveries.length,
      existingDuplicateDeliveries: duplicateDeliveryCount(existingFaulted),
      durableDuplicateDeliveries: duplicateDeliveryCount(durableFaulted),
      existingHealthyMs,
      durableHealthyMs,
      existingFaultedMs,
      durableFaultedMs,
      existingRecovered: recovered(existingFaulted),
      durableRecovered: recovered(durableFaulted),
      existingStaleAttempts: existingFaulted.trace.staleOwnerAttempts.length,
      durableStaleAttempts: durableFaulted.trace.staleOwnerAttempts.length,
      existingStaleAccepted: existingFaulted.trace.staleOwnerAttempts.filter((attempt) => attempt.accepted).length,
      durableStaleAccepted: durableFaulted.trace.staleOwnerAttempts.filter((attempt) => attempt.accepted).length,
    });
  }

  const existingDuplicateRuns = samples.filter((sample) => sample.existingDuplicateDeliveries > 0).length;
  const durableDuplicateRuns = samples.filter((sample) => sample.durableDuplicateDeliveries > 0).length;
  const existingDuplicates = wilson(existingDuplicateRuns, samples.length);
  const durableDuplicates = wilson(durableDuplicateRuns, samples.length);
  const duplicateDifference = difference(existingDuplicates, durableDuplicates);

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
    median(healthyMs) === 0 ? 0 : (Math.max(...healthyMs) - Math.min(...healthyMs)) / median(healthyMs);
  const healthyWithinTolerance = healthySpread * 100 <= HEALTHY_TOLERANCE_PERCENT;

  const staleAttempts = samples.reduce(
    (total, sample) => total + sample.existingStaleAttempts + sample.durableStaleAttempts,
    0,
  );
  const staleAccepted = samples.reduce(
    (total, sample) => total + sample.existingStaleAccepted + sample.durableStaleAccepted,
    0,
  );
  const recoveryParity = samples.every((sample) => sample.existingRecovered && sample.durableRecovered);

  const duplicateReduction = existingDuplicateRuns > 0 && duplicateDifference.lower > 0;
  const durablePrevented = durableDuplicateRuns === 0;
  const staleNonVacuous = staleAttempts > 0;
  const staleOwnerVerified = staleNonVacuous && staleAccepted === 0;
  const promotion =
    duplicateReduction && durablePrevented && staleOwnerVerified && recoveryParity && causalRecreated;

  return {
    status: "pass",
    runs,
    predeclared,
    duplicateDeliveries: {
      existing: existingDuplicates,
      durable: durableDuplicates,
      existingTotal: samples.reduce((total, sample) => total + sample.existingDuplicateDeliveries, 0),
      durableTotal: samples.reduce((total, sample) => total + sample.durableDuplicateDeliveries, 0),
      difference: duplicateDifference,
      verdict:
        duplicateReduction ? "improved" : existingDuplicateRuns === 0 && durableDuplicateRuns === 0 ? "parity" : "unproven",
    },
    staleOwner: {
      attempts: staleAttempts,
      accepted: staleAccepted,
      nonVacuous: staleNonVacuous,
      verdict: staleOwnerVerified ? "pass" : "fail",
    },
    causalControl: { ...causalControl, recreated: causalRecreated },
    recoveryTime: {
      existingFaulted: stats(existingFaultedMs),
      durableFaulted: stats(durableFaultedMs),
      healthyWithinTolerance,
      noiseFloorPercent,
      thresholdPercent,
      medianReductionPercent,
      verdict: medianReductionPercent >= thresholdPercent ? "improved" : "unproven",
    },
    promotionGate: {
      duplicateReduction,
      durablePrevented,
      staleOwnerVerified,
      recoveryParity,
      causalControlRecreated: causalRecreated,
      verdict: promotion ? "advance" : "hold",
    },
    samples,
    limits: [
      "arm A is a reduced model of the existing path: the real wake queue, claim rules, and append-only outcome store, plus the branch's unread-row delivery loop, but the deterministic responder instead of a Pi model turn",
      "arm A records a delivery at each presentation from the store's unread rows; arm B records one when the durable sink commits a new outcome row, so both count the externally visible outcome at its own boundary",
      "the fault lands once per run on one task; other fault points and interleavings are covered by the correctness matrix, not this benefit sample",
      "operator burden is deliberately not measured here and is not part of the gate; a real operator-burden study belongs to Phase 1",
      "the recovery-time threshold is derived from this lab's own run-to-run spread, so it is a local noise floor, not a production service-level objective",
    ],
  };
}
