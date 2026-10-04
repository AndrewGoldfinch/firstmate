/**
 * Single-owner store lock (P1A).
 *
 * The upstream Durable SQLite provider has no cross-process ownership guard
 * (see docs/pi-durable/05-p0-source-verification.md), so the sidecar owns this
 * lock itself. Exactly one owner process may hold the lock for a canonical
 * FM_HOME; a second acquire is refused rather than silently sharing the store.
 *
 * The lock is a private file created with O_EXCL, so the create is atomic on a
 * single host. A lock whose recorded process is gone is reclaimed as stale.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

export type OwnerInfo = {
  homeId: string;
  pid: number;
  startedAt: number;
};

export class OwnerConflictError extends Error {
  readonly code = "OWNER_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "OwnerConflictError";
  }
}

type LockFile = OwnerInfo & { nonce: string };

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to another user.
    return code === "EPERM";
  }
}

function readLock(path: string): LockFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockFile>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.homeId === "string" &&
      typeof parsed.nonce === "string"
    ) {
      return {
        pid: parsed.pid,
        homeId: parsed.homeId,
        nonce: parsed.nonce,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
    }
  } catch {
    // A corrupt lock is treated as stale below.
  }
  return null;
}

/** A held single-owner store lock. Release it exactly once. */
export class OwnerLock {
  readonly info: OwnerInfo;
  readonly path: string;

  private readonly nonce: string;
  private released = false;

  private constructor(path: string, info: OwnerInfo, nonce: string) {
    this.path = path;
    this.info = info;
    this.nonce = nonce;
  }

  /**
   * Acquire the lock at `path` for `homeId`.
   *
   * Refuses with OwnerConflictError when another live process holds it.
   * Reclaims a lock whose owner is gone.
   */
  static acquire(path: string, homeId: string, now: () => number = Date.now): OwnerLock {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const info: OwnerInfo = { homeId, pid: process.pid, startedAt: now() };
      const nonce = randomUUID();
      let fd: number;
      try {
        fd = openSync(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = readLock(path);
        if (existing && isProcessAlive(existing.pid)) {
          throw new OwnerConflictError(
            `store already owned by live process ${existing.pid} for home ${existing.homeId}`,
          );
        }
        try {
          unlinkSync(path);
        } catch {
          // Another process may have reclaimed it first; retry once.
        }
        continue;
      }
      try {
        const payload: LockFile = { ...info, nonce };
        writeSync(fd, JSON.stringify(payload));
      } finally {
        closeSync(fd);
      }
      return new OwnerLock(path, info, nonce);
    }
    throw new OwnerConflictError(`could not acquire store lock at ${path}`);
  }

  /** Release the lock only when this owner still holds it. */
  release(): void {
    if (this.released) return;
    this.released = true;
    const existing = readLock(this.path);
    if (existing && existing.pid === this.info.pid && existing.nonce === this.nonce) {
      try {
        unlinkSync(this.path);
      } catch {
        // Already removed; nothing to do.
      }
    }
  }
}

/** Overwrite a lock file with non-secret owner metadata (test/support helper). */
export function writeLockFile(path: string, info: OwnerInfo): void {
  writeFileSync(path, JSON.stringify({ ...info, nonce: randomUUID() }), { mode: 0o600 });
}
