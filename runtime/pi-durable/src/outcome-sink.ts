/**
 * Outcome sink adapter (P1C).
 *
 * Shells out to the existing FirstMate outcome store, `bin/fm-branch-outcome.sh`,
 * so the durable path writes the same durable record through the same owner as
 * the existing branch. The bridge never acknowledges wake rows or mutates the
 * task lifecycle; it only appends the candidate result.
 */

import { spawn } from "node:child_process";
import type { CandidateResult, OutcomeSink } from "./bridge.ts";

export type OutcomeSinkOptions = {
  scriptPath: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

/** Build an outcome sink that appends through `bin/fm-branch-outcome.sh`. */
export function createOutcomeSink(options: OutcomeSinkOptions): OutcomeSink {
  return {
    async append(result: CandidateResult): Promise<number> {
      const args = [
        options.scriptPath,
        "append",
        "--task",
        result.task,
        "--verdict",
        result.verdict,
        "--summary",
        result.summary,
      ];
      if (result.wake !== undefined) args.push("--wake", result.wake);
      if (result.silent !== undefined) args.push("--silent", String(result.silent));

      const { code, stdout, stderr } = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn("bash", args, {
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
