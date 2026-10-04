// Supervision execution-provider selection and durable-branch spawn.
//
// The existing in-process Pi branch is the default. The durable sidecar is
// selected only by an explicit local config value, so an unconfigured home
// keeps the current path unchanged. The sidecar package lives outside this
// extension's import graph, so the durable path runs the bridge CLI as a
// subprocess. `runtime/pi-durable/src/selection.ts` owns the same config value
// for the CLI side; keep the two in step.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ExecutionProvider = "existing" | "pi-durable";

export const EXECUTION_PROVIDER_FILE = "supervision-execution";

/** Private directory and files for the durable wake-batch identity. */
export const DURABLE_STATE_SUBDIR = "pi-durable";
export const WAKE_BATCH_FILE = "wake-batch.json";
export const WAKE_BATCH_COMPLETED_FILE = "wake-batch-completed";

type WakeBatchRecord = {
  key: string;
  batch: number;
  operationId: string;
};

/**
 * Durable identity for one accepted wake batch.
 *
 * The batch key names the wake scope: ownership generation, wake claim, and
 * the sorted row set. A persisted batch with the same key that has not been
 * marked complete is the retry of an interrupted dispatch, so it keeps its
 * operation id; a new or completed batch gets a fresh random id. The id is
 * persisted before the dispatch, so a process restart can neither reuse an id
 * for a new batch nor lose the id of a batch that is still retrying.
 */
export function durableWakeOperationId(input: {
  stateDir: string;
  homeId: string;
  generation: number;
  wakeClaimId: string;
  rowIds: readonly string[];
}): { operationId: string; batch: number } {
  const dir = join(input.stateDir, DURABLE_STATE_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const key = [
    String(input.generation),
    input.wakeClaimId,
    [...input.rowIds].sort().join(","),
  ].join("\u0000");
  const batchPath = join(dir, WAKE_BATCH_FILE);
  const completedPath = join(dir, WAKE_BATCH_COMPLETED_FILE);
  const pending = readWakeBatch(batchPath);
  let completed = "";
  try {
    completed = readFileSync(completedPath, "utf8").trim();
  } catch {
    completed = "";
  }
  if (pending && pending.key === key && completed !== pending.operationId) {
    return { operationId: pending.operationId, batch: pending.batch };
  }
  const batch = (pending?.batch ?? 0) + 1;
  const operationId = `fm:${input.homeId}:supervision:batch-${batch}:${randomUUID()}`;
  writeAtomic(batchPath, `${JSON.stringify({ key, batch, operationId })}\n`);
  return { operationId, batch };
}

/** Mark one dispatched batch complete so its next wake mints a new identity. */
export function markDurableWakeCompleted(stateDir: string, operationId: string): void {
  const dir = join(stateDir, DURABLE_STATE_SUBDIR);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, WAKE_BATCH_COMPLETED_FILE), `${operationId}\n`);
}

function readWakeBatch(path: string): WakeBatchRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WakeBatchRecord>;
    if (
      typeof parsed.key === "string" &&
      typeof parsed.batch === "number" &&
      Number.isInteger(parsed.batch) &&
      typeof parsed.operationId === "string"
    ) {
      return { key: parsed.key, batch: parsed.batch, operationId: parsed.operationId };
    }
  } catch {
    // A missing or corrupt record is a new batch.
  }
  return null;
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

/**
 * Read the configured execution provider.
 *
 * Absent or empty selects `existing`. An unrecognized value is refused rather
 * than silently falling back.
 */
export function readExecutionProvider(configDir: string): ExecutionProvider {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, EXECUTION_PROVIDER_FILE), "utf8").trim();
  } catch {
    return "existing";
  }
  if (raw === "" || raw === "existing") return "existing";
  if (raw === "pi-durable") return "pi-durable";
  throw new Error(
    `unknown supervision execution provider ${JSON.stringify(raw)} (expected existing or pi-durable)`,
  );
}

export type DurableBranchRequest = {
  socketPath: string;
  homeId: string;
  supervisorId: string;
  capabilityProfile: string;
  ownerGeneration: number;
  wakeClaimId: string;
  rowIds: string[];
  operationId: string;
  prompt: string;
  payload: unknown;
  outcomeScript: string;
};

export type DurableBranchResult = { seq: number; replayed: boolean };

/** Run the durable dispatch bridge as a subprocess and return its result. */
export function runDurableBranch(
  cliPath: string,
  request: DurableBranchRequest,
): Promise<DurableBranchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`durable bridge exited ${code ?? "none"}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as DurableBranchResult);
      } catch {
        reject(new Error(`durable bridge returned invalid JSON: ${stdout.trim()}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
