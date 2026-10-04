/**
 * P1D bounded-observation tests: a durable outbox with a cursor, delivery
 * receipts committed before the cursor advances, gap refusal, and no duplicate
 * fleet transitions.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DurableSidecar } from "../src/service.ts";
import type { ObserveResult } from "../src/protocol.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { call } from "./helpers/client.ts";
import {
  dispatchRequest,
  ensureSupervisorRequest,
  observeAckRequest,
  observeRequest,
  receiptRequest,
  submitRequest,
} from "./helpers/requests.ts";

const homes: string[] = [];
const sidecars: DurableSidecar[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-pi-durable-observe-"));
  homes.push(home);
  return home;
}

function errorCode(response: unknown): string | undefined {
  const parsed = response as { ok: boolean; error?: { code: string } };
  return parsed.ok ? undefined : parsed.error?.code;
}

function observed(response: unknown): ObserveResult {
  assert.equal((response as { ok: boolean }).ok, true);
  return (response as { ok: true; result: ObserveResult }).result;
}

async function startDurable(home: string) {
  const faux = fauxProvider();
  const model = faux.models[0]!;
  const sidecar = await DurableSidecar.start({
    home,
    configureModels: (models) => models.setProvider(faux.provider),
  });
  sidecars.push(sidecar);
  await call(
    sidecar.socketPath,
    ensureSupervisorRequest({
      homeId: sidecar.homeId,
      cwd: home,
      model: { provider: model.provider, modelId: model.id },
    }),
  );
  return { sidecar, faux };
}

function candidate(summary: string) {
  return fauxAssistantMessage(JSON.stringify({ task: "task-1", verdict: "routine", summary }));
}

after(async () => {
  for (const sidecar of sidecars) await sidecar.stop();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("a subscriber reconnects after missed observations and recovers every undelivered settlement", async () => {
  const home = tempHome();
  const { sidecar, faux } = await startDurable(home);
  faux.setResponses([candidate("first"), candidate("second")]);
  for (const id of ["op-1", "op-2"]) {
    const response = await call(
      sidecar.socketPath,
      dispatchRequest({ homeId: sidecar.homeId, cwd: home, operationId: id, prompt: "p", payload: { id } }),
    );
    assert.equal((response as { ok: boolean }).ok, true);
  }

  // The subscriber saw the page but crashed before acknowledging anything.
  const firstPage = observed(await call(sidecar.socketPath, observeRequest(sidecar.homeId, 0)));
  const settlements = firstPage.observations.filter((observation) => observation.kind === "settlement");
  assert.equal(settlements.length, 2);

  // Reconnect from the same cursor: every settlement is still undelivered.
  const reconnect = observed(await call(sidecar.socketPath, observeRequest(sidecar.homeId, 0)));
  assert.deepEqual(
    reconnect.observations.filter((observation) => observation.kind === "settlement").map((o) => o.operationId),
    ["op-1", "op-2"],
  );

  // Commit the receipts, then advance the cursor, then observe nothing new.
  for (const settlement of settlements) {
    assert.equal((await call(sidecar.socketPath, receiptRequest(sidecar.homeId, settlement.operationId!, settlement.seq))).ok, true);
  }
  assert.equal((await call(sidecar.socketPath, observeAckRequest(sidecar.homeId, reconnect.cursor))).ok, true);
  const afterAck = observed(await call(sidecar.socketPath, observeRequest(sidecar.homeId)));
  assert.deepEqual(afterAck.observations, []);
});

test("a snapshot is not treated as task success", async () => {
  const home = tempHome();
  const { sidecar } = await startDurable(home);

  // An accepted-but-undispatched operation is not a settlement.
  assert.equal((await call(sidecar.socketPath, submitRequest(sidecar.homeId, "op-accepted", { a: 1 }))).ok, true);
  const inspected = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "inspect",
    operationId: "op-accepted",
  });
  assert.equal((inspected as { ok: true; result: { record: { state: string } } }).result.record.state, "accepted");
  const page = observed(await call(sidecar.socketPath, observeRequest(sidecar.homeId, 0)));
  assert.equal(page.observations.some((observation) => observation.kind === "settlement"), false);
});

test("a failed execution is an unresolved observation, never a settlement", async () => {
  const home = tempHome();
  const { sidecar, faux } = await startDurable(home);
  faux.setResponses([fauxAssistantMessage("not json")]);
  const failed = await call(
    sidecar.socketPath,
    dispatchRequest({ homeId: sidecar.homeId, cwd: home, operationId: "op-failed", prompt: "p", payload: {} }),
  );
  assert.equal(failed.ok, false);
  const page = observed(await call(sidecar.socketPath, observeRequest(sidecar.homeId, 0)));
  const kinds = page.observations.map((observation) => observation.kind);
  assert.equal(kinds.includes("unresolved"), true);
  assert.equal(kinds.includes("settlement"), false);
});

test("a duplicate settled result does not produce a duplicate observation", async () => {
  const home = tempHome();
  const { sidecar, faux } = await startDurable(home);
  faux.setResponses([candidate("once")]);
  const request = dispatchRequest({
    homeId: sidecar.homeId,
    cwd: home,
    operationId: "op-once",
    prompt: "p",
    payload: {},
  });
  assert.equal((await call(sidecar.socketPath, request)).ok, true);
  assert.equal((await call(sidecar.socketPath, request)).ok, true);
  const page = observed(await call(sidecar.socketPath, observeRequest(sidecar.homeId, 0)));
  const settlements = page.observations.filter((observation) => observation.operationId === "op-once" && observation.kind === "settlement");
  assert.equal(settlements.length, 1);
});

test("the cursor cannot advance past a settlement without its receipt", async () => {
  const home = tempHome();
  const { sidecar, faux } = await startDurable(home);
  faux.setResponses([candidate("receipt gate")]);
  assert.equal(
    (await call(sidecar.socketPath, dispatchRequest({ homeId: sidecar.homeId, cwd: home, operationId: "op-gate", prompt: "p", payload: {} }))).ok,
    true,
  );
  const page = observed(await call(sidecar.socketPath, observeRequest(sidecar.homeId, 0)));
  const settlement = page.observations.find((observation) => observation.kind === "settlement")!;
  assert.equal(errorCode(await call(sidecar.socketPath, observeAckRequest(sidecar.homeId, settlement.seq))), "RECEIPT_REQUIRED");
  assert.equal((await call(sidecar.socketPath, receiptRequest(sidecar.homeId, "op-gate", settlement.seq))).ok, true);
  assert.equal((await call(sidecar.socketPath, observeAckRequest(sidecar.homeId, settlement.seq))).ok, true);
  assert.equal(errorCode(await call(sidecar.socketPath, observeAckRequest(sidecar.homeId, 0))), "CURSOR_INVALID");
});
