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
import { createOutcomeSink } from "../src/outcome-sink.ts";
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
  });
  const sink = createOutcomeSink({
    scriptPath: outcomeScript,
    env: { ...process.env, FM_HOME: home },
  });
  const dispatchInput = {
    operationId: "fm:home:supervision:claim-3:3",
    prompt: "supervise",
    payload: { rows: ["row-1"], generation: 3 },
  };

  const first = await runDurableDispatch({ transport, sink }, dispatchInput);
  assert.deepEqual(first, { seq: 1, replayed: false });

  const replay = await runDurableDispatch({ transport, sink }, dispatchInput);
  assert.deepEqual(replay, { seq: 1, replayed: true });

  const store = readFileSync(join(home, "state", "branch-outcomes.jsonl"), "utf8").trim().split("\n");
  assert.equal(store.length, 1);
  assert.equal((JSON.parse(store[0]!) as { summary: string }).summary, "all clear");
});
