/**
 * Focused test for the disposable-container teardown lane.
 *
 * The lane's real behavior needs a Docker daemon and the lane image, so this
 * test runs the lane when Docker is reachable and otherwise records an honest
 * skip. It never turns a missing daemon into a fabricated pass.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { runDockerLane } from "../eval/docker-lane.ts";

function dockerServerVersion(): string | null {
  try {
    const out = execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

test("the lane reports an honest not-covered record when explicitly skipped", async () => {
  const previous = process.env.FM_PI_DURABLE_SKIP_DOCKER;
  process.env.FM_PI_DURABLE_SKIP_DOCKER = "1";
  try {
    const result = await runDockerLane();
    assert.equal(result.status, "not-covered");
    assert.match(result.reason ?? "", /skipped/);
  } finally {
    if (previous === undefined) delete process.env.FM_PI_DURABLE_SKIP_DOCKER;
    else process.env.FM_PI_DURABLE_SKIP_DOCKER = previous;
  }
});

test("the lane tears down and recreates the container with an explicit lock reclaim", async (t) => {
  if (!dockerServerVersion()) {
    t.skip("no Docker daemon is reachable");
    return;
  }

  const result = await runDockerLane();
  if (result.status === "not-covered") {
    t.skip(`the lane is not covered here: ${result.reason ?? "unknown reason"}`);
    return;
  }

  assert.equal(result.status, "pass", result.reason ?? "the lane failed");
  assert.equal(result.f11?.status, "pass");
  assert.equal(result.f17?.status, "pass");
  assert.equal(result.lockReclaim?.required, true);
  assert.equal(result.lockReclaim?.reclaimed, true);
  assert.ok(
    typeof result.lockReclaim?.staleOwnerPid === "number",
    "the reclaimed lock records the stale owner pid",
  );

  const evidence = result.f17?.evidence ?? {};
  assert.equal(evidence.containerRemoved, true);
  assert.equal(evidence.lockReclaimed, true);
  assert.equal(evidence.storeReopened, true);
  assert.equal(evidence.authorityReconciled, true);
});
