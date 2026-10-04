/**
 * Host half of the disposable-container restart lane.
 *
 * Runs `eval/docker-lane.sh`, which owns the failure boundary outside the
 * container, and returns its verdict. When the lane cannot run here - no Docker
 * daemon, no image, or an explicit skip - the result is an honest not-covered
 * record with the reason, never a fabricated pass.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type DockerLaneCase = {
  status: string;
  case: string;
  evidence: Record<string, unknown>;
};

export type DockerLaneResult = {
  status: "pass" | "fail" | "not-covered";
  reason?: string;
  image?: string | null;
  dockerServer?: string | null;
  commands?: string[];
  f11?: DockerLaneCase;
  f17?: DockerLaneCase;
};

const scriptPath = join(fileURLToPath(new URL(".", import.meta.url)), "docker-lane.sh");

export async function runDockerLane(): Promise<DockerLaneResult> {
  if (process.env.FM_PI_DURABLE_SKIP_DOCKER) {
    return { status: "not-covered", reason: "the container lane was skipped for this run" };
  }

  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn("bash", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stderr.on("data", (chunk: string) => (err += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ code: status, stdout: out, stderr: err }));
  });

  try {
    return JSON.parse(stdout) as DockerLaneResult;
  } catch {
    const detail = (stderr.trim() || stdout.trim()).slice(0, 200);
    return {
      status: "not-covered",
      reason: `the container lane produced no verdict (exit ${code ?? "none"}): ${detail}`,
    };
  }
}
