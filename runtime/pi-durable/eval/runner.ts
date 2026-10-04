/**
 * Scenario runner for the P2 harness.
 *
 * Runs the controlled fleet through two arms: the durable sidecar (arm B) and a
 * reduced model of the existing in-process path (arm A). Faults trigger at
 * named barriers around persistence and effect boundaries. The runner never
 * repairs an implementation, adds retries, deduplicates effects, or synthesizes
 * outcomes.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
  /** Task id whose in-process execution is interrupted before its outcome. */
  crashAtTask?: string;
};

/**
 * Run one scenario through the reduced existing-path arm: the real outcome
 * store, no durable operation acceptance. A crash mid-task loses that task.
 */
export async function runExistingScenario(input: ExistingScenarioInput): Promise<ArmResult> {
  mkdirSync(join(input.home, "state"), { recursive: true });
  const respond = input.respond ?? truthfulResponder();
  const env = { ...process.env, FM_HOME: input.home };
  const ledger = new EffectLedger();
  const faults: string[] = [];
  const notes: string[] = [];
  const sink = createOutcomeSink({ scriptPath: input.outcomeScript, env });
  const operations: OperationRecordView[] = [];

  for (const task of input.tasks) {
    if (input.crashAtTask === task.id) {
      faults.push(`existing owner lost ${task.id} mid-execution`);
      notes.push(`${task.id}: lost (in-process execution interrupted)`);
      operations.push({ operationId: `existing:${task.id}`, task: task.id, state: "lost", receiptSeq: null });
      continue;
    }
    await sink.appendOrGet(`existing:${task.id}`, respond(task));
    ledger.apply(`outcome:${task.id}`, task.id, "branch");
    operations.push({ operationId: `existing:${task.id}`, task: task.id, state: "settled", receiptSeq: 1 });
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
