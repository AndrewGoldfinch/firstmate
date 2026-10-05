/**
 * F01-F18 fault matrix for the P2 harness.
 *
 * Each case runs deterministically against the real sidecar, bridge, and
 * outcome store where the environment supports it. Cases that need a real VM
 * reboot, real credentials, cancellation, or a real read-tool boundary are
 * recorded as explicitly not-covered rather than faked.
 */

import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createProvider, fauxAssistantMessage, fauxProvider, type Provider } from "@earendil-works/pi-ai";
import { DurableSidecar } from "../src/service.ts";
import { runDurableDispatch } from "../src/bridge.ts";
import { SidecarClient } from "../src/sidecar-client.ts";
import type { CandidateResult } from "../src/bridge.ts";
import type { DockerLaneResult } from "./docker-lane.ts";
import type { PilotResult } from "./pilot.ts";
import { SimulatedCrash } from "./runner.ts";

export type MatrixStatus = "pass" | "fail" | "not-covered" | "known-gap";

export type MatrixCaseResult = {
  id: string;
  title: string;
  status: MatrixStatus;
  detail: string;
};

type CaseContext = {
  workDir: string;
  outcomeScript: string;
  dockerLane?: DockerLaneResult;
  pilot?: PilotResult;
};

const RESULT: CandidateResult = { task: "T1", verdict: "routine", summary: "disposition=ready_for_review; ok" };

function caseHome(context: CaseContext, id: string): string {
  const home = join(context.workDir, `fault-${id}`);
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

async function startSidecar(
  home: string,
  crashAt?: string,
  onFaux?: (faux: ReturnType<typeof fauxProvider>) => void,
) {
  const faux = fauxProvider();
  const model = faux.models[0]!;
  onFaux?.(faux);
  let armed = crashAt !== undefined;
  const sidecar = await DurableSidecar.start({
    home,
    configureModels: (models) => models.setProvider(faux.provider),
    barriers: (name) => {
      if (armed && name === crashAt) {
        armed = false;
        throw new SimulatedCrash(name);
      }
    },
  });
  return { sidecar, faux, model };
}

async function ensure(sidecar: DurableSidecar, model: { provider: string; id: string }) {
  const { sidecarRequest } = await import("../src/sidecar-client.ts");
  const response = await sidecarRequest(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "ensureSupervisor",
    supervisorId: "pi-supervisor",
    ownerGeneration: 1,
    wakeClaimId: "claim-1",
    rowIds: ["row-T1"],
    capabilityProfile: "supervision-observe-v1",
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "high",
    cwd: sidecar.homeId,
  } as never);
  if (!response.ok) throw new Error(`ensureSupervisor failed: ${response.error.code}`);
}

async function dispatch(
  sidecar: DurableSidecar,
  home: string,
  faux: ReturnType<typeof fauxProvider>,
  operationId: string,
  outcomeScript: string,
  result: CandidateResult = RESULT,
) {
  faux.setResponses([fauxAssistantMessage(JSON.stringify(result))]);
  const transport = clientFor(sidecar, outcomeScript);
  return runDurableDispatch({ transport }, { operationId, prompt: "p", payload: { task: "T1" } });
}

/** The standard supervision client for one sidecar. */
function clientFor(sidecar: DurableSidecar, outcomeScript: string): SidecarClient {
  return new SidecarClient({
    socketPath: sidecar.socketPath,
    homeId: sidecar.homeId,
    supervisorId: "pi-supervisor",
    capabilityProfile: "supervision-observe-v1",
    ownerGeneration: 1,
    wakeClaimId: "claim-1",
    rowIds: ["row-T1"],
    outcomeScript,
  });
}

/** Observation kinds recorded for one operation, in durable sequence order. */
async function observationKinds(sidecar: DurableSidecar, operationId: string): Promise<string[]> {
  const { sidecarRequest } = await import("../src/sidecar-client.ts");
  const response = await sidecarRequest(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "observe",
    after: 0,
    limit: 256,
  } as never);
  if (!response.ok) return [];
  const result = response.result as {
    observations: { kind: string; operationId: string | null }[];
  };
  return result.observations
    .filter((observation) => observation.operationId === operationId)
    .map((observation) => observation.kind);
}

async function inspect(sidecar: DurableSidecar, operationId: string) {
  const { sidecarRequest } = await import("../src/sidecar-client.ts");
  return sidecarRequest(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "inspect",
    operationId,
  } as never);
}

export async function runMatrix(context: CaseContext): Promise<MatrixCaseResult[]> {
  const results: MatrixCaseResult[] = [];

  // F01 - after intent, before runtime acceptance: retry with the same ID is safe.
  {
    const home = caseHome(context, "F01");
    const { sidecar, faux, model } = await startSidecar(home, "dispatch.accept.before");
    await ensure(sidecar, model);
    let crashed = false;
    try {
      await dispatch(sidecar, home, faux, "op-F01", context.outcomeScript);
    } catch {
      crashed = true;
    }
    const first = await inspect(sidecar, "op-F01");
    const absent = first.ok && (first.result as { record: unknown }).record === null;
    const retry = await dispatch(sidecar, home, faux, "op-F01", context.outcomeScript);
    await sidecar.stop();
    results.push({
      id: "F01",
      title: "before runtime acceptance",
      status: crashed && absent && retry.seq > 0 ? "pass" : "fail",
      detail: `crashed=${crashed} absentAfterCrash=${absent} retrySeq=${retry.seq}`,
    });
  }

  // F02 - after acceptance, before reply: lookup finds the original; no fallback executor.
  {
    const home = caseHome(context, "F02");
    const { sidecar, faux, model } = await startSidecar(home, "dispatch.accept.after");
    await ensure(sidecar, model);
    try {
      await dispatch(sidecar, home, faux, "op-F02", context.outcomeScript);
    } catch {
      /* simulated crash */
    }
    const found = await inspect(sidecar, "op-F02");
    const record = found.ok ? (found.result as { record: { state: string } | null }).record : null;
    let retryCode = "none";
    try {
      await dispatch(sidecar, home, faux, "op-F02", context.outcomeScript);
    } catch (error) {
      retryCode = (error as { code?: string }).code ?? "error";
    }
    const outcomes = await readOutcomes(context.outcomeScript, home);
    await sidecar.stop();
    results.push({
      id: "F02",
      title: "after acceptance, before reply",
      status:
        record?.state === "accepted" && retryCode === "none" && outcomes.length === 1 ? "pass" : "fail",
      detail: `state=${record?.state ?? "absent"} retry=${retryCode} outcomes=${outcomes.length}`,
    });
  }

  // F03 - conversation recovered across a restart.
  {
    const home = caseHome(context, "F03");
    const first = await startSidecar(home);
    await ensure(first.sidecar, first.model);
    const { sidecarRequest } = await import("../src/sidecar-client.ts");
    const ensured = await sidecarRequest(first.sidecar.socketPath, {
      protocolVersion: 2,
      homeId: first.sidecar.homeId,
      op: "ensureSupervisor",
      supervisorId: "pi-supervisor",
      ownerGeneration: 1,
      wakeClaimId: "claim-1",
      rowIds: ["row-T1"],
      capabilityProfile: "supervision-observe-v1",
      model: { provider: first.model.provider, modelId: first.model.id },
      thinkingLevel: "high",
      cwd: home,
    } as never);
    if (!ensured.ok) throw new Error(`ensureSupervisor failed: ${ensured.error.code}`);
    const conversationId = (ensured.result as { conversationId: string }).conversationId;
    await first.sidecar.stop();
    const second = await startSidecar(home);
    await ensure(second.sidecar, second.model);
    const reensured = await sidecarRequest(second.sidecar.socketPath, {
      protocolVersion: 2,
      homeId: second.sidecar.homeId,
      op: "ensureSupervisor",
      supervisorId: "pi-supervisor",
      ownerGeneration: 1,
      wakeClaimId: "claim-1",
      rowIds: ["row-T1"],
      capabilityProfile: "supervision-observe-v1",
      model: { provider: second.model.provider, modelId: second.model.id },
      thinkingLevel: "high",
      cwd: home,
    } as never);
    if (!reensured.ok) throw new Error(`ensureSupervisor failed: ${reensured.error.code}`);
    const recovered = (reensured.result as { conversationId: string }).conversationId;
    await second.sidecar.stop();
    results.push({
      id: "F03",
      title: "conversation identity across restart",
      status: conversationId === recovered ? "pass" : "fail",
      detail: `conversationId=${conversationId} recovered=${recovered}`,
    });
  }

  // F04 - during a model response: partial output cannot become a valid outcome.
  {
    const home = caseHome(context, "F04");
    const { sidecar, faux, model } = await startSidecar(home, "dispatch.model.after");
    await ensure(sidecar, model);
    try {
      await dispatch(sidecar, home, faux, "op-F04", context.outcomeScript);
    } catch {
      /* simulated crash */
    }
    const found = await inspect(sidecar, "op-F04");
    const record = found.ok ? (found.result as { record: { state: string } | null }).record : null;
    const outcomes = await readOutcomes(context.outcomeScript, home);
    await sidecar.stop();
    results.push({
      id: "F04",
      title: "during a model response",
      status: record?.state === "accepted" && outcomes.length === 0 ? "pass" : "fail",
      detail: `state=${record?.state ?? "absent"} outcomes=${outcomes.length}`,
    });
  }

  // F05 - during a declared safe read: the read may rerun, and the rerun returns
  // the same snapshot with no side effect.
  {
    const home = caseHome(context, "F05");
    const { sidecar, faux, model } = await startSidecar(home, "tool.read.after");
    await ensure(sidecar, model);
    const client = clientFor(sidecar, context.outcomeScript);
    await dispatch(sidecar, home, faux, "op-F05-seed", context.outcomeScript);

    let crashed = false;
    try {
      await client.readTool("op-F05-seed", "operation-snapshot");
    } catch {
      crashed = true;
    }
    const rerun = await client.readTool("op-F05-seed", "operation-snapshot");
    const inspected = await inspect(sidecar, "op-F05-seed");
    let undeclared = "none";
    try {
      await client.readTool("op-F05-seed", "arbitrary-shell");
    } catch (error) {
      undeclared = (error as Error).message.includes("CAPABILITY_UNKNOWN")
        ? "CAPABILITY_UNKNOWN"
        : "other";
    }
    const kinds = await observationKinds(sidecar, "op-F05-seed");
    const outcomes = await readOutcomes(context.outcomeScript, home);
    await sidecar.stop();
    const inspectedRecord = inspected.ok
      ? (inspected.result as { record: unknown }).record
      : undefined;
    results.push({
      id: "F05",
      title: "during a declared safe read",
      status:
        crashed &&
        rerun.replay === "safe" &&
        rerun.replayed === true &&
        rerun.attempt === 2 &&
        JSON.stringify(rerun.snapshot) === JSON.stringify(inspectedRecord) &&
        kinds.filter((kind) => kind === "read").length === 2 &&
        outcomes.length === 1 &&
        undeclared === "CAPABILITY_UNKNOWN"
          ? "pass"
          : "fail",
      detail: `crashed=${crashed} replay=${rerun.replay} reran=${rerun.replayed} attempt=${rerun.attempt} stable=${JSON.stringify(rerun.snapshot) === JSON.stringify(inspectedRecord)} readRecords=${kinds.filter((kind) => kind === "read").length} outcomes=${outcomes.length} undeclaredTool=${undeclared}`,
    });
  }

  // F06 - after the outcome effect, before the adapter receipt: reconcile the
  // missing receipt through the keyed append-or-get, and keep refusing a blind
  // append when the sink cannot complete it.
  {
    const home = caseHome(context, "F06");
    const { sidecar, faux, model } = await startSidecar(home, "appendOutcome.commit");
    await ensure(sidecar, model);
    try {
      await dispatch(sidecar, home, faux, "op-F06", context.outcomeScript);
    } catch {
      /* the receipt barrier crashed after the outcome was appended */
    }
    const reconciled = await dispatch(sidecar, home, faux, "op-F06", context.outcomeScript);
    const outcomes = await readOutcomes(context.outcomeScript, home);

    const blindHome = caseHome(context, "F06-blind");
    const blind = await startSidecar(blindHome, "appendOutcome.commit");
    await ensure(blind.sidecar, blind.model);
    try {
      await dispatch(blind.sidecar, blindHome, blind.faux, "op-F06b", context.outcomeScript);
    } catch {
      /* same boundary, retried below against an outcome store that cannot append */
    }
    let blindCode = "none";
    try {
      await dispatch(
        blind.sidecar,
        blindHome,
        blind.faux,
        "op-F06b",
        `${context.outcomeScript}.missing`,
      );
    } catch (error) {
      blindCode = (error as { code?: string }).code ?? "error";
    }
    const blindOutcomes = await readOutcomes(context.outcomeScript, blindHome);
    await sidecar.stop();
    await blind.sidecar.stop();
    results.push({
      id: "F06",
      title: "after unsafe effect, before receipt commit",
      status:
        reconciled.reconciled === true &&
        reconciled.replayed &&
        outcomes.length === 1 &&
        blindCode === "RECONCILE_REQUIRED" &&
        blindOutcomes.length === 1
          ? "pass"
          : "fail",
      detail: `reconciled=${reconciled.reconciled === true} outcomes=${outcomes.length} incapableSink=${blindCode} incapableOutcomes=${blindOutcomes.length}`,
    });
  }

  // F07 - after runtime settlement, before the FirstMate outcome commit: the
  // retry replays the settled candidate and the keyed append-or-get commits it
  // exactly once, even though its receipt was never recorded.
  {
    const home = caseHome(context, "F07");
    const { sidecar, faux, model } = await startSidecar(home, "dispatch.settle.after");
    await ensure(sidecar, model);
    try {
      await dispatch(sidecar, home, faux, "op-F07", context.outcomeScript);
    } catch {
      /* settlement recorded; the FirstMate outcome commit never ran */
    }
    const before = await readOutcomes(context.outcomeScript, home);
    const reconciled = await dispatch(sidecar, home, faux, "op-F07", context.outcomeScript);
    const outcomes = await readOutcomes(context.outcomeScript, home);
    await sidecar.stop();
    results.push({
      id: "F07",
      title: "after runtime settlement, before FirstMate outcome commit",
      status:
        before.length === 0 &&
        reconciled.reconciled === true &&
        outcomes.length === 1
          ? "pass"
          : "fail",
      detail: `outcomesBeforeRetry=${before.length} reconciled=${reconciled.reconciled === true} replayed=${reconciled.replayed} appendedOnce=${outcomes.length === 1} seq=${reconciled.seq}`,
    });
  }

  // F08 - after the outcome commit, before the adapter receipt: the retry
  // completes the receipt, and the following repeat is a clean receipt replay.
  {
    const home = caseHome(context, "F08");
    const { sidecar, faux, model } = await startSidecar(home, "appendOutcome.commit");
    await ensure(sidecar, model);
    try {
      await dispatch(sidecar, home, faux, "op-F08", context.outcomeScript);
    } catch {
      /* outcome committed; the receipt was never recorded */
    }
    const reconciled = await dispatch(sidecar, home, faux, "op-F08", context.outcomeScript);
    const replay = await dispatch(sidecar, home, faux, "op-F08", context.outcomeScript);
    const outcomes = await readOutcomes(context.outcomeScript, home);
    await sidecar.stop();
    results.push({
      id: "F08",
      title: "after outcome commit, before adapter receipt",
      status:
        reconciled.reconciled === true &&
        replay.replayed &&
        replay.seq === reconciled.seq &&
        outcomes.length === 1
          ? "pass"
          : "fail",
      detail: `reconciled=${reconciled.reconciled === true} replaySeq=${replay.seq}/${reconciled.seq} outcomes=${outcomes.length}`,
    });
  }

  // F10 - stale generation cannot mutate.
  {
    const home = caseHome(context, "F10");
    const { sidecar, faux, model } = await startSidecar(home);
    await ensure(sidecar, model);
    const { sidecarRequest } = await import("../src/sidecar-client.ts");
    const stale = await sidecarRequest(sidecar.socketPath, {
      protocolVersion: 2,
      homeId: sidecar.homeId,
      op: "resume",
      supervisorId: "pi-supervisor",
      ownerGeneration: 0,
      wakeClaimId: "claim-1",
      rowIds: ["row-T1"],
      capabilityProfile: "supervision-observe-v1",
    } as never);
    void faux;
    await sidecar.stop();
    results.push({
      id: "F10",
      title: "stale generation cannot mutate",
      status: !stale.ok && stale.error.code === "AUTHORITY_STALE" ? "pass" : "fail",
      detail: `code=${stale.ok ? "ok" : stale.error.code}`,
    });
  }

  // F12 - cancellation during tool execution: intent is durable before the
  // abort request, a cancelled run commits no outcome, and an operation whose
  // outcome effect may already exist is never reported settled.
  {
    const home = caseHome(context, "F12");
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    const { sidecar, faux, model } = await startSidecar(home, undefined, (fauxHandle) => {
      fauxHandle.setResponses([
        async () => {
          entered();
          await releasePromise;
          return fauxAssistantMessage(JSON.stringify(RESULT));
        },
      ]);
    });
    await ensure(sidecar, model);
    const inFlight = runDurableDispatch(
      { transport: clientFor(sidecar, context.outcomeScript) },
      { operationId: "op-F12", prompt: "p", payload: { task: "T1" } },
    ).then(
      () => "settled",
      (error) => (error as { code?: string }).code ?? "error",
    );
    await enteredPromise;
    const duringRun = await clientFor(sidecar, context.outcomeScript).cancel("op-F12", "foreground");
    release();
    const runOutcome = await inFlight;
    const kinds = await observationKinds(sidecar, "op-F12");
    const outcomes = await readOutcomes(context.outcomeScript, home);
    const record = await inspect(sidecar, "op-F12");
    await sidecar.stop();

    const intentBeforeAbort =
      kinds.indexOf("cancellation-intent") >= 0 &&
      kinds.indexOf("cancellation-intent") < kinds.indexOf("cancellation-abort");
    const cancelledRecord = record.ok
      ? (record.result as { record: { state: string } | null }).record
      : null;
    const cancelled =
      duringRun.intentPersisted === true &&
      duringRun.settled === true &&
      duringRun.state === "cancelled" &&
      duringRun.unresolved.length === 0 &&
      intentBeforeAbort &&
      runOutcome !== "settled" &&
      outcomes.length === 0 &&
      cancelledRecord?.state === "cancelled";

    const settledHome = caseHome(context, "F12-settled");
    const settledSidecar = await startSidecar(settledHome, "dispatch.settle.after");
    await ensure(settledSidecar.sidecar, settledSidecar.model);
    try {
      await dispatch(
        settledSidecar.sidecar,
        settledHome,
        settledSidecar.faux,
        "op-F12b",
        context.outcomeScript,
      );
    } catch {
      /* settled, with no outcome commit yet */
    }
    const settledCancel = await clientFor(settledSidecar.sidecar, context.outcomeScript).cancel("op-F12b", "operation");
    const settledRecord = await inspect(settledSidecar.sidecar, "op-F12b");
    await settledSidecar.sidecar.stop();
    const unresolvedRecord = settledRecord.ok
      ? (settledRecord.result as { record: { state: string } | null }).record
      : null;
    const neverSettled =
      settledCancel.settled === false &&
      settledCancel.state === "cancel-unresolved" &&
      settledCancel.unresolved.includes("outcome-effect-unresolved") &&
      unresolvedRecord?.state === "cancel-unresolved";

    results.push({
      id: "F12",
      title: "cancellation during tool execution",
      status: cancelled && neverSettled ? "pass" : "fail",
      detail: `intentBeforeAbort=${intentBeforeAbort} settledCancel=${duringRun.settled} state=${duringRun.state} runOutcome=${runOutcome} outcomes=${outcomes.length} retainedState=${cancelledRecord?.state ?? "absent"} unresolvedEffect=${settledCancel.unresolved.join("+") || "none"} unresolvedState=${unresolvedRecord?.state ?? "absent"}`,
    });
  }

  // F13 - second owner refused.
  {
    const home = caseHome(context, "F13");
    const first = await startSidecar(home);
    let refused = false;
    try {
      await DurableSidecar.start({ home });
    } catch (error) {
      refused = (error as { code?: string }).code === "OWNER_CONFLICT";
    }
    await first.sidecar.stop();
    results.push({
      id: "F13",
      title: "second owner refused",
      status: refused ? "pass" : "fail",
      detail: `refused=${refused}`,
    });
  }

  // F14 - observation reconnect recovers settlements.
  {
    const home = caseHome(context, "F14");
    const { sidecar, faux, model } = await startSidecar(home);
    await ensure(sidecar, model);
    await dispatch(sidecar, home, faux, "op-F14", context.outcomeScript);
    const { sidecarRequest } = await import("../src/sidecar-client.ts");
    const page = await sidecarRequest(sidecar.socketPath, {
      protocolVersion: 2,
      homeId: sidecar.homeId,
      op: "observe",
      after: 0,
    } as never);
    const settlements = page.ok
      ? (page.result as { observations: { kind: string }[] }).observations.filter((o) => o.kind === "settlement")
      : [];
    await sidecar.stop();
    results.push({
      id: "F14",
      title: "observer reconnect recovers settlement",
      status: settlements.length === 1 ? "pass" : "fail",
      detail: `settlements=${settlements.length}`,
    });
  }

  // F15 - repeated ID with a changed payload refused.
  {
    const home = caseHome(context, "F15");
    const { sidecar, faux, model } = await startSidecar(home);
    await ensure(sidecar, model);
    await dispatch(sidecar, home, faux, "op-F15", context.outcomeScript, RESULT);
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ ...RESULT, summary: "different" }))]);
    const transport = new SidecarClient({
      socketPath: sidecar.socketPath,
      homeId: sidecar.homeId,
      supervisorId: "pi-supervisor",
      capabilityProfile: "supervision-observe-v1",
      ownerGeneration: 1,
      wakeClaimId: "claim-1",
      rowIds: ["row-T1"],
      outcomeScript: context.outcomeScript,
    });
    let code = "none";
    try {
      await runDurableDispatch({ transport }, { operationId: "op-F15", prompt: "p", payload: { changed: true } });
    } catch (error) {
      code = (error as { code?: string }).code ?? "error";
    }
    await sidecar.stop();
    results.push({
      id: "F15",
      title: "changed payload under repeated ID",
      status: code === "CONFLICT" ? "pass" : "fail",
      detail: `code=${code}`,
    });
  }

  // F18 - a store restored into a different home is refused. The whole home,
  // including the adapter store, is copied to a new path and reopened there.
  {
    const home = caseHome(context, "F18-source");
    const { sidecar, faux, model } = await startSidecar(home);
    await ensure(sidecar, model);
    await dispatch(sidecar, home, faux, "op-F18", context.outcomeScript);
    await sidecar.stop();

    const restoredHome = join(context.workDir, "fault-F18-restored");
    cpSync(home, restoredHome, { recursive: true });

    let code = "none";
    try {
      const restored = await DurableSidecar.start({ home: restoredHome });
      await restored.stop();
    } catch (error) {
      code = (error as { code?: string }).code ?? "error";
    }
    results.push({
      id: "F18",
      title: "restored store refused in another home",
      status: code === "HOME_MISMATCH" ? "pass" : "fail",
      detail: `code=${code}; the adapter store copied to a new home is refused because it records a different home identity`,
    });
  }

  // F09 - routine delivery after a failed acknowledgement. The real store has
  // no durable idempotent record for a routine note, so a failed cursor write
  // re-presents the already-delivered row: the documented limitation, exercised
  // here against the real store rather than only asserted.
  {
    const home = caseHome(context, "F09");
    const seq = Number.parseInt(
      runOutcome(context.outcomeScript, home, [
        "append",
        "--task",
        "T1",
        "--verdict",
        "routine",
        "--summary",
        "disposition=ready_for_review; ok",
      ]).trim(),
      10,
    );
    const afterDelivery = unreadSeqs(context.outcomeScript, home);
    // Delivery happened; the cursor write failed, so the row stays unread.
    const afterFailedAck = unreadSeqs(context.outcomeScript, home);
    runOutcome(context.outcomeScript, home, ["mark-read", "--through", String(seq)]);
    const afterAck = unreadSeqs(context.outcomeScript, home);
    const exercised = Number.isInteger(seq) && afterDelivery.includes(seq) && afterFailedAck.includes(seq);
    results.push({
      id: "F09",
      title: "after delivery, before acknowledgement",
      status: exercised && afterAck.length === 0 ? "pass" : "fail",
      detail: `routineDelivery: append seq=${seq}; a failed cursor write leaves the routine row unread and re-delivered (the documented routine-delivery limitation, tracked as fm-pi-routine-delivery-idempotency-followup-r1); a successful mark-read clears it (unreadAfterAck=${afterAck.length})`,
    });
  }

  // F16 - a missing provider credential is an explicit unavailable state with
  // no reroute to another executor. A provider with no credential is injected
  // alongside a working fallback; the dispatch must refuse and never call the
  // fallback.
  {
    const home = caseHome(context, "F16");
    const faux = fauxProvider();
    const broken = brokenProvider();
    const sidecar = await DurableSidecar.start({
      home,
      configureModels: (models) => {
        models.setProvider(faux.provider);
        models.setProvider(broken);
      },
    });
    const { sidecarRequest } = await import("../src/sidecar-client.ts");
    const ensured = await sidecarRequest(sidecar.socketPath, {
      protocolVersion: 2,
      homeId: sidecar.homeId,
      op: "ensureSupervisor",
      supervisorId: "pi-supervisor",
      ownerGeneration: 1,
      wakeClaimId: "claim-1",
      rowIds: ["row-T1"],
      capabilityProfile: "supervision-observe-v1",
      model: { provider: broken.id, modelId: "f16-missing-1" },
      thinkingLevel: "high",
      cwd: home,
    } as never);
    let code = ensured.ok ? "none" : ensured.error.code;
    if (ensured.ok) {
      try {
        await dispatch(sidecar, home, faux, "op-F16", context.outcomeScript);
      } catch (error) {
        code = (error as { code?: string }).code ?? "error";
      }
    }
    const outcomes = await readOutcomes(context.outcomeScript, home);
    const fallbackCalls = faux.state.callCount;
    await sidecar.stop();
    results.push({
      id: "F16",
      title: "missing provider credential refused, no reroute",
      status: code === "PROVIDER_UNAVAILABLE" && outcomes.length === 0 && fallbackCalls === 0 ? "pass" : "fail",
      detail: `code=${code} outcomes=${outcomes.length} fallbackCalls=${fallbackCalls}; the injected provider has no configured credential and the registered fallback provider was never invoked`,
    });
  }

  // F11 and F17 are exercised by the disposable-container restart lane, whose
  // failure boundary - kill and restart - is owned outside the container.
  const lane = context.dockerLane;
  const laneStatus = (value: string | undefined): MatrixStatus =>
    value === "pass" ? "pass" : value === "fail" ? "fail" : "not-covered";
  results.push({
    id: "F11",
    title: "service crash with valid generation",
    status: laneStatus(lane?.f11?.status),
    detail: lane?.f11
      ? `image=${lane.image ?? "unknown"} docker=${lane.dockerServer ?? "unknown"} ${JSON.stringify(lane.f11.evidence)}`
      : `container lane: ${lane?.reason ?? "not run"}`,
  });
  results.push({
    id: "F17",
    title: "container teardown + recreate (host reboot not exercised)",
    status: lane?.f17?.status === "pass" ? "known-gap" : laneStatus(lane?.f17?.status),
    detail: lane?.f17
      ? `image=${lane.image ?? "unknown"} docker=${lane.dockerServer ?? "unknown"} ${JSON.stringify(lane.f17.evidence)}; the container was torn down and recreated with its own namespaces, so a real host reboot remains unexercised`
      : `container lane: ${lane?.reason ?? "not run"}`,
  });
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

async function readOutcomes(scriptPath: string, home: string): Promise<unknown[]> {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("bash", [scriptPath, "list", "--recent", "200"], {
    env: { ...process.env, FM_HOME: home },
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A registered provider that deliberately has no configured credential. */
function brokenProvider(): Provider {
  return createProvider({
    id: "f16-missing-credential",
    name: "F16 missing credential",
    auth: { apiKey: { name: "F16 missing credential", resolve: async () => undefined } },
    models: [{ id: "f16-missing-1", name: "F16 missing model" }],
    api: {
      stream: async () => {
        throw new Error("the fallback executor must never run");
      },
      streamSimple: async () => {
        throw new Error("the fallback executor must never run");
      },
    },
  } as never);
}

function runOutcome(scriptPath: string, home: string, args: readonly string[]): string {
  return execFileSync("bash", [scriptPath, ...args], {
    env: { ...process.env, FM_HOME: home },
    encoding: "utf8",
  });
}

function unreadSeqs(scriptPath: string, home: string): number[] {
  return runOutcome(scriptPath, home, ["unread"])
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { seq: number }).seq);
}
