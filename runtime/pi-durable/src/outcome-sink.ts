/**
 * Outcome sink adapter (P1C).
 *
 * Shells out to the existing FirstMate outcome store, `bin/fm-branch-outcome.sh`,
 * so the durable path writes the same durable record through the same owner as
 * the existing branch. Every durable append carries the sidecar operation id
 * as the store's operation key, which makes the script's append an atomic
 * append-or-return-existing: a retried operation, or two distinct operations
 * with identical text, can never collide or duplicate. The bridge never
 * acknowledges wake rows or mutates the task lifecycle; it only appends the
 * candidate result.
 */

import { spawn } from "node:child_process";
import type { CandidateResult, OutcomeSink } from "./bridge.ts";

export type OutcomeSinkOptions = {
  scriptPath: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

/** Bound on the store-visible operation key; matches fm-branch-outcome.sh. */
export const MAX_OPERATION_KEY_CHARS = 256;

function assertOperationKey(key: string): void {
  if (key.length === 0 || key.length > MAX_OPERATION_KEY_CHARS || /[\t\n\r]/.test(key)) {
    throw new Error(
      `operation key must be a non-empty value of at most ${MAX_OPERATION_KEY_CHARS} characters without control characters`,
    );
  }
}

type ScriptRun = { code: number | null; stdout: string; stderr: string };

/** Run one `bin/fm-branch-outcome.sh` subcommand and capture its streams. */
async function runOutcomeScript(
  options: OutcomeSinkOptions,
  args: readonly string[],
): Promise<ScriptRun> {
  return await new Promise<ScriptRun>((resolve, reject) => {
    const child = spawn("bash", [...args], {
      env: options.env ?? process.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stderr.on("data", (chunk: string) => (err += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ code: status, stdout: out, stderr: err }));
  });
}

/**
 * Build an outcome sink that appends through `bin/fm-branch-outcome.sh` under
 * the operation key. The script owns the atomic append-or-return-existing
 * semantics; this adapter only transports the key and validates it at the
 * trust boundary.
 */
export function createOutcomeSink(options: OutcomeSinkOptions): OutcomeSink {
  return {
    async appendOrGet(operationKey: string, result: CandidateResult): Promise<number> {
      assertOperationKey(operationKey);
      const args = [
        options.scriptPath,
        "append",
        "--task",
        result.task,
        "--verdict",
        result.verdict,
        "--summary",
        result.summary,
        "--operation-key",
        operationKey,
      ];
      if (result.wake !== undefined) args.push("--wake", result.wake);
      if (result.silent !== undefined) args.push("--silent", String(result.silent));

      const { code, stdout, stderr } = await runOutcomeScript(options, args);
      if (code !== 0) {
        throw new Error(
          `fm-branch-outcome.sh append exited ${code ?? "none"}: ${stderr.trim()}`,
        );
      }
      const seq = Number.parseInt(stdout.trim(), 10);
      if (!Number.isInteger(seq) || seq < 0) {
        throw new Error(`fm-branch-outcome.sh append returned a non-numeric sequence: ${stdout.trim()}`);
      }
      return seq;
    },
  };
}
