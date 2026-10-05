/**
 * Scenario runner for the P2 harness.
 *
 * Runs the controlled fleet through two arms: the durable sidecar (arm B) and a
 * reduced model of the existing in-process path (arm A). Faults trigger at
 * named barriers around persistence and effect boundaries. The runner never
 * repairs an implementation, adds retries, deduplicates effects, or synthesizes
 * outcomes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxProvider, type MutableModels } from "@earendil-works/pi-ai";
import { DurableSidecar } from "../src/service.ts";
import { runDurableDispatch } from "../src/bridge.ts";
import { SidecarClient } from "../src/sidecar-client.ts";
import { createOutcomeSink } from "../src/outcome-sink.ts";
import type { CandidateResult } from "../src/bridge.ts";
import { EffectLedger } from "./effects.ts";
import type { FleetTask } from "./fleet.ts";
import type { OperationRecordView, OutcomeRecord, Trace } from "./grader.ts";

export class SimulatedCrash extends Error {
  readonly barrier: string;

  constructor(barrier: string) {
    super(`simulated owner crash at ${barrier}`);
    this.name = "SimulatedCrash";
    this.barrier = barrier;
  }
}

export type ArmResult = {
  arm: "existing" | "pi-durable";
  scenario: string;
  trace: Trace;
  faults: string[];
  notes: string[];
};

export type Responder = (task: FleetTask) => CandidateResult;

/** Build a responder that returns the fixture-truth disposition. */
export function truthfulResponder(): Responder {
  return (task) => ({
    task: task.id,
    verdict: task.decisionOwner === "captain" ? "captain" : "routine",
    summary: `disposition=${task.requiredDisposition}; ${task.title}`,
  });
}

function outcomeRecords(lines: string): OutcomeRecord[] {
  return lines
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OutcomeRecord);
}

async function readOutcomeStore(scriptPath: string, env: NodeJS.ProcessEnv): Promise<OutcomeRecord[]> {
  const sink = createOutcomeSink({ scriptPath, env });
  // The sink only appends; read through the script itself.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("bash", [scriptPath, "list", "--recent", "200"], { env, encoding: "utf8" });
  void sink;
  return outcomeRecords(out);
}

export type DurableScenarioInput = {
  home: string;
  scenario: string;
  tasks: readonly FleetTask[];
  outcomeScript: string;
  respond?: Responder;
  /** Barrier name that crashes the owner once. */
  crashAt?: string;
};

/** Run one scenario through the durable arm. */
export async function runDurableScenario(input: DurableScenarioInput): Promise<ArmResult> {
  mkdirSync(join(input.home, "state"), { recursive: true });
  const respond = input.respond ?? truthfulResponder();
  const env = { ...process.env, FM_HOME: input.home };
  const ledger = new EffectLedger();
  const faults: string[] = [];
  const notes: string[] = [];
  let crashArmed = input.crashAt !== undefined;

  const faux = fauxProvider();
  const model = faux.models[0]!;
  const configure = (models: MutableModels) => models.setProvider(faux.provider);

  const startSidecar = () =>
    DurableSidecar.start({
      home: input.home,
      configureModels: configure,
      barriers: (name) => {
        if (crashArmed && name === input.crashAt) {
          crashArmed = false;
          throw new SimulatedCrash(name);
        }
      },
    });

  let sidecar = await startSidecar();
  const ensured = await sidecarRequest(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "ensureSupervisor",
    supervisorId: "pi-supervisor",
    ownerGeneration: 1,
    wakeClaimId: "claim-1",
    rowIds: input.tasks.flatMap((task) => task.acceptedRows),
    capabilityProfile: "supervision-observe-v1",
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "high",
    cwd: input.home,
  });
  if (!ensured.ok) throw new Error(`ensureSupervisor failed: ${ensured.error.code}`);

  const operationViews: OperationRecordView[] = [];
  for (const task of input.tasks) {
    const operationId = `fm:${input.home}:supervision:${task.id}:1`;
    const transport = new SidecarClient({
      socketPath: sidecar.socketPath,
      homeId: sidecar.homeId,
      supervisorId: "pi-supervisor",
      capabilityProfile: "supervision-observe-v1",
      ownerGeneration: 1,
      wakeClaimId: "claim-1",
      rowIds: task.acceptedRows,
    });
    const sink = createOutcomeSink({ scriptPath: input.outcomeScript, env });

    faux.setResponses([fauxAssistantMessage(JSON.stringify(respond(task)))]);
    let settled = false;
    try {
      const result = await runDurableDispatch(
        { transport, sink },
        { operationId, prompt: `supervise ${task.id}`, payload: { task: task.id, rows: task.acceptedRows } },
      );
      ledger.apply(`outcome:${task.id}`, task.id, "branch");
      notes.push(`${task.id}: seq=${result.seq} replayed=${result.replayed}`);
      settled = true;
    } catch (error) {
      faults.push(error instanceof Error ? error.message : String(error));
    }

    if (!settled && input.crashAt) {
      // Recover: reopen the owner on the same store and retry the same ID.
      await sidecar.stop();
      sidecar = await startSidecar();
      faux.setResponses([fauxAssistantMessage(JSON.stringify(respond(task)))]);
      try {
        const result = await runDurableDispatch(
          { transport, sink },
          { operationId, prompt: `supervise ${task.id}`, payload: { task: task.id, rows: task.acceptedRows } },
        );
        ledger.apply(`outcome:${task.id}`, task.id, "branch");
        notes.push(`${task.id}: recovered seq=${result.seq} replayed=${result.replayed}`);
      } catch (error) {
        notes.push(`${task.id}: unresolved after recovery (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    const inspected = await sidecarRequest(sidecar.socketPath, {
      protocolVersion: 2,
      homeId: sidecar.homeId,
      op: "inspect",
      operationId,
    });
    if (inspected.ok) {
      const record = (inspected.result as { record: { state: string; receipt: { seq: number } | null } | null }).record;
      operationViews.push({
        operationId,
        task: task.id,
        state: record?.state ?? "absent",
        receiptSeq: record?.receipt?.seq ?? null,
      });
    }
  }

  await sidecar.stop();

  const outcomes = await readOutcomeStore(input.outcomeScript, env);
  return {
    arm: "pi-durable",
    scenario: input.scenario,
    faults,
    notes,
    trace: {
      outcomes,
      operations: operationViews,
      effects: [...ledger.all()],
      acknowledgements: [],
      acceptedRows: input.tasks.flatMap((task) => task.acceptedRows),
      allowedOwners: ["branch"],
    },
  };
}

export type ExistingScenarioInput = {
  home: string;
  scenario: string;
  tasks: readonly FleetTask[];
  outcomeScript: string;
  respond?: Responder;
  /** Task whose in-process execution is interrupted before its outcome. */
  crashAtTask?: string;
};

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const wakeLib = join(repoRoot, "bin", "fm-wake-lib.sh");
const branchDispatch = join(repoRoot, "bin", "fm-branch-dispatch.mjs");

/** Seed the real wake queue through the library's own append path. */
function wakeAppend(home: string, rows: readonly (readonly [string, string])[]): void {
  const script = `source "${wakeLib}"; while [ "$#" -ge 2 ]; do fm_wake_append signal "$1" "$2"; shift 2; done`;
  const args = rows.flatMap(([task, payload]) => [`${task}.status`, payload]);
  execFileSync("bash", ["-c", script, "wake", ...args], {
    env: { ...process.env, FM_HOME: home },
    cwd: repoRoot,
    encoding: "utf8",
  });
}

/** Claim the queued rows through the extension's own eligibility rules. */
function wakeScope(home: string): { status: string; tasks: string[] } {
  const out = execFileSync(process.execPath, [branchDispatch, "scope"], {
    env: { ...process.env, FM_HOME: home },
    cwd: repoRoot,
    encoding: "utf8",
  });
  const field = (name: string) =>
    out
      .split("\n")
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim() ?? "";
  return { status: field("status"), tasks: field("tasks").split(/\s+/).filter(Boolean) };
}

/** Consume handled rows through the library's own queue-prune path. */
function wakePrune(home: string, tasks: readonly string[]): void {
  const script = `source "${wakeLib}"; state="$1"; shift; for task in "$@"; do fm_wake_queue_prune_task "$state" "$task"; done`;
  execFileSync("bash", ["-c", script, "prune", join(home, "state"), ...tasks], {
    env: { ...process.env, FM_HOME: home },
    cwd: repoRoot,
    encoding: "utf8",
  });
}

/** Append one outcome exactly as the existing branch does: no operation key. */
function appendOutcome(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  task: FleetTask,
  result: CandidateResult,
): number {
  const out = execFileSync(
    "bash",
    [scriptPath, "append", "--task", task.id, "--verdict", result.verdict, "--summary", result.summary],
    { env, cwd: repoRoot, encoding: "utf8" },
  );
  const seq = Number.parseInt(out.trim(), 10);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`fm-branch-outcome.sh append returned a non-numeric sequence: ${out.trim()}`);
  }
  return seq;
}

/**
 * Run one scenario through the real existing supervision path as faithfully as
 * this environment allows: the real wake queue and eligibility rules
 * (bin/fm-wake-lib.sh, bin/fm-branch-dispatch.mjs) and the real append-only
 * outcome store (bin/fm-branch-outcome.sh). A crash mid-task leaves its wake
 * row queued, so the restart re-claims and reruns it, exactly as the pinned
 * extension's normal recovery does. What remains reduced: no interactive Pi
 * AgentSession drives the branch, so the wake is answered by the deterministic
 * responder instead of a Pi model turn.
 */
export async function runExistingScenario(input: ExistingScenarioInput): Promise<ArmResult> {
  const stateDir = join(input.home, "state");
  mkdirSync(stateDir, { recursive: true });
  const respond = input.respond ?? truthfulResponder();
  const env = { ...process.env, FM_HOME: input.home };
  const ledger = new EffectLedger();
  const faults: string[] = [];
  const notes: string[] = [];
  const operations: OperationRecordView[] = [];

  for (const task of input.tasks) writeFileSync(join(stateDir, `${task.id}.meta`), "project=fleet\n");
  wakeAppend(
    input.home,
    input.tasks.map((task) => [task.id, task.planted] as const),
  );

  let crashArmed = input.crashAtTask !== undefined;
  for (let round = 0; round < 2; round += 1) {
    const scope = wakeScope(input.home);
    if (scope.status !== "safe") break;
    const toPrune: string[] = [];
    let crashed = false;
    for (const taskId of scope.tasks) {
      const task = input.tasks.find((candidate) => candidate.id === taskId);
      if (!task) continue;
      if (crashArmed && taskId === input.crashAtTask) {
        crashArmed = false;
        crashed = true;
        faults.push(`existing owner lost ${taskId} mid-execution`);
        notes.push(`${taskId}: wake row left queued after the crash`);
        break;
      }
      const seq = appendOutcome(input.outcomeScript, env, task, respond(task));
      ledger.apply(`outcome:${task.id}`, task.id, "branch");
      operations.push({
        operationId: `existing:${task.id}`,
        task: task.id,
        state: "settled",
        receiptSeq: seq,
      });
      if (round > 0) notes.push(`${task.id}: recovered on the restarted owner`);
      toPrune.push(task.id);
    }
    if (toPrune.length > 0) wakePrune(input.home, toPrune);
    if (!crashed) break;
  }

  const outcomes = await readOutcomeStore(input.outcomeScript, env);
  return {
    arm: "existing",
    scenario: input.scenario,
    faults,
    notes,
    trace: {
      outcomes,
      operations,
      effects: [...ledger.all()],
      acknowledgements: [],
      acceptedRows: input.tasks.flatMap((task) => task.acceptedRows),
      allowedOwners: ["branch"],
    },
  };
}

/** Minimal protocol request helper so the harness does not depend on test helpers. */
async function sidecarRequest(
  socketPath: string,
  request: unknown,
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }
> {
  const { sidecarRequest: send } = await import("../src/sidecar-client.ts");
  return send(socketPath, request as never) as Promise<
    { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
  >;
}
