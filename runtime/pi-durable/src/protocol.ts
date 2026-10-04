/**
 * Pi Durable sidecar wire protocol (P1A service/protocol, P1B identity and
 * authority).
 *
 * This module is the single owner of the protocol version, the bounded request
 * schemas, the digest rules, the capability profiles, and the error codes. The
 * service validates every inbound request here before any store or provider
 * effect.
 *
 * Design source: docs/pi-durable/02-architecture.md "Service boundary",
 * "Proposed operations", and "Fencing and startup recovery";
 * docs/pi-durable/03-implementation-plan.md P1A and P1B.
 */

import { createHash } from "node:crypto";

/** Wire protocol version. A request carrying any other value is refused. */
export const PROTOCOL_VERSION = 2;

/** Hard cap on one JSON request or response frame, in bytes. */
export const DEFAULT_MAX_MESSAGE_BYTES = 262_144;

/** Hard cap on concurrently outstanding requests per service. */
export const DEFAULT_MAX_OUTSTANDING = 64;

/** Cap on any identifier field, in characters. */
export const MAX_ID_CHARS = 256;

/** Cap on the accepted row-id list length. */
export const MAX_ROW_IDS = 4096;

/** Bounded observe queue size per home. */
export const MAX_OBSERVATIONS = 1000;

/** Observe page size bounds. */
export const DEFAULT_OBSERVE_LIMIT = 64;
export const MAX_OBSERVE_LIMIT = 256;

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
  | "dispatch"
  | "receipt"
  | "observe"
  | "observeAck"
  | "resume"
  | "cancel"
  | "shutdown";

export const OPERATION_NAMES: readonly OperationName[] = [
  "health",
  "ensureSupervisor",
  "submit",
  "inspect",
  "dispatch",
  "receipt",
  "observe",
  "observeAck",
  "resume",
  "cancel",
  "shutdown",
];

/** Allowed thinking levels, mirroring the pinned `pi-ai` model levels. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Named capability profiles. The profile is the adapter's own narrow tool
 * grant, never the host default: a conversation created for a profile selects
 * exactly these extensions and tools.
 */
export const CAPABILITY_PROFILES = {
  "supervision-observe-v1": { extensions: [], tools: [] },
} as const;

export type CapabilityProfileName = keyof typeof CAPABILITY_PROFILES;

export const CAPABILITY_PROFILE_NAMES = Object.keys(
  CAPABILITY_PROFILES,
) as CapabilityProfileName[];

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
  | "CAPABILITY_UNKNOWN"
  | "CWD_INVALID"
  | "CONFIG_CONFLICT"
  | "RECONCILE_REQUIRED"
  | "OBSERVE_GAP"
  | "RECEIPT_REQUIRED"
  | "CURSOR_INVALID"
  | "AUTHORITY_UNKNOWN"
  | "AUTHORITY_STALE"
  | "AUTHORITY_CONFLICT"
  | "AUTHORITY_SCOPE"
  | "SCOPE_UNSUPPORTED"
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

/** A pinned agent configuration carried by `ensureSupervisor`. */
export type PinnedAgent = {
  model: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  instructions?: string;
  cwd: string;
};

/** The FirstMate-owned authority binding for one supervisor. */
export type AuthorityBinding = {
  ownerGeneration: number;
  wakeClaimId: string;
  rowIds: string[];
};

export type EnsureSupervisorRequest = BaseRequest &
  AuthorityBinding & {
    op: "ensureSupervisor";
    supervisorId: string;
    capabilityProfile: string;
    agent: PinnedAgent;
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

/** Execute one accepted supervision operation and return its candidate result. */
export type DispatchRequest = BaseRequest &
  AuthorityBinding & {
    op: "dispatch";
    supervisorId: string;
    capabilityProfile: string;
    operationId: string;
    prompt: string;
    payload: JsonValue;
    payloadDigest?: string;
  };

/** Record the mirrored delivery receipt (outcome sequence) for an operation. */
export type ReceiptRequest = BaseRequest & {
  op: "receipt";
  operationId: string;
  seq: number;
};

export type ObservationKind = "accepted" | "settlement" | "unresolved";

/** One normalized, durable outbox observation. */
export type Observation = {
  seq: number;
  kind: string;
  operationId: string | null;
  payload: JsonValue;
  createdAt: number;
};

export type ObserveRequest = BaseRequest & {
  op: "observe";
  after?: number;
  limit?: number;
};

export type ObserveAckRequest = BaseRequest & {
  op: "observeAck";
  cursor: number;
};

export type ResumeRequest = BaseRequest &
  AuthorityBinding & {
    op: "resume";
    supervisorId: string;
    capabilityProfile: string;
  };

export type ShutdownRequest = BaseRequest & { op: "shutdown" };

/**
 * The cancellation scope a request covers. `background` is deliberately absent:
 * the prototype prohibits untracked background work, so there is no background
 * ownership tree to cancel. `operation` and `foreground` both cover the single
 * owned foreground operation, which is the whole ownership tree here.
 */
export const CANCEL_SCOPES = ["operation", "foreground"] as const;
export type CancelScope = (typeof CANCEL_SCOPES)[number];

/** Persist cancellation intent for one operation, then request runtime abort. */
export type CancelRequest = BaseRequest &
  AuthorityBinding & {
    op: "cancel";
    supervisorId: string;
    capabilityProfile: string;
    operationId: string;
    scope: CancelScope;
  };

export type CancelResult = {
  operationId: string;
  scope: CancelScope;
  intentPersisted: true;
  /** False whenever any owned effect is still unresolved at the deadline. */
  settled: boolean;
  state: "cancelled" | "cancel-unresolved";
  unresolved: string[];
  retained: { operation: true; observations: number; outcomesUntouched: true };
};

export type SidecarRequest =
  | HealthRequest
  | EnsureSupervisorRequest
  | SubmitRequest
  | InspectRequest
  | DispatchRequest
  | ReceiptRequest
  | ObserveRequest
  | ObserveAckRequest
  | ResumeRequest
  | CancelRequest
  | ShutdownRequest;

export type OperationRecord = {
  operationId: string;
  homeId: string;
  supervisorId: string;
  state: "accepted" | "settled" | "cancelling" | "cancelled" | "cancel-unresolved";
  payloadDigest: string;
  configDigest: string;
  rowIds: string[];
  ownerGeneration: number | null;
  wakeClaimId: string | null;
  result: JsonValue;
  receipt: { seq: number } | null;
  createdAt: number;
  updatedAt: number;
};

/** The durable supervisor binding: conversation identity, pin, and authority. */
export type SupervisorBinding = {
  homeId: string;
  supervisorId: string;
  conversationId: string;
  generation: number;
  wakeClaimId: string;
  rowIds: string[];
  capabilityProfile: string;
  configDigest: string;
  agent: JsonValue;
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
  generation: number;
  capabilityProfile: string;
  configDigest: string;
  agent: JsonValue;
};

export type SubmitResult = {
  record: OperationRecord;
  replayed: boolean;
};

export type InspectResult = { record: OperationRecord | null };

export type DispatchResult = {
  record: OperationRecord;
  result: JsonValue;
  replayed: boolean;
};

export type ReceiptResult = { recorded: true };

export type ObserveResult = {
  observations: Observation[];
  cursor: number;
  hasMore: boolean;
  oldestSeq: number | null;
};

export type ObserveAckResult = { cursor: number };

export type ResumeResult = { resumed: true; generation: number };

export type SidecarResult =
  | HealthResult
  | EnsureSupervisorResult
  | SubmitResult
  | InspectResult
  | DispatchResult
  | ReceiptResult
  | ObserveResult
  | ObserveAckResult
  | ResumeResult
  | CancelResult
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

/** The canonical configuration digest for a pinned conversation. */
export function pinnedConfigDigest(profile: string, agent: PinnedAgent): string {
  const grant = CAPABILITY_PROFILES[profile as CapabilityProfileName] ?? { extensions: [], tools: [] };
  return digestOf({
    capabilityProfile: profile,
    model: { provider: agent.model.provider, modelId: agent.model.modelId },
    thinkingLevel: agent.thinkingLevel,
    instructions: agent.instructions ?? null,
    cwd: agent.cwd,
    extensions: [...grant.extensions],
    tools: [...grant.tools],
  });
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

function parseRowIds(source: Record<string, unknown>, key: string): string[] {
  const raw = source[key];
  if (!Array.isArray(raw) || raw.length > MAX_ROW_IDS) {
    fail("BAD_REQUEST", `${key} must be an array of at most ${MAX_ROW_IDS} strings`);
  }
  return raw.map((id) => {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) {
      fail("BAD_REQUEST", `${key} entries must be non-empty bounded strings`);
    }
    return id;
  });
}

function parseGeneration(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("BAD_REQUEST", `${key} must be a non-negative integer`);
  }
  return value;
}

function parseAuthority(source: Record<string, unknown>): AuthorityBinding {
  return {
    ownerGeneration: parseGeneration(source, "ownerGeneration"),
    wakeClaimId: asString(source, "wakeClaimId"),
    rowIds: parseRowIds(source, "rowIds"),
  };
}

function parseCapabilityProfile(source: Record<string, unknown>): string {
  const profile = asString(source, "capabilityProfile");
  if (!(profile in CAPABILITY_PROFILES)) {
    fail("CAPABILITY_UNKNOWN", `unknown capability profile ${JSON.stringify(profile)}`);
  }
  return profile;
}

function parsePinnedAgent(source: Record<string, unknown>): PinnedAgent {
  const model = asObject(source.model);
  const provider = asString(model, "provider");
  const modelId = asString(model, "modelId");
  const thinkingLevel = asString(source, "thinkingLevel");
  if (!(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
    fail("BAD_REQUEST", `thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  const cwd = asString(source, "cwd");
  const instructions = optionalString(source, "instructions");
  return {
    model: { provider, modelId },
    thinkingLevel: thinkingLevel as ThinkingLevel,
    ...(instructions !== undefined ? { instructions } : {}),
    cwd,
  };
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
      return {
        ...base,
        ...parseAuthority(source),
        op: "ensureSupervisor",
        supervisorId: asString(source, "supervisorId"),
        capabilityProfile: parseCapabilityProfile(source),
        agent: parsePinnedAgent(source),
      };
    case "inspect":
      return { ...base, op: "inspect", operationId: asString(source, "operationId") };
    case "dispatch": {
      const payloadDigest = optionalString(source, "payloadDigest");
      if (payloadDigest !== undefined && !isDigest(payloadDigest)) {
        fail("BAD_REQUEST", "payloadDigest must be a lowercase SHA-256 hex digest");
      }
      return {
        ...base,
        ...parseAuthority(source),
        op: "dispatch",
        supervisorId: asString(source, "supervisorId"),
        capabilityProfile: parseCapabilityProfile(source),
        operationId: asString(source, "operationId"),
        prompt: asString(source, "prompt"),
        payload: requireJson(source, "payload"),
        ...(payloadDigest !== undefined ? { payloadDigest } : {}),
      };
    }
    case "receipt":
      return {
        ...base,
        op: "receipt",
        operationId: asString(source, "operationId"),
        seq: parseGeneration(source, "seq"),
      };
    case "observe": {
      const after = source.after === undefined ? undefined : parseGeneration(source, "after");
      let limit: number | undefined;
      if (source.limit !== undefined) {
        limit = parseGeneration(source, "limit");
        if (limit === 0 || limit > MAX_OBSERVE_LIMIT) {
          fail("BAD_REQUEST", `limit must be between 1 and ${MAX_OBSERVE_LIMIT}`);
        }
      }
      return {
        ...base,
        op: "observe",
        ...(after !== undefined ? { after } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
    }
    case "observeAck":
      return { ...base, op: "observeAck", cursor: parseGeneration(source, "cursor") };
    case "resume":
      return {
        ...base,
        ...parseAuthority(source),
        op: "resume",
        supervisorId: asString(source, "supervisorId"),
        capabilityProfile: parseCapabilityProfile(source),
      };
    case "cancel": {
      const scope = source.scope;
      if (typeof scope !== "string" || !(CANCEL_SCOPES as readonly string[]).includes(scope)) {
        fail("SCOPE_UNSUPPORTED", `unsupported cancellation scope ${JSON.stringify(scope)}`);
      }
      return {
        ...base,
        ...parseAuthority(source),
        op: "cancel",
        supervisorId: asString(source, "supervisorId"),
        capabilityProfile: parseCapabilityProfile(source),
        operationId: asString(source, "operationId"),
        scope: scope as CancelScope,
      };
    }
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
      const rowIds = "rowIds" in source ? parseRowIds(source, "rowIds") : undefined;
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
