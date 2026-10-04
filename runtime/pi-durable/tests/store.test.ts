/**
 * Store migration test: a supervisors table created by P1A is upgraded in
 * place, preserving the recorded conversation mapping.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { OperationStore } from "../src/store.ts";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-pi-durable-store-"));
  homes.push(home);
  return home;
}

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("a P1A supervisors table is migrated in place", () => {
  const path = join(tempHome(), "operations.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE supervisors (
      home_id TEXT NOT NULL,
      supervisor_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (home_id, supervisor_id)
    );
  `);
  legacy.prepare("INSERT INTO supervisors VALUES (?, ?, ?, ?)").run("/h", "s", "7", 1);
  legacy.close();

  const store = new OperationStore(path);
  const migrated = store.getSupervisorBinding("/h", "s");
  assert.equal(migrated?.conversationId, "7");
  assert.equal(migrated?.generation, 0);
  assert.deepEqual(migrated?.rowIds, []);
  assert.equal(migrated?.capabilityProfile, "");

  store.putSupervisorBinding({
    homeId: "/h",
    supervisorId: "s",
    conversationId: "8",
    generation: 3,
    wakeClaimId: "claim-3",
    rowIds: ["row-1"],
    capabilityProfile: "supervision-observe-v1",
    configDigest: "d",
    agent: null,
    createdAt: 1,
    updatedAt: 2,
  });
  const updated = store.getSupervisorBinding("/h", "s");
  assert.equal(updated?.conversationId, "8");
  assert.equal(updated?.generation, 3);
  assert.deepEqual(updated?.rowIds, ["row-1"]);
  store.close();
});
