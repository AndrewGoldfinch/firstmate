/**
 * Scenario runner for the P2 harness.
 *
 * Runs the controlled fleet through two arms: the durable sidecar (arm B) and a
 * reduced model of the existing in-process path (arm A). Faults trigger at
 * named barriers around persistence and effect boundaries. The runner never
 * repairs an implementation, adds retries, deduplicates effects, or synthesizes
 * outcomes.
 *
 * The external effect under test is an externally visible note delivery. For
 * arm A a delivery is a presentation from the store's unread rows; for arm B a
 * delivery is a new outcome row the durable sink commits. Both are recorded at
 * the boundary where the note becomes visible, never from a replay flag.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxProvider, type MutableModels } from "@earendil-works/pi-ai";
import { DurableSidecar } from "../src/service.ts";
import { runDurableDispatch } from "../src/bridge.ts";
import { SidecarClient } from "../src/sidecar-client.ts";
import { BridgeError, type CandidateResult } from "../src/bridge.ts";
import { EffectLedger } from "./effects.ts";
import type { FleetTask } from "./fleet.ts";
import type { Delivery, OperationRecordView, OutcomeRecord, StaleOwnerAttempt, Trace } from "./grader.ts";

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
  // Read through the script itself.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("bash", [scriptPath, "list", "--recent", "200"], { env, encoding: "utf8" });
  return outcomeRecords(out);
}

/** Run one outcome-store subcommand synchronously. */
function runOutcomeSync(scriptPath: string, env: NodeJS.ProcessEnv, args: readonly string[]): string {
  return execFileSync("bash", [scriptPath, ...args], { env, encoding: "utf8" });
}

/** Read the store's unread rows exactly as the branch reconciliation does. */
function readUnreadOutcomes(scriptPath: string, env: NodeJS.ProcessEnv): OutcomeRecord[] {
  return outcomeRecords(runOutcomeSync(scriptPath, env, ["unread"]));
}

export type DurableScenarioInput = {
  home: string;
  scenario: string;
  tasks: readonly FleetTask[];
  outcomeScript: string;
  respond?: Responder;
  /** Barrier name that crashes the owner once. */
  crashAt?: string;
  /**
   * Task whose owner crashes after the operation has settled but before its
   * effect is acknowledged, so the retry must replay without a second effect.
   */
  crashAfterSettleTask?: string;
  /**
   * Task whose superseded owner attempts an append after a genuine owner
   * replacement. The current authority must refuse it, which makes the
   * zero-stale-owner clause non-vacuous.
   */
  staleOwnerAfterSettleTask?: string;
};

/** Run one scenario through the durable arm. */
export async function runDurableScenario(input: DurableScenarioInput): Promise<ArmResult> {
  mkdirSync(join(input.home, "state"), { recursive: true });
  const respond = input.respond ?? truthfulResponder();
  const env = { ...process.env, FM_HOME: input.home };
  const faults: string[] = [];
  const notes: string[] = [];
  const deliveries: Delivery[] = [];
  const staleOwnerAttempts: StaleOwnerAttempt[] = [];
  const observedRows = new Map<string, number>();
  let crashArmed = input.crashAt !== undefined;

  const faux = fauxProvider();
  const model = faux.models[0]!;
  const configure = (models: MutableModels) => models.setProvider(faux.provider);
  let generation = 1;

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

  const ensureSupervisor = async (sidecar: DurableSidecar): Promise<void> => {
    const ensured = await sidecarRequest(sidecar.socketPath, {
      protocolVersion: 2,
      homeId: sidecar.homeId,
      op: "ensureSupervisor",
      supervisorId: "pi-supervisor",
      ownerGeneration: generation,
      wakeClaimId: "claim-1",
      rowIds: input.tasks.flatMap((task) => task.acceptedRows),
      capabilityProfile: "supervision-observe-v1",
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: "high",
      cwd: input.home,
    });
    if (!ensured.ok) throw new Error(`ensureSupervisor failed: ${ensured.error.code}`);
  };

  let sidecar = await startSidecar();
  await ensureSupervisor(sidecar);

  // A delivery is a new outcome row observed through the store, so a durable
  // sink that re-applied an effect while reporting a replay would still be seen.
  const observeDeliveries = async (): Promise<void> => {
    const rows = await readOutcomeStore(input.outcomeScript, env);
    for (const task of input.tasks) {
      const count = rows.filter((row) => row.task === task.id).length;
      const prior = observedRows.get(task.id) ?? 0;
      for (let index = prior; index < count; index += 1) deliveries.push({ note: task.id, owner: "branch" });
      observedRows.set(task.id, count);
    }
  };

  const operationViews: OperationRecordView[] = [];
  for (const task of input.tasks) {
    const operationId = `fm:${input.home}:supervision:${task.id}:1`;
    const candidate = respond(task);
    const transport = new SidecarClient({
      socketPath: sidecar.socketPath,
      homeId: sidecar.homeId,
      supervisorId: "pi-supervisor",
      capabilityProfile: "supervision-observe-v1",
      ownerGeneration: generation,
      wakeClaimId: "claim-1",
      rowIds: task.acceptedRows,
      outcomeScript: input.outcomeScript,
    });

    faux.setResponses([fauxAssistantMessage(JSON.stringify(candidate))]);
    let settled = false;
    try {
      const result = await runDurableDispatch(
        { transport },
        { operationId, prompt: `supervise ${task.id}`, payload: { task: task.id, rows: task.acceptedRows } },
      );
      notes.push(`${task.id}: seq=${result.seq} replayed=${result.replayed}`);
      await observeDeliveries();
      settled = true;
      if (input.crashAfterSettleTask === task.id) {
        faults.push(`pi-durable owner lost ${task.id} after settlement`);
        notes.push(`${task.id}: settled; the restarted owner must not deliver it twice`);
        settled = false;
      }
    } catch (error) {
      faults.push(error instanceof Error ? error.message : String(error));
    }

    if (!settled && (input.crashAt || input.crashAfterSettleTask)) {
      // Same-generation process restart: the logical owner is unchanged, so the
      // settled operation is replayed rather than re-executed.
      await sidecar.stop();
      sidecar = await startSidecar();
      await ensureSupervisor(sidecar);
      faux.setResponses([fauxAssistantMessage(JSON.stringify(candidate))]);
      try {
        const replayed = await runDurableDispatch(
          { transport },
          { operationId, prompt: `supervise ${task.id}`, payload: { task: task.id, rows: task.acceptedRows } },
        );
        notes.push(`${task.id}: recovered seq=${replayed.seq} replayed=${replayed.replayed}`);
        await observeDeliveries();
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

  // Stale-owner check: a genuine owner replacement bumps the recorded
  // generation, then the superseded owner attempts the append it could
  // otherwise re-apply. The current authority must refuse it.
  if (input.staleOwnerAfterSettleTask) {
    const task = input.tasks.find((candidate) => candidate.id === input.staleOwnerAfterSettleTask);
    if (task) {
      const operationId = `fm:${input.home}:supervision:${task.id}:1`;
      const staleTransport = new SidecarClient({
        socketPath: sidecar.socketPath,
        homeId: sidecar.homeId,
        supervisorId: "pi-supervisor",
        capabilityProfile: "supervision-observe-v1",
        ownerGeneration: generation,
        wakeClaimId: "claim-1",
        rowIds: task.acceptedRows,
        outcomeScript: input.outcomeScript,
      });
      generation += 1;
      await ensureSupervisor(sidecar);
      try {
        await staleTransport.appendOutcome({ operationId, result: respond(task) });
        staleOwnerAttempts.push({ note: task.id, owner: "generation-1", accepted: true, code: null });
        notes.push(`${task.id}: STALE append was accepted after the owner replacement`);
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : "error";
        staleOwnerAttempts.push({ note: task.id, owner: "generation-1", accepted: false, code });
        notes.push(`${task.id}: stale append refused (${code})`);
      }
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
      effects: outcomes.map((outcome) => ({
        effect: `outcome:${outcome.task}`,
        operationId: outcome.task,
        owner: "branch",
        at: 0,
      })),
      deliveries,
      acknowledgements: [],
      staleOwnerAttempts,
      acceptedRows: input.tasks.flatMap((task) => task.acceptedRows),
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
  /**
   * Task whose routine note is delivered and then the cursor write fails, so
   * the still-unread row is delivered a second time on the next
   * reconciliation. This is the documented F09 limitation the benefit
   * experiment targets.
   */
  deliverBeforeAckTask?: string;
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
  const deliveries: Delivery[] = [];

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

  // Deliver each routine note from the store's unread rows and advance the
  // cursor after each, exactly as the branch's reconciliation does. A fault
  // after a delivery but before its cursor write leaves the row unread, so a
  // later reconciliation delivers the same logical note again.
  const reconcile = (faultTask: string | undefined): void => {
    const unread = readUnreadOutcomes(input.outcomeScript, env);
    for (const row of unread) {
      deliveries.push({ note: row.task, owner: "branch" });
      if (faultTask !== undefined && row.task === faultTask) {
        faults.push(`existing owner lost ${faultTask} after its routine note was delivered`);
        notes.push(`${faultTask}: routine note delivered, cursor write failed, row still unread`);
        return;
      }
      runOutcomeSync(input.outcomeScript, env, ["mark-read", "--through", String(row.seq)]);
    }
  };
  reconcile(input.deliverBeforeAckTask);
  if (input.deliverBeforeAckTask !== undefined) {
    reconcile(undefined);
    notes.push(`${input.deliverBeforeAckTask}: re-presented after recovery`);
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
      deliveries,
      acknowledgements: [],
      staleOwnerAttempts: [],
      acceptedRows: input.tasks.flatMap((task) => task.acceptedRows),
    },
  };
}

/**
 * Causal control: the same logical note appended twice through the real store.
 * With an operation key the append-or-return-existing keeps one row; without
 * one the append is not idempotent and the failure is recreated. This is the
 * dedup-disabled control, run directly against the store rather than inferred
 * from either arm.
 */
export function runDedupCausalControl(
  outcomeScript: string,
  workDir: string,
): { withOperationKey: number; withoutOperationKey: number } {
  const append = (home: string, args: readonly string[]): void => {
    mkdirSync(join(home, "state"), { recursive: true });
    runOutcomeSync(outcomeScript, { ...process.env, FM_HOME: home }, args);
  };
  const base = ["--task", "C1", "--verdict", "routine", "--summary", "disposition=working; causal control"];
  const keyed = join(workDir, "causal-keyed");
  const unkeyed = join(workDir, "causal-unkeyed");
  append(keyed, ["append", ...base, "--operation-key", "causal:key:1"]);
  append(keyed, ["append", ...base, "--operation-key", "causal:key:1"]);
  append(unkeyed, ["append", ...base]);
  append(unkeyed, ["append", ...base]);
  const count = (home: string): number =>
    outcomeRecords(runOutcomeSync(outcomeScript, { ...process.env, FM_HOME: home }, ["list", "--recent", "200"]))
      .length;
  return { withOperationKey: count(keyed), withoutOperationKey: count(unkeyed) };
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
