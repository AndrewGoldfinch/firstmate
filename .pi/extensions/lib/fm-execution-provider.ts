// Supervision execution-provider selection and durable-branch spawn.
//
// The existing in-process Pi branch is the default. The durable sidecar is
// selected only by an explicit local config value, so an unconfigured home
// keeps the current path unchanged. The sidecar package lives outside this
// extension's import graph, so the durable path runs the bridge CLI as a
// subprocess. `runtime/pi-durable/src/selection.ts` owns the same config value
// for the CLI side; keep the two in step.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ExecutionProvider = "existing" | "pi-durable";

export const EXECUTION_PROVIDER_FILE = "supervision-execution";

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
