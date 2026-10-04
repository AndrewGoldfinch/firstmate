/**
 * Threshold calibration for the benefit scorecard.
 *
 * The design's improvement thresholds are provisional until they are measured
 * against real runs. This module repeats the deterministic scenario suite and
 * derives the thresholds from the measured spread, so a claimed improvement can
 * never be smaller than the lab's own run-to-run noise.
 *
 * The measurement is deliberately narrow and named as such: the manual-action
 * count is the recorded fault count, and recovery time is whole-scenario
 * wall-clock time from scenario start (the fault is injected at T3) to a valid
 * graded disposition. The design's separate cold-start and service-ready
 * measurements are not separated here.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FLEET } from "./fleet.ts";
import { runDurableScenario, runExistingScenario } from "./runner.ts";

const DESIGN_MANUAL_ACTION_THRESHOLD_PERCENT = 50;
const DESIGN_RECOVERY_TIME_THRESHOLD_PERCENT = 30;
const DESIGN_HEALTHY_TOLERANCE_PERCENT = 15;
const DEFAULT_RUNS = 10;

export type CalibrationSample = {
  run: number;
  existingMs: number;
  durableMs: number;
  existingWithFaultMs: number;
  durableWithFaultMs: number;
  existingActions: number;
  durableActions: number;
  duplicateOutcomes: number;
};

export type CalibrationResult = {
  status: "pass" | "not-covered";
  reason?: string;
  runs: number;
  samples: CalibrationSample[];
  medians: {
    existing: number;
    piDurable: number;
    existingWithFault: number;
    piDurableWithFault: number;
  };
  noiseFloorPercent: number;
  manualActions: { existing: number; piDurable: number };
  thresholds: {
    manualActionReductionPercent: number;
    recoveryTimeReductionPercent: number;
    healthyLatencyTolerancePercent: number;
    noiseFloorPercent: number;
    basis: string;
  };
  verdicts: {
    manualActions: "improved" | "parity" | "unproven";
    recoveryTime: "improved" | "parity" | "unproven";
    duplicateOutcomes: "preserved" | "unproven";
  };
  /** Why each scorecard metric is or is not a valid measurement of its claim. */
  limits: string[];
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Median absolute deviation as a fraction of the median: a scale-free noise floor. */
function noiseFraction(values: readonly number[]): number {
  const centre = median(values);
  if (centre === 0) return 0;
  return median(values.map((value) => Math.abs(value - centre))) / centre;
}

export async function runCalibration(
  workDir: string,
  outcomeScript: string,
  runs = Number.parseInt(process.env.FM_PI_DURABLE_CALIBRATION_RUNS ?? "", 10) || DEFAULT_RUNS,
): Promise<CalibrationResult> {
  if (runs <= 0) {
    return {
      status: "not-covered",
      reason: "calibration was skipped for this run",
      runs: 0,
      samples: [],
      medians: { existing: 0, piDurable: 0, existingWithFault: 0, piDurableWithFault: 0 },
      noiseFloorPercent: 0,
      manualActions: { existing: 0, piDurable: 0 },
      thresholds: {
        manualActionReductionPercent: DESIGN_MANUAL_ACTION_THRESHOLD_PERCENT,
        recoveryTimeReductionPercent: DESIGN_RECOVERY_TIME_THRESHOLD_PERCENT,
        healthyLatencyTolerancePercent: DESIGN_HEALTHY_TOLERANCE_PERCENT,
        noiseFloorPercent: 0,
        basis: "design defaults; no measured runs",
      },
      verdicts: { manualActions: "unproven", recoveryTime: "unproven", duplicateOutcomes: "unproven" },
      limits: [
        "manual recovery actions count recorded faults, not operator actions",
        "recovery time compares whole scenario wall-clock times whose faulted runs still include missing outcomes",
        "duplicate outcomes are compared by subtracting total outcome counts between arms; equal totals do not establish the absence of duplicates",
      ],
    };
  }

  const samples: CalibrationSample[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const home = (name: string) => {
      const path = join(workDir, `calibration-${run}`, name);
      mkdirSync(join(path, "state"), { recursive: true });
      return path;
    };

    const startedExisting = performance.now();
    const existing = await runExistingScenario({
      home: home("existing"),
      scenario: "fleet",
      tasks: FLEET,
      outcomeScript,
    });
    const existingMs = performance.now() - startedExisting;

    const startedDurable = performance.now();
    const durable = await runDurableScenario({
      home: home("durable"),
      scenario: "fleet",
      tasks: FLEET,
      outcomeScript,
    });
    const durableMs = performance.now() - startedDurable;

    const startedExistingFault = performance.now();
    const existingWithFault = await runExistingScenario({
      home: home("existing-fault"),
      scenario: "fleet-fault-T3",
      tasks: FLEET,
      outcomeScript,
      crashAtTask: "T3",
    });
    const existingWithFaultMs = performance.now() - startedExistingFault;

    const startedDurableFault = performance.now();
    const durableWithFault = await runDurableScenario({
      home: home("durable-fault"),
      scenario: "fleet-fault-model",
      tasks: FLEET,
      outcomeScript,
      crashAt: "dispatch.model.after",
    });
    const durableWithFaultMs = performance.now() - startedDurableFault;

    samples.push({
      run,
      existingMs,
      durableMs,
      existingWithFaultMs,
      durableWithFaultMs,
      existingActions: existingWithFault.faults.length,
      durableActions: durableWithFault.faults.length,
      duplicateOutcomes:
        existingWithFault.trace.outcomes.length - durableWithFault.trace.outcomes.length,
    });
  }

  const existingMs = samples.map((sample) => sample.existingMs);
  const durableMs = samples.map((sample) => sample.durableMs);
  const existingWithFaultMs = samples.map((sample) => sample.existingWithFaultMs);
  const durableWithFaultMs = samples.map((sample) => sample.durableWithFaultMs);

  const medians = {
    existing: median(existingMs),
    piDurable: median(durableMs),
    existingWithFault: median(existingWithFaultMs),
    piDurableWithFault: median(durableWithFaultMs),
  };

  // The recovery-time threshold must exceed the measured spread of the arm being
  // compared against, or a run-to-run wobble would read as an improvement.
  const noiseFloorPercent = Math.ceil(noiseFraction(existingWithFaultMs) * 100);
  const thresholds = {
    manualActionReductionPercent: DESIGN_MANUAL_ACTION_THRESHOLD_PERCENT,
    recoveryTimeReductionPercent: Math.max(
      DESIGN_RECOVERY_TIME_THRESHOLD_PERCENT,
      noiseFloorPercent * 3,
    ),
    healthyLatencyTolerancePercent: Math.max(
      DESIGN_HEALTHY_TOLERANCE_PERCENT,
      noiseFloorPercent * 2,
    ),
    noiseFloorPercent,
    basis: `measured over ${runs} deterministic runs: median absolute deviation of the faulted baseline is ${noiseFloorPercent}% of its median, so the recovery-time threshold is max(${DESIGN_RECOVERY_TIME_THRESHOLD_PERCENT}%, 3x noise) and the healthy-latency tolerance is max(${DESIGN_HEALTHY_TOLERANCE_PERCENT}%, 2x noise)`,
  };

  const existingActions = samples.reduce((total, sample) => total + sample.existingActions, 0) / samples.length;
  const durableActions = samples.reduce((total, sample) => total + sample.durableActions, 0) / samples.length;
  const actionReduction =
    existingActions === 0 ? null : ((existingActions - durableActions) / existingActions) * 100;
  const recoveryReduction =
    medians.existingWithFault === 0
      ? null
      : ((medians.existingWithFault - medians.piDurableWithFault) / medians.existingWithFault) * 100;
  const duplicateOutcomes = samples.some((sample) => sample.duplicateOutcomes > 0);

  return {
    status: "pass",
    runs,
    samples,
    medians,
    noiseFloorPercent,
    manualActions: { existing: existingActions, piDurable: durableActions },
    thresholds,
    verdicts: {
      // Each benefit label is held to what the measurement actually proves:
      // none of these three metrics measures the claimed benefit, so every
      // verdict stays unproven regardless of the observed counts.
      manualActions: "unproven",
      recoveryTime: "unproven",
      duplicateOutcomes: "unproven",
    },
    limits: [
      "manual recovery actions count recorded faults, not operator actions",
      "recovery time compares whole scenario wall-clock times whose faulted runs still include missing outcomes",
      "duplicate outcomes are compared by subtracting total outcome counts between arms; equal totals do not establish the absence of duplicates",
    ],
  };
}
