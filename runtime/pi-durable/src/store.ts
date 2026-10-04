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
import type { JsonValue, Observation, OperationRecord, SupervisorBinding } from "./protocol.ts";

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
  result_json: string | null;
  receipt_json: string | null;
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

type ObservationRow = {
  seq: number;
  home_id: string;
  kind: string;
  operation_id: string | null;
  payload_json: string;
  created_at: number;
};

function toObservation(row: ObservationRow): Observation {
  return {
    seq: row.seq,
    kind: row.kind,
    operationId: row.operation_id,
    payload: JSON.parse(row.payload_json) as JsonValue,
    createdAt: row.created_at,
  };
}

function toRecord(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    homeId: row.home_id,
    supervisorId: row.supervisor_id,
    state: row.state === "settled" ? "settled" : "accepted",
    payloadDigest: row.payload_digest,
    configDigest: row.config_digest,
    rowIds: JSON.parse(row.row_ids_json) as string[],
    ownerGeneration: row.owner_generation,
    wakeClaimId: row.wake_claim_id,
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as JsonValue),
    receipt: row.receipt_json === null ? null : (JSON.parse(row.receipt_json) as { seq: number }),
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
        result_json TEXT,
        receipt_json TEXT,
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
      CREATE TABLE IF NOT EXISTS observations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        home_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        operation_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observations_home_seq ON observations (home_id, seq);
      CREATE TABLE IF NOT EXISTS observe_cursor (
        home_id TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.migrateSupervisors();
    this.migrateOperations();
  }

  /** Add P1C columns to an operations table created by an earlier version. */
  private migrateOperations(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(operations)").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const name of ["result_json", "receipt_json"]) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE operations ADD COLUMN ${name} TEXT`);
      }
    }
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

  /** Mark an operation settled with its candidate result. */
  settleOperation(operationId: string, result: JsonValue, at: number): void {
    this.db
      .prepare("UPDATE operations SET state = 'settled', result_json = ?, updated_at = ? WHERE operation_id = ?")
      .run(JSON.stringify(result), at, operationId);
  }

  /** Record the mirrored outcome receipt for an operation. */
  recordReceipt(operationId: string, seq: number, at: number): void {
    this.db
      .prepare("UPDATE operations SET receipt_json = ?, updated_at = ? WHERE operation_id = ?")
      .run(JSON.stringify({ seq }), at, operationId);
  }

  /** Append one durable outbox observation and return its sequence. */
  appendObservation(observation: {
    homeId: string;
    kind: string;
    operationId: string | null;
    payload: JsonValue;
    at: number;
  }): number {
    const result = this.db
      .prepare(
        "INSERT INTO observations (home_id, kind, operation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        observation.homeId,
        observation.kind,
        observation.operationId,
        JSON.stringify(observation.payload),
        observation.at,
      );
    return Number(result.lastInsertRowid);
  }

  listObservations(homeId: string, after: number, limit: number): Observation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM observations WHERE home_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(homeId, after, limit) as ObservationRow[];
    return rows.map(toObservation);
  }

  countObservations(homeId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM observations WHERE home_id = ?")
      .get(homeId) as { n: number };
    return row.n;
  }

  /** Settlement observations in (after, through], oldest first. */
  settlementObservationsBetween(
    homeId: string,
    after: number,
    through: number,
  ): { seq: number; operationId: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT seq, operation_id FROM observations
         WHERE home_id = ? AND kind = 'settlement' AND seq > ? AND seq <= ?
         ORDER BY seq ASC`,
      )
      .all(homeId, after, through) as { seq: number; operation_id: string | null }[];
    return rows.map((row) => ({ seq: row.seq, operationId: row.operation_id }));
  }

  /** Oldest observation sequence still retained for a home, or null when empty. */
  oldestObservationSeq(homeId: string): number | null {
    const row = this.db
      .prepare("SELECT MIN(seq) AS seq FROM observations WHERE home_id = ?")
      .get(homeId) as { seq: number | null };
    return row.seq ?? null;
  }

  /**
   * Bound the outbox: drop oldest transient observations first, then oldest
   * settlement observations only when the transient pool cannot cover the
   * excess. Settlement observations are the durable ones a subscriber needs.
   */
  pruneObservations(homeId: string, max: number): void {
    let excess = this.countObservations(homeId) - max;
    if (excess <= 0) return;
    const transient = this.db
      .prepare(
        `DELETE FROM observations WHERE seq IN (
           SELECT seq FROM observations WHERE home_id = ? AND kind != 'settlement'
           ORDER BY seq ASC LIMIT ?
         )`,
      )
      .run(homeId, excess);
    excess -= Number(transient.changes);
    if (excess > 0) {
      this.db
        .prepare(
          `DELETE FROM observations WHERE seq IN (
             SELECT seq FROM observations WHERE home_id = ? ORDER BY seq ASC LIMIT ?
           )`,
        )
        .run(homeId, excess);
    }
  }

  getObserveCursor(homeId: string): number {
    const row = this.db
      .prepare("SELECT cursor FROM observe_cursor WHERE home_id = ?")
      .get(homeId) as { cursor: number } | undefined;
    return row ? row.cursor : 0;
  }

  /** Advance the observe cursor; never moves backwards. */
  setObserveCursor(homeId: string, cursor: number, at: number): void {
    this.db
      .prepare(
        `INSERT INTO observe_cursor (home_id, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(home_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor), updated_at = excluded.updated_at`,
      )
      .run(homeId, cursor, at);
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
