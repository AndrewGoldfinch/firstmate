/**
 * Milestone verification (reviewer's recommended end-to-end run).
 *
 * Drives two successive wakes through the extension's own durable-branch
 * spawn path and a real sidecar, plus an execution crash with resume and an
 * ownership replacement, then independently verifies the outcome store:
 * exactly one outcome per accepted operation, no stale append, and distinct
 * operation identities.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DurableSidecar } from "../src/service.ts";
import { call } from "./helpers/client.ts";
import { ensureSupervisorRequest } from "./helpers/requests.ts";

const extensionLib = (await import(
  fileURLToPath(new URL("../../../.pi/extensions/lib/fm-execution-provider.ts", import.meta.url))
)) as {
  durableWakeOperationId: (input: {
    stateDir: string;
    homeId: string;
    generation: number;
    wakeClaimId: string;
    rowIds: readonly string[];
  }) => { operationId: string; batch: number };
  markDurableWakeCompleted: (stateDir: string, operationId: string) => void;
  runDurableBranch: (
    cliPath: string,
    request: Record<string, unknown>,
  ) => Promise<{ seq: number; replayed: boolean }>;
};
const { durableWakeOperationId, markDurableWakeCompleted, runDurableBranch } = extensionLib;

const bridgeCli = fileURLToPath(new URL("../src/bridge-cli.ts", import.meta.url));
const outcomeScript = fileURLToPath(new URL("../../../bin/fm-branch-outcome.sh", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "fm-pi-durable-milestone-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function readRows(home: string): { seq: number; operationKey?: string }[] {
  const out = execFileSync("bash", [outcomeScript, "list", "--recent", "50"], {
    env: { ...process.env, FM_HOME: home },
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("two wakes, a crash-resume, and an ownership replacement settle exactly one outcome each", async () => {
  const home = join(scratch, "home");
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });
  const faux = fauxProvider();
  const model = faux.models[0]!;
  let mode: "none" | "crash" | "replace" = "none";
  let sidecar: DurableSidecar;
  sidecar = await DurableSidecar.start({
    home,
    configureModels: (models) => models.setProvider(faux.provider),
    barriers: async (name) => {
      if (name !== "dispatch.model.after") return;
      if (mode === "crash") {
        mode = "none";
        throw new Error("simulated execution crash");
      }
      if (mode === "replace") {
        mode = "none";
        await call(
          sidecar.socketPath,
          ensureSupervisorRequest({
            homeId: sidecar.homeId,
            cwd: home,
            generation: 2,
            wakeClaimId: "gen-1",
            rowIds: ["1", "2", "3", "4"],
            model: { provider: model.provider, modelId: model.id },
          }),
        );
      }
    },
  });

  try {
    const ensured = await call(
      sidecar.socketPath,
      ensureSupervisorRequest({
        homeId: sidecar.homeId,
        cwd: home,
        wakeClaimId: "gen-1",
        rowIds: ["1", "2", "3", "4"],
        model: { provider: model.provider, modelId: model.id },
      }),
    );
    assert.equal((ensured as { ok: boolean }).ok, true);

    const previousHome = process.env.FM_HOME;
    process.env.FM_HOME = home;
    const dispatchWake = async (operationId: string, prompt: string) =>
      runDurableBranch(bridgeCli, {
        socketPath: sidecar.socketPath,
        homeId: sidecar.homeId,
        supervisorId: "pi-supervisor",
        capabilityProfile: "supervision-observe-v1",
        ownerGeneration: 1,
        wakeClaimId: "gen-1",
        rowIds: ["1"],
        operationId,
        prompt,
        payload: { rows: [1], generation: 1 },
        outcomeScript,
      });

    try {
      // Two successive wakes in one session: distinct identities, one outcome each.
      const first = durableWakeOperationId({
        stateDir,
        homeId: home,
        generation: 1,
        wakeClaimId: "gen-1",
        rowIds: ["1"],
      });
      faux.setResponses([fauxAssistantMessage('{"task":"task-1","verdict":"routine","summary":"wake one"}')]);
      const firstResult = await dispatchWake(first.operationId, "wake one");
      assert.equal(firstResult.seq, 1);
      markDurableWakeCompleted(stateDir, first.operationId);

      const second = durableWakeOperationId({
        stateDir,
        homeId: home,
        generation: 1,
        wakeClaimId: "gen-1",
        rowIds: ["2"],
      });
      assert.notEqual(second.operationId, first.operationId);
      faux.setResponses([fauxAssistantMessage('{"task":"task-2","verdict":"routine","summary":"wake two"}')]);
      const secondResult = await dispatchWake(second.operationId, "wake two");
      assert.equal(secondResult.seq, 2);
      markDurableWakeCompleted(stateDir, second.operationId);

      // Execution crash after acceptance: the same batch identity resumes and
      // settles exactly one outcome on retry.
      const crashed = durableWakeOperationId({
        stateDir,
        homeId: home,
        generation: 1,
        wakeClaimId: "gen-1",
        rowIds: ["3"],
      });
      faux.setResponses([fauxAssistantMessage('{"task":"task-3","verdict":"routine","summary":"wake three"}')]);
      mode = "crash";
      await assert.rejects(() => dispatchWake(crashed.operationId, "wake three"));
      const retry = durableWakeOperationId({
        stateDir,
        homeId: home,
        generation: 1,
        wakeClaimId: "gen-1",
        rowIds: ["3"],
      });
      assert.equal(retry.operationId, crashed.operationId);
      const retryResult = await dispatchWake(retry.operationId, "wake three");
      assert.equal(retryResult.replayed, false);
      markDurableWakeCompleted(stateDir, retry.operationId);

      // Ownership replacement: the stale operation must not append or receipt.
      const replaced = durableWakeOperationId({
        stateDir,
        homeId: home,
        generation: 1,
        wakeClaimId: "gen-1",
        rowIds: ["4"],
      });
      faux.setResponses([fauxAssistantMessage('{"task":"task-4","verdict":"routine","summary":"stale"}')]);
      mode = "replace";
      await assert.rejects(
        () => dispatchWake(replaced.operationId, "wake four"),
        (error: unknown) => String(error).includes("behind the recorded generation"),
      );
      const stale = await call(sidecar.socketPath, {
        protocolVersion: 2,
        homeId: sidecar.homeId,
        op: "inspect",
        operationId: replaced.operationId,
      });
      const staleRecord = (stale as { ok: true; result: { record: { state: string; receipt: unknown } } })
        .result.record;
      assert.equal(staleRecord.state, "accepted");
      assert.equal(staleRecord.receipt, null);

      // Independent read-back of the store: exactly one row per accepted
      // operation, distinct keys, gap-free sequence, and nothing for the stale
      // operation.
      const rows = readRows(home);
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((row) => row.operationKey).sort(),
        [first.operationId, second.operationId, retry.operationId].sort(),
      );
      assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3]);
    } finally {
      if (previousHome === undefined) delete process.env.FM_HOME;
      else process.env.FM_HOME = previousHome;
    }
  } finally {
    await sidecar.stop();
  }
});
