/**
 * Test helper: hold the sidecar store lock in a separate OS process so the
 * parent test can prove cross-process refusal.
 *
 * Usage: node hold-lock.ts <lock-path> <home-id>
 * Prints "locked" once held, then stays alive until killed.
 */

import { OwnerLock } from "../../src/lock.ts";

const [lockPath, homeId] = process.argv.slice(2);
if (!lockPath || !homeId) {
  process.stderr.write("usage: hold-lock.ts <lock-path> <home-id>\n");
  process.exit(2);
}

const lock = OwnerLock.acquire(lockPath, homeId);
process.stdout.write("locked\n");

function release(): void {
  lock.release();
  process.exit(0);
}

process.on("SIGTERM", release);
process.on("SIGINT", release);
setInterval(() => {}, 1000);
