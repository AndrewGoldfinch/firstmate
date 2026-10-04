/**
 * Single-owner store lock tests: refusal, stale reclaim, and cross-process
 * exclusion.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { OwnerConflictError, OwnerLock, writeLockFile } from "../src/lock.ts";

const scratch = mkdtempSync(join(tmpdir(), "fm-pi-durable-lock-"));
const holdLock = fileURLToPath(new URL("./helpers/hold-lock.ts", import.meta.url));

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
