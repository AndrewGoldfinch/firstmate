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

const PROBE_RECENT = 200;

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

/** The outcome row fields the read-back can see and match on. */
type OutcomeRow = { seq?: unknown; task?: unknown; verdict?: unknown; summary?: unknown };

/**
 * Build an outcome sink that appends through `bin/fm-branch-outcome.sh`.
 *
 * `probe` reads the same store back through `list`, so a settled result whose
 * receipt was never recorded can be reconciled instead of blindly appended.
 * It matches on the row identity the store exposes (task, verdict, summary);
 * two distinct operations that commit identical rows are indistinguishable,
 * which the evaluation report records as the remaining ceiling.
 */
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
    async probe(result: CandidateResult): Promise<number | null> {
      const { code, stdout, stderr } = await runOutcomeScript(options, [
        options.scriptPath,
        "list",
        "--recent",
        String(PROBE_RECENT),
      ]);
      if (code !== 0) {
        throw new Error(
          `fm-branch-outcome.sh list exited ${code ?? "none"}: ${stderr.trim()}`,
        );
      }
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const row = JSON.parse(line) as OutcomeRow;
        if (
          row.task !== result.task ||
          row.verdict !== result.verdict ||
          row.summary !== result.summary
        ) {
          continue;
        }
        if (typeof row.seq !== "number") {
          throw new Error("fm-branch-outcome.sh list returned a matching row without a numeric seq");
        }
        return row.seq;
      }
      return null;
    },
  };
}
