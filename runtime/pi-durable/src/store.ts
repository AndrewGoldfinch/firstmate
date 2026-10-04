/**
 * Adapter-owned durable store (P1A).
 *
 * This store records operation acceptance only: identity, state, and the
 * payload and configuration digests. It never records a raw payload, so no
 * request value - secret or otherwise - can appear in the store file.
 *
 * It is deliberately separate from the upstream Durable conversation store
 * (`runtime.sqlite`): FirstMate and runtime stores are separate transaction
 * domains (docs/pi-durable/02-architecture.md), and this adapter must not read
 * Durable's internal tables.
 */

import { DatabaseSync } from "node:sqlite";
import type { OperationRecord } from "./protocol.ts";

type OperationRow = {
  operation_id: string;
  home_id: string;
  supervisor_id: string;
  state: string;
  payload_digest: string;
  config_digest: string;
  row_ids_json: string;
  owner_generation: number | null;
  wake_claim_id: string | null;
  created_at: number;
  updated_at: number;
};

type SupervisorRow = {
  conversation_id: string;
  created_at: number;
};

function toRecord(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    homeId: row.home_id,
    supervisorId: row.supervisor_id,
    state: "accepted",
    payloadDigest: row.payload_digest,
    configDigest: row.config_digest,
    rowIds: JSON.parse(row.row_ids_json) as string[],
    ownerGeneration: row.owner_generation,
    wakeClaimId: row.wake_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OperationStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        home_id TEXT NOT NULL,
        supervisor_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        config_digest TEXT NOT NULL,
        row_ids_json TEXT NOT NULL,
        owner_generation INTEGER,
        wake_claim_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supervisors (
        home_id TEXT NOT NULL,
        supervisor_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (home_id, supervisor_id)
      );
    `);
  }

  getOperation(operationId: string): OperationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .get(operationId) as OperationRow | undefined;
    return row ? toRecord(row) : null;
  }

  insertOperation(record: OperationRecord): void {
    this.db
      .prepare(
        `INSERT INTO operations (
           operation_id, home_id, supervisor_id, state, payload_digest,
           config_digest, row_ids_json, owner_generation, wake_claim_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.operationId,
        record.homeId,
        record.supervisorId,
        record.state,
        record.payloadDigest,
        record.configDigest,
        JSON.stringify(record.rowIds),
        record.ownerGeneration,
        record.wakeClaimId,
        record.createdAt,
        record.updatedAt,
      );
  }

  countOperations(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM operations").get() as { n: number };
    return row.n;
  }

  getSupervisor(homeId: string, supervisorId: string): string | null {
    const row = this.db
      .prepare("SELECT conversation_id FROM supervisors WHERE home_id = ? AND supervisor_id = ?")
      .get(homeId, supervisorId) as SupervisorRow | undefined;
    return row ? row.conversation_id : null;
  }

  /** Record the conversation binding. Returns true when it was newly created. */
  putSupervisor(homeId: string, supervisorId: string, conversationId: string, at: number): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO supervisors (home_id, supervisor_id, conversation_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(homeId, supervisorId, conversationId, at);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
