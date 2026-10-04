/**
 * Adapter-owned durable store (P1A acceptance, P1B supervisor identity).
 *
 * This store records operation acceptance and the durable supervisor binding:
 * conversation identity, the pinned configuration digest, and the current
 * FirstMate authority generation. It never records a raw operation payload, so
 * no request value - secret or otherwise - can appear in the store file.
 *
 * It is deliberately separate from the upstream Durable conversation store
 * (`runtime.sqlite`): FirstMate and runtime stores are separate transaction
 * domains (docs/pi-durable/02-architecture.md), and this adapter must not read
 * Durable's internal tables.
 */

import { DatabaseSync } from "node:sqlite";
import type { JsonValue, OperationRecord, SupervisorBinding } from "./protocol.ts";

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
  home_id: string;
  supervisor_id: string;
  conversation_id: string;
  generation: number;
  wake_claim_id: string;
  row_ids_json: string;
  capability_profile: string;
  config_digest: string;
  agent_json: string;
  created_at: number;
  updated_at: number;
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

function toBinding(row: SupervisorRow): SupervisorBinding {
  return {
    homeId: row.home_id,
    supervisorId: row.supervisor_id,
    conversationId: row.conversation_id,
    generation: row.generation,
    wakeClaimId: row.wake_claim_id,
    rowIds: JSON.parse(row.row_ids_json) as string[],
    capabilityProfile: row.capability_profile,
    configDigest: row.config_digest,
    agent: JSON.parse(row.agent_json) as JsonValue,
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
        generation INTEGER NOT NULL DEFAULT 0,
        wake_claim_id TEXT NOT NULL DEFAULT '',
        row_ids_json TEXT NOT NULL DEFAULT '[]',
        capability_profile TEXT NOT NULL DEFAULT '',
        config_digest TEXT NOT NULL DEFAULT '',
        agent_json TEXT NOT NULL DEFAULT 'null',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (home_id, supervisor_id)
      );
    `);
    this.migrateSupervisors();
  }

  /** Add P1B columns to a supervisors table created by an earlier version. */
  private migrateSupervisors(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(supervisors)").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    const additions: [string, string][] = [
      ["generation", "INTEGER NOT NULL DEFAULT 0"],
      ["wake_claim_id", "TEXT NOT NULL DEFAULT ''"],
      ["row_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["capability_profile", "TEXT NOT NULL DEFAULT ''"],
      ["config_digest", "TEXT NOT NULL DEFAULT ''"],
      ["agent_json", "TEXT NOT NULL DEFAULT 'null'"],
      ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE supervisors ADD COLUMN ${name} ${definition}`);
      }
    }
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

  getSupervisorBinding(homeId: string, supervisorId: string): SupervisorBinding | null {
    const row = this.db
      .prepare("SELECT * FROM supervisors WHERE home_id = ? AND supervisor_id = ?")
      .get(homeId, supervisorId) as SupervisorRow | undefined;
    return row ? toBinding(row) : null;
  }

  putSupervisorBinding(binding: SupervisorBinding): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO supervisors (
           home_id, supervisor_id, conversation_id, generation, wake_claim_id,
           row_ids_json, capability_profile, config_digest, agent_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.homeId,
        binding.supervisorId,
        binding.conversationId,
        binding.generation,
        binding.wakeClaimId,
        JSON.stringify(binding.rowIds),
        binding.capabilityProfile,
        binding.configDigest,
        JSON.stringify(binding.agent),
        binding.createdAt,
        binding.updatedAt,
      );
  }

  close(): void {
    this.db.close();
  }
}
