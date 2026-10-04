/**
 * Independent grader for the P2 harness.
 *
 * The grader reads the external effect ledger, the durable outcome records, the
 * adapter operation records, and the acknowledgement records, then checks them
 * against fixture truth. It parses records independently of any adapter status
 * code and cross-checks claims against physical effects. Negative controls
 * corrupt a trace in four ways and must all be rejected.
 */

import type { Effect } from "./effects.ts";
import type { FleetTask } from "./fleet.ts";

export type OutcomeRecord = {
  task: string;
  verdict: string;
  summary: string;
  seq: number;
};

export type OperationRecordView = {
  operationId: string;
  task: string;
  state: string;
  receiptSeq: number | null;
};

export type Trace = {
  outcomes: OutcomeRecord[];
  operations: OperationRecordView[];
  effects: Effect[];
  acknowledgements: { task: string; owner: string }[];
  /** Rows the harness accepted for this scenario. */
  acceptedRows: string[];
  /** Owners permitted to act. */
  allowedOwners: string[];
};

export type Check = { name: string; ok: boolean; detail: string };

export type GradeResult = { passed: boolean; checks: Check[] };

const DISPOSITION = /disposition=([a-z_]+)/;

export function dispositionOf(summary: string): string | null {
  const match = DISPOSITION.exec(summary);
  return match ? match[1]! : null;
}

/** Grade one scenario trace against the fixture truth. */
export function grade(tasks: readonly FleetTask[], trace: Trace): GradeResult {
  const checks: Check[] = [];

  const outcomesFor = (task: string) => trace.outcomes.filter((outcome) => outcome.task === task);
  const missing = tasks.filter((task) => outcomesFor(task.id).length === 0);
  checks.push({
    name: "every accepted task has an outcome",
    ok: missing.length === 0,
    detail: missing.length ? `missing outcomes: ${missing.map((task) => task.id).join(", ")}` : "all tasks settled",
  });

  const duplicates = tasks.filter((task) => outcomesFor(task.id).length > 1);
  checks.push({
    name: "no duplicate outcome per task",
    ok: duplicates.length === 0,
    detail: duplicates.length ? `duplicated: ${duplicates.map((task) => task.id).join(", ")}` : "one outcome per task",
  });

  const wrong = tasks.filter((task) => {
    const outcome = outcomesFor(task.id)[0];
    return outcome ? dispositionOf(outcome.summary) !== task.requiredDisposition : false;
  });
  checks.push({
    name: "each disposition matches fixture truth",
    ok: wrong.length === 0,
    detail: wrong.length
      ? wrong
          .map((task) => `${task.id}: got ${dispositionOf(outcomesFor(task.id)[0]!.summary) ?? "none"}`)
          .join("; ")
      : "all dispositions correct",
  });

  const verdictWrong = tasks.filter((task) => {
    const outcome = outcomesFor(task.id)[0];
    if (!outcome) return false;
    const wantCaptain = task.decisionOwner === "captain";
    return wantCaptain ? outcome.verdict !== "captain" : outcome.verdict !== "routine";
  });
  checks.push({
    name: "verdict preserves decision ownership",
    ok: verdictWrong.length === 0,
    detail: verdictWrong.length ? `wrong verdict: ${verdictWrong.map((task) => task.id).join(", ")}` : "verdicts correct",
  });

  const effectDuplicates = trace.effects.filter((effect) => {
    const key = `${effect.operationId}:${effect.effect}`;
    return trace.effects.filter((other) => `${other.operationId}:${other.effect}` === key).length > 1;
  });
  checks.push({
    name: "no duplicate applied effect",
    ok: effectDuplicates.length === 0,
    detail: effectDuplicates.length ? `duplicate effects: ${effectDuplicates.map((effect) => effect.effect).join(", ")}` : "no duplicate effects",
  });

  const stale = trace.effects.filter((effect) => !trace.allowedOwners.includes(effect.owner));
  const staleAcks = trace.acknowledgements.filter((ack) => !trace.allowedOwners.includes(ack.owner));
  checks.push({
    name: "no stale-owner effect or acknowledgement",
    ok: stale.length === 0 && staleAcks.length === 0,
    detail: stale.length + staleAcks.length > 0 ? `stale actions: ${stale.length + staleAcks.length}` : "no stale actions",
  });

  const lost = trace.acceptedRows.filter(
    (row) =>
      !trace.outcomes.some((outcome) => outcome.task === rowTask(row, tasks)) &&
      !trace.operations.some((operation) => operation.task === rowTask(row, tasks) && operation.state === "accepted"),
  );
  checks.push({
    name: "no lost accepted row",
    ok: lost.length === 0,
    detail: lost.length ? `lost rows: ${lost.join(", ")}` : "no lost rows",
  });

  const falseCompletion = tasks.filter((task) => {
    const outcome = outcomesFor(task.id)[0];
    if (!outcome) return false;
    const disposition = dispositionOf(outcome.summary);
    const successDispositions = new Set(["ready_for_review", "working"]);
    return (
      (task.requiredDisposition === "surface_failure" || task.requiredDisposition === "escalate_decision") &&
      disposition !== null &&
      successDispositions.has(disposition)
    );
  });
  checks.push({
    name: "no false completion",
    ok: falseCompletion.length === 0,
    detail: falseCompletion.length ? `false completions: ${falseCompletion.map((task) => task.id).join(", ")}` : "no false completions",
  });

  const settlementWithoutReceipt = trace.operations.filter(
    (operation) => operation.state === "settled" && operation.receiptSeq === null,
  );
  checks.push({
    name: "every settlement has a delivery receipt",
    ok: settlementWithoutReceipt.length === 0,
    detail: settlementWithoutReceipt.length
      ? `settlements without receipts: ${settlementWithoutReceipt.map((operation) => operation.operationId).join(", ")}`
      : "all settlements receipted",
  });

  return { passed: checks.every((check) => check.ok), checks };
}

function rowTask(row: string, tasks: readonly FleetTask[]): string {
  const task = tasks.find((candidate) => candidate.acceptedRows.includes(row));
  return task ? task.id : row;
}

/** Negative controls: each corrupted trace must be rejected by the grader. */
export function negativeControls(tasks: readonly FleetTask[], good: Trace): { name: string; rejected: boolean }[] {
  const corruptions: { name: string; trace: Trace }[] = [
    {
      name: "drop one accepted row",
      trace: { ...good, acceptedRows: [...good.acceptedRows, "row-dropped"] },
    },
    {
      name: "inject a second effect",
      trace: {
        ...good,
        effects: [
          ...good.effects,
          ...(good.effects[0]
            ? [{ ...good.effects[0], at: good.effects[0].at + 1 }]
            : [{ effect: "outcome:X", operationId: "op-X", owner: "branch", at: 0 }]),
        ],
      },
    },
    {
      name: "forge a completion without a receipt",
      trace: {
        ...good,
        operations: good.operations.map((operation) =>
          operation.state === "settled" ? { ...operation, receiptSeq: null } : operation,
        ),
      },
    },
    {
      name: "change the owner of an acknowledgement",
      trace: { ...good, acknowledgements: [...good.acknowledgements, { task: tasks[0]?.id ?? "T1", owner: "stale-owner" }] },
    },
  ];
  return corruptions.map((corruption) => ({
    name: corruption.name,
    rejected: !grade(tasks, corruption.trace).passed,
  }));
}
