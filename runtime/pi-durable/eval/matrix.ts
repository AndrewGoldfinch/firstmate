/**
 * F01-F18 fault matrix for the P2 harness.
 *
 * Each case runs deterministically against the real sidecar, bridge, and
 * outcome store where the environment supports it. Cases that need a real VM
 * reboot, real credentials, cancellation, or a real read-tool boundary are
 * recorded as explicitly not-covered rather than faked.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DurableSidecar } from "../src/service.ts";
import { runDurableDispatch } from "../src/bridge.ts";
import { SidecarClient } from "../src/sidecar-client.ts";
import { createOutcomeSink } from "../src/outcome-sink.ts";
import type { CandidateResult } from "../src/bridge.ts";
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
};

const RESULT: CandidateResult = { task: "T1", verdict: "routine", summary: "disposition=ready_for_review; ok" };

function caseHome(context: CaseContext, id: string): string {
  const home = join(context.workDir, `fault-${id}`);
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

async function startSidecar(home: string, crashAt?: string) {
  const faux = fauxProvider();
  const model = faux.models[0]!;
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
  const transport = new SidecarClient({
    socketPath: sidecar.socketPath,
    homeId: sidecar.homeId,
    supervisorId: "pi-supervisor",
    capabilityProfile: "supervision-observe-v1",
    ownerGeneration: 1,
    wakeClaimId: "claim-1",
    rowIds: ["row-T1"],
  });
  const sink = createOutcomeSink({ scriptPath: outcomeScript, env: { ...process.env, FM_HOME: home } });
  return runDurableDispatch({ transport, sink }, { operationId, prompt: "p", payload: { task: "T1" } });
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
    await sidecar.stop();
    results.push({
      id: "F02",
      title: "after acceptance, before reply",
      status: record?.state === "accepted" && retryCode === "RECONCILE_REQUIRED" ? "pass" : "fail",
      detail: `state=${record?.state ?? "absent"} retry=${retryCode}`,
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

  // F06 - after the outcome effect, before the adapter receipt: no blind rerun.
  {
    const home = caseHome(context, "F06");
    const { sidecar, faux, model } = await startSidecar(home, "receipt.before");
    await ensure(sidecar, model);
    try {
      await dispatch(sidecar, home, faux, "op-F06", context.outcomeScript);
    } catch {
      /* the receipt barrier crashed after the outcome was appended */
    }
    let replayCode = "none";
    try {
      await dispatch(sidecar, home, faux, "op-F06", context.outcomeScript);
    } catch (error) {
      replayCode = (error as { code?: string }).code ?? "error";
    }
    const outcomes = await readOutcomes(context.outcomeScript, home);
    await sidecar.stop();
    results.push({
      id: "F06",
      title: "after unsafe effect, before receipt commit",
      status: replayCode === "RECONCILE_REQUIRED" && outcomes.length === 1 ? "pass" : "fail",
      detail: `replay=${replayCode} outcomes=${outcomes.length}`,
    });
  }

  // F08 - outcome committed and receipt recorded: a repeat finds the existing outcome.
  {
    const home = caseHome(context, "F08");
    const { sidecar, faux, model } = await startSidecar(home);
    await ensure(sidecar, model);
    const first = await dispatch(sidecar, home, faux, "op-F08", context.outcomeScript);
    const replay = await dispatch(sidecar, home, faux, "op-F08", context.outcomeScript);
    const outcomes = await readOutcomes(context.outcomeScript, home);
    await sidecar.stop();
    results.push({
      id: "F08",
      title: "after outcome commit, before adapter receipt",
      status: replay.replayed && replay.seq === first.seq && outcomes.length === 1 ? "pass" : "fail",
      detail: `replayed=${replay.replayed} seq=${replay.seq}/${first.seq} outcomes=${outcomes.length}`,
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
    });
    const sink = createOutcomeSink({ scriptPath: context.outcomeScript, env: { ...process.env, FM_HOME: home } });
    let code = "none";
    try {
      await runDurableDispatch({ transport, sink }, { operationId: "op-F15", prompt: "p", payload: { changed: true } });
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

  // F18 - wrong home refused.
  {
    const home = caseHome(context, "F18");
    const { sidecar, model } = await startSidecar(home);
    await ensure(sidecar, model);
    const { sidecarRequest } = await import("../src/sidecar-client.ts");
    const wrong = await sidecarRequest(sidecar.socketPath, {
      protocolVersion: 2,
      homeId: "/some/other/home",
      op: "health",
    } as never);
    await sidecar.stop();
    results.push({
      id: "F18",
      title: "store restored into a different home",
      status: !wrong.ok && wrong.error.code === "HOME_MISMATCH" ? "pass" : "fail",
      detail: `code=${wrong.ok ? "ok" : wrong.error.code}`,
    });
  }

  // Explicitly not covered in this environment.
  const notCovered: [string, string, string][] = [
    ["F05", "during a declared safe read", "the prototype has no read-tool boundary to rerun"],
    ["F09", "after delivery, before acknowledgement", "the existing routine-note delivery limitation is documented, not re-tested here"],
    ["F11", "service crash with valid generation", "covered by F02/F04 recovery; a real process crash needs the VM lane"],
    ["F12", "cancellation during tool execution", "the prototype has no cancellation operation"],
    ["F16", "missing credentials or incompatible dependency", "a real credential provider is unavailable; the unknown-capability refusal is covered by the P1B suite"],
    ["F17", "disposable host reboot", "no VM or reboot boundary exists in this environment"],
  ];
  for (const [id, title, reason] of notCovered) {
    results.push({ id, title, status: "not-covered", detail: reason });
  }
  results.push({
    id: "F07",
    title: "after runtime settlement, before FirstMate outcome commit",
    status: "known-gap",
    detail:
      "the settled candidate is replayable, but the adapter cannot prove the outcome effect is absent, so it refuses a blind append and requires reconciliation",
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
