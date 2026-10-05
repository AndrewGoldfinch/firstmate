/**
 * Container half of the disposable-container teardown lane (F11 and F17).
 *
 * `serve` prepares one supervisor and one settled operation, prints its
 * evidence, and stays alive so the host can SIGKILL and remove the container.
 * `verify` reopens the same home in a fresh container - with its own
 * namespaces, including its own pid namespace - and checks that the runtime
 * store and the recorded authority binding survived the boundary.
 *
 * The failure boundary - kill, remove, recreate - is owned by the host, outside
 * the container. Nothing here simulates a crash; it is one. This is a container
 * and process boundary, not a host-kernel reboot: the store file and the kernel
 * are the same, and the host reclaims the stale ownership lock explicitly
 * because the recorded owner pid is not a reliable liveness signal across pid
 * namespaces.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runDurableDispatch } from "../src/bridge.ts";
import { DurableSidecar } from "../src/service.ts";
import { SidecarClient, sidecarRequest } from "../src/sidecar-client.ts";

const [mode, homeArg, outcomeScript] = process.argv.slice(2);
const home = homeArg ?? "";
const authority = {
  supervisorId: "pi-supervisor",
  capabilityProfile: "supervision-observe-v1",
  ownerGeneration: 1,
  wakeClaimId: "claim-1",
  rowIds: ["row-T1"],
};

function emit(prefix: string, value: unknown): void {
  process.stdout.write(`${prefix} ${JSON.stringify(value)}\n`);
}

async function startSidecar() {
  mkdirSync(join(home, "state"), { recursive: true });
  const faux = fauxProvider();
  const model = faux.models[0]!;
  const sidecar = await DurableSidecar.start({
    home,
    configureModels: (models) => models.setProvider(faux.provider),
  });
  return { sidecar, faux, model };
}

async function ensure(
  sidecar: DurableSidecar,
  model: { provider: string; id: string },
  generation = authority.ownerGeneration,
) {
  return await sidecarRequest(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "ensureSupervisor",
    ...authority,
    ownerGeneration: generation,
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "high",
    cwd: home,
  } as never);
}

async function serve(): Promise<void> {
  const { sidecar, faux, model } = await startSidecar();
  const ensured = await ensure(sidecar, model);
  if (!ensured.ok) throw new Error(`ensureSupervisor refused: ${ensured.error.code}`);
  const identity = ensured.result as { conversationId: string; created: boolean; generation: number };

  faux.setResponses([
    fauxAssistantMessage(
      JSON.stringify({
        task: "T1",
        verdict: "routine",
        summary: "disposition=ready_for_review; ok",
      }),
    ),
  ]);
  const transport = new SidecarClient({
    socketPath: sidecar.socketPath,
    homeId: sidecar.homeId,
    ...authority,
    outcomeScript: outcomeScript ?? "",
  });
  const dispatched = await runDurableDispatch(
    { transport },
    { operationId: "op-restart", prompt: "p", payload: { task: "T1" } },
  );
  const health = await sidecarRequest(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "health",
  } as never);

  emit("SERVE_STATE", {
    node: process.version,
    pid: process.pid,
    homeId: sidecar.homeId,
    conversationId: identity.conversationId,
    generation: identity.generation,
    seq: dispatched.seq,
    storePath: health.ok ? (health.result as { store: { path: string } }).store.path : null,
  });
  process.stdout.write("SERVE_READY\n");
  // Hold the store open until the host kills this container.
  await new Promise(() => {});
}

async function verify(): Promise<void> {
  const { sidecar, model } = await startSidecar();
  const health = await sidecarRequest(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "health",
  } as never);
  const again = await ensure(sidecar, model);
  const stale = await ensure(sidecar, model, 0);
  const inspected = await sidecarRequest(sidecar.socketPath, {
    protocolVersion: 2,
    homeId: sidecar.homeId,
    op: "inspect",
    operationId: "op-restart",
  } as never);
  const record = inspected.ok
    ? (inspected.result as { record: { state: string; receipt: { seq: number } | null } | null }).record
    : null;
  const listed = await new Promise<string>((resolve, reject) => {
    const child = spawnList();
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });

  const result = {
    node: process.version,
    pid: process.pid,
    homeId: sidecar.homeId,
    storePath: health.ok ? (health.result as { store: { path: string } }).store.path : null,
    created: again.ok ? (again.result as { created: boolean }).created : null,
    conversationId: again.ok ? (again.result as { conversationId: string }).conversationId : null,
    generation: again.ok ? (again.result as { generation: number }).generation : null,
    staleCode: stale.ok ? "ok" : stale.error.code,
    operationState: record?.state ?? null,
    receiptSeq: record?.receipt?.seq ?? null,
    outcomeRows: listed.split("\n").filter((line) => line.trim().length > 0).length,
  };
  await sidecar.stop();
  emit("VERIFY_RESULT", result);
}

function spawnList() {
  return spawn("bash", [outcomeScript ?? "", "list", "--recent", "200"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const run = mode === "verify" ? verify : serve;
run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
