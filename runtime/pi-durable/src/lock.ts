/**
 * Single-owner store lock (P1A).
 *
 * The upstream Durable SQLite provider has no cross-process ownership guard
 * (see docs/pi-durable/05-p0-source-verification.md), so the sidecar owns this
 * lock itself. Exactly one owner process may hold the lock for a canonical
 * FM_HOME; a second acquire is refused rather than silently sharing the store.
 *
 * Mechanism: the complete owner record is written to a unique sibling file
 * first and then published with link(2). link is atomic and exclusive on the
 * supported platforms (Node on Linux and macOS), so a competitor always sees
 * either no lock or a fully written lock, never the empty metadata window an
 * O_EXCL create followed by a separate write leaves open. A stale lock is
 * reclaimed by renaming it to a unique sibling name - rename is atomic, so
 * exactly one reclaimer wins - and then verifying the claimed record before
 * removing it. No flock(2) or external lock manager is assumed.
 *
 * A lock that exists but carries no valid owner record is treated as live
 * until it is older than INVALID_LOCK_GRACE_MS: a half-published lock is never
 * a valid one, and reclaiming it early could hand the store to two owners.
 */

import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** How long an unreadable lock file is respected before it is reclaimed. */
export const INVALID_LOCK_GRACE_MS = 30_000;

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

type LockRead =
  | { kind: "missing" }
  | { kind: "valid"; info: LockFile }
  | { kind: "invalid"; ageMs: number };

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

function parseLock(text: string): LockFile | null {
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
    // A corrupt lock is treated as unreadable below.
  }
  return null;
}

function readLock(path: string, now: () => number): LockRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { kind: "missing" };
  }
  const info = parseLock(text);
  if (info) return { kind: "valid", info };
  return { kind: "invalid", ageMs: now() - mtimeMs };
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
   * Reclaims a lock whose owner is gone, or an unreadable lock older than the
   * invalid-lock grace period.
   */
  static acquire(path: string, homeId: string, now: () => number = Date.now): OwnerLock {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const info: OwnerInfo = { homeId, pid: process.pid, startedAt: now() };
      const nonce = randomUUID();
      const tmp = `${path}.new.${process.pid}.${nonce}`;
      writeFileSync(tmp, JSON.stringify({ ...info, nonce }), { mode: 0o600, flag: "wx" });
      try {
        try {
          linkSync(tmp, path);
          return new OwnerLock(path, info, nonce);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const current = readLock(path, now);
          if (current.kind === "valid" && isProcessAlive(current.info.pid)) {
            throw new OwnerConflictError(
              `store already owned by live process ${current.info.pid} for home ${current.info.homeId}`,
            );
          }
          if (current.kind === "invalid" && current.ageMs < INVALID_LOCK_GRACE_MS) {
            throw new OwnerConflictError(
              `store lock at ${path} exists without readable owner metadata; refusing to reclaim a fresh lock`,
            );
          }
          OwnerLock.claimStale(path, current, nonce, now);
        }
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          // Already gone; nothing to clean.
        }
      }
    }
    throw new OwnerConflictError(`could not acquire store lock at ${path}`);
  }

  /**
   * Remove one stale lock if this caller wins the atomic rename race.
   *
   * Returns after either reclaiming the stale record or losing to another
   * reclaimer; the caller then retries the link publish.
   */
  private static claimStale(path: string, current: LockRead, nonce: string, now: () => number): void {
    const claimed = `${path}.stale.${nonce}`;
    try {
      renameSync(path, claimed);
    } catch {
      // Another process reclaimed or released it first; retry the publish.
      return;
    }
    const renamed = readLock(claimed, now);
    const expectedNonce = current.kind === "valid" ? current.info.nonce : null;
    if (
      (expectedNonce === null && renamed.kind !== "valid") ||
      (expectedNonce !== null && renamed.kind === "valid" && renamed.info.nonce === expectedNonce)
    ) {
      try {
        unlinkSync(claimed);
      } catch {
        // Already removed; nothing to do.
      }
      return;
    }
    // The renamed record is not the one this caller inspected. Never delete
    // it: put it back best-effort (without clobbering a newer lock) and let
    // the retry observe the real owner.
    try {
      linkSync(claimed, path);
    } catch {
      // A newer lock is already in place; leave it.
    }
    try {
      unlinkSync(claimed);
    } catch {
      // Already gone.
    }
  }

  /** Release the lock only when this owner still holds it. */
  release(): void {
    if (this.released) return;
    this.released = true;
    const released = `${this.path}.release.${this.nonce}`;
    try {
      renameSync(this.path, released);
    } catch {
      // Already removed or replaced; nothing to release.
      return;
    }
    const renamed = readLock(released, Date.now);
    if (renamed.kind === "valid" && renamed.info.nonce === this.nonce) {
      try {
        unlinkSync(released);
      } catch {
        // Already removed; nothing to do.
      }
      return;
    }
    // Another owner's lock was renamed by mistake; restore it without
    // clobbering a newer lock and leave it held by its real owner.
    try {
      linkSync(released, this.path);
    } catch {
      // A newer lock is already in place; leave it.
    }
    try {
      unlinkSync(released);
    } catch {
      // Already gone.
    }
  }
}

/** Overwrite a lock file with non-secret owner metadata (test/support helper). */
export function writeLockFile(path: string, info: OwnerInfo): void {
  writeFileSync(path, JSON.stringify({ ...info, nonce: randomUUID() }), { mode: 0o600 });
}
