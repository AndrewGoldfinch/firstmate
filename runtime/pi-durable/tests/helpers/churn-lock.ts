/**
 * Test helper: churn the sidecar store lock in a separate OS process so the
 * parent test can prove mutual exclusion under sustained turnover.
 *
 * While this process believes it holds the lock it re-reads the published owner
 * record and reports `STEAL <pid>` if the record ever names another process (or
 * is missing). That is the invariant a correct lock must never break.
 *
 * Usage: node churn-lock.ts <lock-path> <home-id> <duration-ms> <max-delay-ms>
 * Prints one `STEAL <pid>` line per violation, then `STEALS <n> HELD <n>`.
 */

import { readFileSync } from "node:fs";
import { OwnerConflictError, OwnerLock } from "../../src/lock.ts";

const [lockPathArg, homeIdArg, durationRaw, delayRaw] = process.argv.slice(2);
if (!lockPathArg || !homeIdArg) {
  process.stderr.write("usage: churn-lock.ts <lock-path> <home-id> <duration-ms> <max-delay-ms>\n");
  process.exit(2);
}
const lockPath: string = lockPathArg;
const homeId: string = homeIdArg;
const durationMs = Number.parseInt(durationRaw ?? "2000", 10);
const maxDelayMs = Number.parseInt(delayRaw ?? "1", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const deadline = Date.now() + durationMs;
  let steals = 0;
  let held = 0;
  while (Date.now() < deadline) {
    let lock: OwnerLock;
    try {
      lock = OwnerLock.acquire(lockPath, homeId);
    } catch (error) {
      if (error instanceof OwnerConflictError) {
        await sleep(Math.random() * maxDelayMs + 0.2);
        continue;
      }
      throw error;
    }
    held += 1;
    for (let probe = 0; probe < 3; probe += 1) {
      let pid: number | null = null;
      try {
        pid = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid ?? null;
      } catch {
        pid = null;
      }
      if (pid !== process.pid) {
        process.stdout.write(`STEAL ${pid ?? "missing"}\n`);
        steals += 1;
      }
      await sleep(Math.random() * maxDelayMs * 0.5);
    }
    lock.release();
  }
  process.stdout.write(`STEALS ${steals} HELD ${held}\n`);
}

void main();
