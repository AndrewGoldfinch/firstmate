/**
 * P1C end-to-end bridge test: a real sidecar (faux model), the real socket
 * client, and the real FirstMate outcome store (`bin/fm-branch-outcome.sh`).
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DurableSidecar } from "../src/service.ts";
import { runDurableDispatch } from "../src/bridge.ts";
import { SidecarClient } from "../src/sidecar-client.ts";
import { call } from "./helpers/client.ts";
import { ensureSupervisorRequest } from "./helpers/requests.ts";

const homes: string[] = [];
const sidecars: DurableSidecar[] = [];
const outcomeScript = fileURLToPath(new URL("../../../bin/fm-branch-outcome.sh", import.meta.url));

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-pi-durable-bridge-"));
  mkdirSync(join(home, "state"), { recursive: true });
  homes.push(home);
  return home;
}

after(async () => {
  for (const sidecar of sidecars) await sidecar.stop();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("a durable dispatch appends one outcome and a settled repeat appends none", async () => {
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
      generation: 3,
      wakeClaimId: "claim-3",
      rowIds: ["row-1"],
      model: { provider: model.provider, modelId: model.id },
    }),
  );
  assert.equal((ensured as { ok: boolean }).ok, true);

  faux.setResponses([fauxAssistantMessage('{"task":"task-1","verdict":"routine","summary":"all clear"}')]);
  const transport = new SidecarClient({
    socketPath: sidecar.socketPath,
    homeId: sidecar.homeId,
    supervisorId: "pi-supervisor",
    capabilityProfile: "supervision-observe-v1",
    ownerGeneration: 3,
    wakeClaimId: "claim-3",
    rowIds: ["row-1"],
    outcomeScript,
  });
  const dispatchInput = {
    operationId: "fm:home:supervision:claim-3:3",
    prompt: "supervise",
    payload: { rows: ["row-1"], generation: 3 },
  };

  const first = await runDurableDispatch({ transport }, dispatchInput);
  assert.deepEqual(first, { seq: 1, replayed: false });

  const replay = await runDurableDispatch({ transport }, dispatchInput);
  assert.deepEqual(replay, { seq: 1, replayed: true });

  const store = readFileSync(join(sidecar.homeId, "state", "branch-outcomes.jsonl"), "utf8").trim().split("\n");
  assert.equal(store.length, 1);
  assert.equal((JSON.parse(store[0]!) as { summary: string }).summary, "all clear");
});

/**
 * Regression for the stale-append window: a replacement racing the outcome
 * append must serialize behind the sidecar's ownership lock, so the append and
 * its receipt commit together under the old generation and no stale row is
 * ever left behind.
 */
test("a replacement racing the outcome append never leaves a stale row", async () => {
  const home = tempHome();
  const faux = fauxProvider();
  const model = faux.models[0]!;
  const operationId = "fm:home:supervision:claim-1:race";
  let replacement: Promise<unknown> | null = null;
  let injected = false;
  let sidecar: DurableSidecar;
  sidecar = await DurableSidecar.start({
    home,
    configureModels: (models) => models.setProvider(faux.provider),
    barriers: async (name) => {
      if (name !== "appendOutcome.before" || injected) return;
      injected = true;
      // Fire the replacement while the sidecar holds the ownership lock. It
      // must queue behind the append rather than land inside it.
      replacement = call(
        sidecar.socketPath,
        ensureSupervisorRequest({
          homeId: sidecar.homeId,
          cwd: home,
          generation: 2,
          wakeClaimId: "claim-1",
          rowIds: ["row-1"],
          model: { provider: model.provider, modelId: model.id },
        }),
      );
    },
  });
  sidecars.push(sidecar);
  const ensured = await call(
    sidecar.socketPath,
    ensureSupervisorRequest({
      homeId: sidecar.homeId,
      cwd: home,
      generation: 1,
      wakeClaimId: "claim-1",
      rowIds: ["row-1"],
      model: { provider: model.provider, modelId: model.id },
    }),
  );
  assert.equal((ensured as { ok: boolean }).ok, true);

  faux.setResponses([
    fauxAssistantMessage('{"task":"task-1","verdict":"routine","summary":"all clear"}'),
  ]);
  const transport = new SidecarClient({
    socketPath: sidecar.socketPath,
    homeId: sidecar.homeId,
    supervisorId: "pi-supervisor",
    capabilityProfile: "supervision-observe-v1",
    ownerGeneration: 1,
    wakeClaimId: "claim-1",
    rowIds: ["row-1"],
    outcomeScript,
  });
  const result = await runDurableDispatch(
    { transport },
    { operationId, prompt: "supervise", payload: { rows: ["row-1"], generation: 1 } },
  );
  await replacement;
  assert.equal(injected, true, "the append barrier never fired");

  assert.deepEqual(result, { seq: 1, replayed: false });
  const store = readFileSync(join(sidecar.homeId, "state", "branch-outcomes.jsonl"), "utf8").trim().split("\n");
  assert.equal(store.length, 1);
  const inspected = await call(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "inspect",
    operationId,
  });
  assert.equal(inspected.ok, true);
  if (!inspected.ok) throw new Error("inspect failed");
  const record = (inspected.result as { record: { receipt: unknown } | null }).record;
  assert.ok(record && record.receipt !== null, "a stale row must never be left without its receipt");
});
