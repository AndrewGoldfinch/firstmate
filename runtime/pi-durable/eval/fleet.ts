/**
 * Controlled fleet problem for the P2 evaluation harness.
 *
 * Six single-incident fixtures plus one mixed fleet, each with fixture truth.
 * The truth is the answer key: the scripted responder returns the required
 * disposition, and the independent grader checks the durable trace against it.
 * The answer key never reaches the evaluated implementation.
 */

export type Disposition =
  | "ready_for_review"
  | "surface_failure"
  | "working"
  | "escalate_decision"
  | "recover_or_escalate"
  | "preserve_state";

export type FleetTask = {
  id: string;
  title: string;
  planted: string;
  requiredDisposition: Disposition;
  acceptedRows: string[];
  allowedOwner: string;
  decisionOwner: string | null;
  expectedCi: "pass" | "fail" | "none";
  permittedEffects: string[];
};

export const FLEET: readonly FleetTask[] = [
  {
    id: "T1",
    title: "parser cleanup",
    planted: "Worker finished; tests pass; review remains pending",
    requiredDisposition: "ready_for_review",
    acceptedRows: ["row-T1"],
    allowedOwner: "branch",
    decisionOwner: null,
    expectedCi: "pass",
    permittedEffects: ["outcome:T1"],
  },
  {
    id: "T2",
    title: "retry handling",
    planted: "Worker claims completion but CI contains a failing case",
    requiredDisposition: "surface_failure",
    acceptedRows: ["row-T2"],
    allowedOwner: "branch",
    decisionOwner: null,
    expectedCi: "fail",
    permittedEffects: ["outcome:T2"],
  },
  {
    id: "T3",
    title: "slow test run",
    planted: "No recent text output, but a live worker and test heartbeat show progress",
    requiredDisposition: "working",
    acceptedRows: ["row-T3"],
    allowedOwner: "branch",
    decisionOwner: null,
    expectedCi: "none",
    permittedEffects: ["outcome:T3"],
  },
  {
    id: "T4",
    title: "expired credentials",
    planted: "Work needs a captain-owned decision",
    requiredDisposition: "escalate_decision",
    acceptedRows: ["row-T4"],
    allowedOwner: "branch",
    decisionOwner: "captain",
    expectedCi: "none",
    permittedEffects: ["outcome:T4"],
  },
  {
    id: "T5",
    title: "interrupted analysis",
    planted: "A worker exit and incomplete result are visible",
    requiredDisposition: "recover_or_escalate",
    acceptedRows: ["row-T5"],
    allowedOwner: "branch",
    decisionOwner: null,
    expectedCi: "none",
    permittedEffects: ["outcome:T5"],
  },
  {
    id: "T6",
    title: "duplicate reports",
    planted: "A status event is repeated and an older event arrives late",
    requiredDisposition: "preserve_state",
    acceptedRows: ["row-T6"],
    allowedOwner: "branch",
    decisionOwner: null,
    expectedCi: "none",
    permittedEffects: ["outcome:T6"],
  },
] as const;

export type MixedFleet = {
  id: "mixed";
  tasks: readonly string[];
  requiredDispositions: Record<string, Disposition>;
};

export const MIXED_FLEET: MixedFleet = {
  id: "mixed",
  tasks: FLEET.map((task) => task.id),
  requiredDispositions: Object.fromEntries(
    FLEET.map((task) => [task.id, task.requiredDisposition]),
  ) as Record<string, Disposition>,
};

export function taskById(id: string): FleetTask {
  const task = FLEET.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`unknown fleet task ${id}`);
  return task;
}

/** The verdict an outcome must carry for a required disposition. */
export function verdictFor(disposition: Disposition): "routine" | "captain" {
  return disposition === "escalate_decision" ? "captain" : "routine";
}
