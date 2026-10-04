/**
 * Pi Durable sidecar wire protocol (P1A).
 *
 * This module is the single owner of the protocol version, the bounded request
 * schemas, the digest rules, and the error codes. The service validates every
 * inbound request here before any store or provider effect.
 *
 * Design source: docs/pi-durable/02-architecture.md "Service boundary" and
 * "Proposed operations"; docs/pi-durable/03-implementation-plan.md P1A.
 */

import { createHash } from "node:crypto";

/** Wire protocol version. A request carrying any other value is refused. */
export const PROTOCOL_VERSION = 1;

/** Hard cap on one JSON request or response frame, in bytes. */
export const DEFAULT_MAX_MESSAGE_BYTES = 262_144;

/** Hard cap on concurrently outstanding requests per service. */
export const DEFAULT_MAX_OUTSTANDING = 64;

/** Cap on any identifier field, in characters. */
export const MAX_ID_CHARS = 256;

/** Cap on the accepted row-id list length. */
export const MAX_ROW_IDS = 4096;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OperationName =
  | "health"
  | "ensureSupervisor"
  | "submit"
  | "inspect"
  | "shutdown";

export const OPERATION_NAMES: readonly OperationName[] = [
  "health",
  "ensureSupervisor",
  "submit",
  "inspect",
  "shutdown",
];

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNSUPPORTED_OPERATION"
  | "PROTOCOL_MISMATCH"
  | "HOME_MISMATCH"
  | "MESSAGE_TOO_LARGE"
  | "BUSY"
  | "DIGEST_MISMATCH"
  | "CONFLICT"
  | "NOT_FOUND"
  | "INTERNAL";

/** A refusal that maps to a protocol error code. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

type BaseRequest = {
  protocolVersion: number;
  homeId: string;
};

export type HealthRequest = BaseRequest & { op: "health" };

export type EnsureSupervisorRequest = BaseRequest & {
  op: "ensureSupervisor";
  supervisorId: string;
};

export type SubmitRequest = BaseRequest & {
  op: "submit";
  operationId: string;
  supervisorId: string;
  payload: JsonValue;
  config?: JsonValue;
  payloadDigest?: string;
  configDigest?: string;
  rowIds?: string[];
  ownerGeneration?: number;
  wakeClaimId?: string;
};

export type InspectRequest = BaseRequest & {
  op: "inspect";
  operationId: string;
};

export type ShutdownRequest = BaseRequest & { op: "shutdown" };

export type SidecarRequest =
  | HealthRequest
  | EnsureSupervisorRequest
  | SubmitRequest
  | InspectRequest
  | ShutdownRequest;

export type OperationRecord = {
  operationId: string;
  homeId: string;
  supervisorId: string;
  state: "accepted";
  payloadDigest: string;
  configDigest: string;
  rowIds: string[];
  ownerGeneration: number | null;
  wakeClaimId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type HealthResult = {
  protocolVersion: number;
  homeId: string;
  node: string;
  dependencies: Record<string, string>;
  owner: { pid: number; startedAt: number };
  store: { path: string };
};

export type EnsureSupervisorResult = {
  homeId: string;
  supervisorId: string;
  conversationId: string;
  created: boolean;
};

export type SubmitResult = {
  record: OperationRecord;
  replayed: boolean;
};

export type InspectResult = { record: OperationRecord | null };

export type SidecarResult =
  | HealthResult
  | EnsureSupervisorResult
  | SubmitResult
  | InspectResult
  | { stopped: true };

export type SidecarResponse =
  | { ok: true; result: SidecarResult }
  | { ok: false; error: { code: ErrorCode; message: string } };

/** Stable, key-sorted JSON so equal values always hash equally. */
export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue)}`)
    .join(",");
  return `{${body}}`;
}

/** SHA-256 over the canonical form of a JSON value, lowercase hex. */
export function digestOf(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function fail(code: ErrorCode, message: string): never {
  throw new ProtocolError(code, message);
}

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("BAD_REQUEST", "request must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function asString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) {
    fail("BAD_REQUEST", `${key} must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) {
    fail("BAD_REQUEST", `${key} must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
  }
  return value;
}

function requireJson(source: Record<string, unknown>, key: string): JsonValue {
  if (!(key in source)) fail("BAD_REQUEST", `${key} is required`);
  return source[key] as JsonValue;
}

/**
 * Validate one decoded request frame.
 *
 * Protocol and home compatibility are checked by the service, which owns the
 * bound home identity; this function only checks schema shape.
 */
export function parseRequest(raw: unknown): SidecarRequest {
  const source = asObject(raw);
  const protocolVersion = source.protocolVersion;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    fail("BAD_REQUEST", "protocolVersion must be an integer");
  }
  const homeId = asString(source, "homeId");
  const op = source.op;
  if (typeof op !== "string" || !(OPERATION_NAMES as readonly string[]).includes(op)) {
    fail("UNSUPPORTED_OPERATION", `unsupported operation ${JSON.stringify(op)}`);
  }

  const base = { protocolVersion, homeId };

  switch (op as OperationName) {
    case "health":
      return { ...base, op: "health" };
    case "ensureSupervisor":
      return { ...base, op: "ensureSupervisor", supervisorId: asString(source, "supervisorId") };
    case "inspect":
      return { ...base, op: "inspect", operationId: asString(source, "operationId") };
    case "shutdown":
      return { ...base, op: "shutdown" };
    case "submit": {
      const payload = requireJson(source, "payload");
      const config = "config" in source ? requireJson(source, "config") : undefined;
      const payloadDigest = optionalString(source, "payloadDigest");
      if (payloadDigest !== undefined && !isDigest(payloadDigest)) {
        fail("BAD_REQUEST", "payloadDigest must be a lowercase SHA-256 hex digest");
      }
      const configDigest = optionalString(source, "configDigest");
      if (configDigest !== undefined && !isDigest(configDigest)) {
        fail("BAD_REQUEST", "configDigest must be a lowercase SHA-256 hex digest");
      }
      const rowIdsRaw = source.rowIds;
      let rowIds: string[] | undefined;
      if (rowIdsRaw !== undefined) {
        if (!Array.isArray(rowIdsRaw) || rowIdsRaw.length > MAX_ROW_IDS) {
          fail("BAD_REQUEST", `rowIds must be an array of at most ${MAX_ROW_IDS} strings`);
        }
        rowIds = rowIdsRaw.map((id) => {
          if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) {
            fail("BAD_REQUEST", "rowIds entries must be non-empty bounded strings");
          }
          return id;
        });
      }
      const ownerGenerationRaw = source.ownerGeneration;
      let ownerGeneration: number | undefined;
      if (ownerGenerationRaw !== undefined) {
        if (typeof ownerGenerationRaw !== "number" || !Number.isInteger(ownerGenerationRaw)) {
          fail("BAD_REQUEST", "ownerGeneration must be an integer");
        }
        ownerGeneration = ownerGenerationRaw;
      }
      const wakeClaimId = optionalString(source, "wakeClaimId");
      return {
        ...base,
        op: "submit",
        operationId: asString(source, "operationId"),
        supervisorId: asString(source, "supervisorId"),
        payload,
        ...(config !== undefined ? { config } : {}),
        ...(payloadDigest !== undefined ? { payloadDigest } : {}),
        ...(configDigest !== undefined ? { configDigest } : {}),
        ...(rowIds !== undefined ? { rowIds } : {}),
        ...(ownerGeneration !== undefined ? { ownerGeneration } : {}),
        ...(wakeClaimId !== undefined ? { wakeClaimId } : {}),
      };
    }
  }
}

/** Encode one response frame (no trailing newline). */
export function encodeResponse(response: SidecarResponse): string {
  return JSON.stringify(response);
}

/** Encode one request frame (no trailing newline). */
export function encodeRequest(request: SidecarRequest): string {
  return JSON.stringify(request);
}

export function errorResponse(error: unknown): SidecarResponse {
  if (error instanceof ProtocolError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: "INTERNAL", message } };
}
