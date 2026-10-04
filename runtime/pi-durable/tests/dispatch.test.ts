/**
 * P1C sidecar dispatch tests: execute one accepted supervision operation on the
 * pinned conversation, return its candidate result, replay a settled repeat,
 * require reconciliation for an unsettled repeat, and record the mirrored
 * outcome receipt.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DurableSidecar } from "../src/service.ts";
import type { DispatchResult, EnsureSupervisorResult } from "../src/protocol.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { call } from "./helpers/client.ts";
import { dispatchRequest, ensureSupervisorRequest, receiptRequest } from "./helpers/requests.ts";

const homes: string[] = [];
const sidecars: DurableSidecar[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-pi-durable-dispatch-"));
  homes.push(home);
  return home;
}

function errorCode(response: unknown): string | undefined {
  const parsed = response as { ok: boolean; error?: { code: string } };
  return parsed.ok ? undefined : parsed.error?.code;
}

after(async () => {
  for (const sidecar of sidecars) await sidecar.stop();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("dispatch executes the pinned conversation and returns its candidate result", async () => {
  const home = tempHome();
  const faux = fauxProvider();
  const model = faux.models[0]!;
  const sidecar = await DurableSidecar.start({
    home,
    configureModels: (models) => models.setProvider(faux.provider),
  });
  sidecars.push(sidecar);

  const ensured = await call(
    sidecar.socketPath,
    ensureSupervisorRequest({
      homeId: sidecar.homeId,
      cwd: home,
      model: { provider: model.provider, modelId: model.id },
    }),
  );
  assert.equal((ensured as { ok: boolean }).ok, true);
  assert.equal(
    (ensured as { ok: true; result: EnsureSupervisorResult }).result.conversationId.length > 0,
    true,
  );

  faux.setResponses([fauxAssistantMessage('{"verdict":"routine","summary":"all clear"}')]);
  const dispatched = await call(
    sidecar.socketPath,
    dispatchRequest({
      homeId: sidecar.homeId,
      cwd: home,
      operationId: "op-dispatch-1",
      prompt: "supervise",
      payload: { rows: ["row-1"], generation: 1 },
    }),
  );
  assert.equal((dispatched as { ok: boolean }).ok, true);
  const result = (dispatched as { ok: true; result: DispatchResult }).result;
  assert.deepEqual(result.result, { verdict: "routine", summary: "all clear" });
  assert.equal(result.replayed, false);
  assert.equal(result.record.state, "settled");

  // A settled repeat returns the original result and never re-executes.
  faux.setResponses([fauxAssistantMessage('{"verdict":"captain","summary":"different"}')]);
  const replayed = await call(
    sidecar.socketPath,
    dispatchRequest({
      homeId: sidecar.homeId,
      cwd: home,
      operationId: "op-dispatch-1",
      prompt: "supervise",
      payload: { rows: ["row-1"], generation: 1 },
    }),
  );
  const replayResult = (replayed as { ok: true; result: DispatchResult }).result;
  assert.equal(replayResult.replayed, true);
  assert.deepEqual(replayResult.result, { verdict: "routine", summary: "all clear" });

  const receipt = await call(sidecar.socketPath, receiptRequest(sidecar.homeId, "op-dispatch-1", 7));
  assert.equal((receipt as { ok: boolean }).ok, true);
  const inspected = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "inspect",
    operationId: "op-dispatch-1",
  });
  assert.deepEqual((inspected as { ok: true; result: { record: { receipt: unknown } } }).result.record.receipt, {
    seq: 7,
  });
});

test("dispatch refuses stale authority before executing", async () => {
  const home = tempHome();
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
      generation: 5,
      model: { provider: model.provider, modelId: model.id },
    }),
  );

  const stale = await call(
    sidecar.socketPath,
    dispatchRequest({
      homeId: sidecar.homeId,
      cwd: home,
      generation: 4,
      operationId: "op-stale",
      prompt: "supervise",
      payload: {},
    }),
  );
  assert.equal(errorCode(stale), "AUTHORITY_STALE");
  assert.equal(faux.getPendingResponseCount(), 0);
});

test("a malformed candidate result is refused and the operation stays unresolved", async () => {
  const home = tempHome();
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

  faux.setResponses([fauxAssistantMessage("this is not json")]);
  const malformed = await call(
    sidecar.socketPath,
    dispatchRequest({
      homeId: sidecar.homeId,
      cwd: home,
      operationId: "op-malformed",
      prompt: "supervise",
      payload: {},
    }),
  );
  assert.equal((malformed as { ok: boolean }).ok, false);
  assert.equal(errorCode(malformed), "INTERNAL");

  // The operation was accepted but not settled, so a retry requires reconciliation.
  faux.setResponses([fauxAssistantMessage('{"verdict":"routine","summary":"ok"}')]);
  const retry = await call(
    sidecar.socketPath,
    dispatchRequest({
      homeId: sidecar.homeId,
      cwd: home,
      operationId: "op-malformed",
      prompt: "supervise",
      payload: {},
    }),
  );
  assert.equal(errorCode(retry), "RECONCILE_REQUIRED");
});
