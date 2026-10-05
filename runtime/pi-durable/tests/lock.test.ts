/**
 * Single-owner store lock tests: refusal, stale reclaim, and cross-process
 * exclusion.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { INVALID_LOCK_GRACE_MS, OwnerConflictError, OwnerLock, writeLockFile } from "../src/lock.ts";

const scratch = mkdtempSync(join(tmpdir(), "fm-pi-durable-lock-"));
const holdLock = fileURLToPath(new URL("./helpers/hold-lock.ts", import.meta.url));
const churnLock = fileURLToPath(new URL("./helpers/churn-lock.ts", import.meta.url));

/**
 * Start `count` hold-lock children at once and report each outcome. A child
 * that acquires prints `locked` and stays alive; the others exit refused. Any
 * survivor is killed once every child has answered, so exactly one `locked`
 * outcome proves a single winner across the whole race.
 */
async function raceHoldLock(path: string, count: number): Promise<string[]> {
  const children = Array.from({ length: count }, () =>
    spawn(process.execPath, [holdLock, path, "/home/a"], { stdio: ["ignore", "pipe", "pipe"] }),
  );
  const outcomes = await Promise.all(
    children.map(
      (child) =>
        new Promise<string>((resolve) => {
          let locked = false;
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            if (chunk.includes("locked")) {
              locked = true;
              resolve("locked");
            }
          });
          child.on("error", () => resolve("error"));
          child.on("exit", (code) => resolve(locked ? "locked" : code === 0 ? "exited" : "refused"));
        }),
    ),
  );
  const survivors = children.filter((child) => child.exitCode === null);
  for (const child of survivors) child.kill("SIGTERM");
  await Promise.all(survivors.map((child) => new Promise<void>((resolve) => child.on("exit", () => resolve()))));
  return outcomes;
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a second owner in the same process is refused", () => {
  const path = join(scratch, "same-process.lock");
  const first = OwnerLock.acquire(path, "/home/a");
  try {
    assert.throws(
      () => OwnerLock.acquire(path, "/home/a"),
      (error: unknown) => error instanceof OwnerConflictError,
    );
  } finally {
    first.release();
  }
  // After release the lock is reusable.
  const again = OwnerLock.acquire(path, "/home/a");
  again.release();
});

test("a lock whose owner is gone is reclaimed", () => {
  const path = join(scratch, "stale.lock");
  // PID 0 is never a live user process for kill(0) purposes on Linux.
  writeLockFile(path, { homeId: "/home/a", pid: 0, startedAt: 0 });
  const lock = OwnerLock.acquire(path, "/home/a");
  assert.equal(lock.info.pid, process.pid);
  lock.release();
});

test("a live owner in another OS process is refused", async () => {
  const path = join(scratch, "cross-process.lock");
  const child = spawn(process.execPath, [holdLock, path, "/home/a"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not lock in time")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (chunk.includes("locked")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early with ${code}`));
    });
  });

  try {
    assert.throws(
      () => OwnerLock.acquire(path, "/home/a"),
      (error: unknown) => error instanceof OwnerConflictError,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  }

  // The child released on SIGTERM, so the parent can now acquire.
  const lock = OwnerLock.acquire(path, "/home/a");
  lock.release();
});

test("simultaneous starts produce exactly one owner", async () => {
  const path = join(scratch, "simultaneous-start.lock");
  const outcomes = await raceHoldLock(path, 8);
  assert.equal(outcomes.filter((outcome) => outcome === "locked").length, 1, outcomes.join(","));
  // The winner was killed rather than released; its dead pid is reclaimed.
  const lock = OwnerLock.acquire(path, "/home/a");
  lock.release();
});

test("simultaneous stale reclaims produce exactly one owner", async () => {
  const path = join(scratch, "simultaneous-reclaim.lock");
  writeLockFile(path, { homeId: "/home/a", pid: 0, startedAt: 0 });
  const outcomes = await raceHoldLock(path, 8);
  assert.equal(outcomes.filter((outcome) => outcome === "locked").length, 1, outcomes.join(","));
  const lock = OwnerLock.acquire(path, "/home/a");
  lock.release();
});

test("an empty lock is respected while fresh and reclaimed once old", () => {
  const path = join(scratch, "empty.lock");
  writeFileSync(path, "");
  assert.throws(
    () => OwnerLock.acquire(path, "/home/a"),
    (error: unknown) => error instanceof OwnerConflictError,
  );
  const old = new Date(Date.now() - INVALID_LOCK_GRACE_MS - 1_000);
  utimesSync(path, old, old);
  const lock = OwnerLock.acquire(path, "/home/a");
  lock.release();
});

/**
 * Sustained multi-process race. Each worker holds and re-acquires repeatedly
 * and re-reads the published record while it holds the lock, reporting a steal
 * if the record ever names another process. The single-burst races above do not
 * exercise the turnover that lets a reclaim observe a missing file and disturb
 * a live owner, so this test drives sustained churn instead.
 *
 * Regression for the store-owner lock granting two processes the same lock.
 */
test("sustained churn never grants two owners the same lock", async () => {
  const path = join(scratch, "sustained-churn.lock");
  // Seed a stale record (dead pid) so the opening rounds race a reclaim.
  writeLockFile(path, { homeId: "/home/a", pid: 0, startedAt: 0 });
  const workers = 24;
  const children = Array.from({ length: workers }, () =>
    spawn(process.execPath, [churnLock, path, "/home/a", "2500", "1"], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const outputs = await Promise.all(
    children.map(
      (child) =>
        new Promise<string>((resolve) => {
          let out = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => (out += chunk));
          child.on("error", () => resolve(out));
          child.on("exit", () => resolve(out));
        }),
    ),
  );
  const steals = outputs
    .join("\n")
    .split("\n")
    .filter((line) => line.startsWith("STEAL "));
  assert.deepEqual(steals, [], `sustained churn observed a second owner: ${steals.join("; ")}`);
  // The lock is still usable after the storm.
  const lock = OwnerLock.acquire(path, "/home/a");
  lock.release();
});
