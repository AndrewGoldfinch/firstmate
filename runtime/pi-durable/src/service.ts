/**
 * Pi Durable sidecar service (P1A service/protocol, P1B identity and
 * authority).
 *
 * One owner process per canonical FM_HOME. The service holds the single-owner
 * store lock, exposes a Unix-domain socket in a private directory, validates
 * bounded JSON requests against `protocol.ts`, durably accepts operations
 * through `store.ts`, and creates or reattaches a pinned supervision
 * conversation through `provider.ts`.
 *
 * Design source: docs/pi-durable/02-architecture.md "Service boundary",
 * "Proposed operations", and "Fencing and startup recovery";
 * docs/pi-durable/03-implementation-plan.md P1A and P1B.
 */

import { chmodSync, mkdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { OwnerLock } from "./lock.ts";
import { OperationStore } from "./store.ts";
import { DurableProvider, dependencyVersions, type ModelConfigurer } from "./provider.ts";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_OUTSTANDING,
  DEFAULT_OBSERVE_LIMIT,
  MAX_OBSERVATIONS,
  PROTOCOL_VERSION,
  ProtocolError,
  READ_TOOL_DECLARATIONS,
  digestOf,
  encodeResponse,
  errorResponse,
  parseRequest,
  pinnedConfigDigest,
  type AuthorityBinding,
  type CancelRequest,
  type CancelResult,
  type DispatchRequest,
  type EnsureSupervisorRequest,
  type HealthResult,
  type JsonValue,
  type ObserveAckRequest,
  type ObserveRequest,
  type OperationRecord,
  type ReadToolName,
  type ReadToolRequest,
  type ReadToolResult,
  type ReceiptRequest,
  type ResumeRequest,
  type SidecarRequest,
  type SidecarResponse,
  type SidecarResult,
  type SubmitResult,
  type SupervisorBinding,
} from "./protocol.ts";

/** How long cancellation waits for one ownership tree to stop running. */
const CANCEL_DEADLINE_MS = 2000;
/** Cancellation idle-poll interval. */
const CANCEL_POLL_MS = 10;

export type SidecarOptions = {
  /** Canonical FM_HOME for this owner. Created when absent. */
  home: string;
  socketPath?: string;
  /** Adapter-owned acceptance and identity store. */
  storePath?: string;
  /** Upstream Durable conversation store. */
  runtimeStorePath?: string;
  logger?: (line: string) => void;
  maxMessageBytes?: number;
  maxOutstanding?: number;
  /** Register model providers before any supervision execution. */
  configureModels?: ModelConfigurer;
  /**
   * Test-only fault seam: called at named persistence and effect boundaries so
   * the evaluation harness can pause or crash an owner deterministically
   * instead of relying on timing. Production callers leave it unset.
   */
  barriers?: (name: string) => void | Promise<void>;
  now?: () => number;
};

type SubmitInput = Extract<SidecarRequest, { op: "submit" }>;

export class DurableSidecar {
  readonly homeId: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly storePath: string;
  readonly runtimeStorePath: string;
  readonly startedAt: number;

  private readonly lock: OwnerLock;
  private readonly store: OperationStore;
  private readonly provider: DurableProvider;
  private server!: Server;
  private readonly sockets = new Set<Socket>();
  private readonly logger: (line: string) => void;
  private readonly maxMessageBytes: number;
  private readonly maxOutstanding: number;
  private readonly now: () => number;
  private readonly barriers: (name: string) => void | Promise<void>;
  private outstanding = 0;
  private stopping: Promise<void> | null = null;

  private constructor(init: {
    homeId: string;
    stateDir: string;
    socketPath: string;
    storePath: string;
    runtimeStorePath: string;
    startedAt: number;
    lock: OwnerLock;
    store: OperationStore;
    provider: DurableProvider;
    logger: (line: string) => void;
    maxMessageBytes: number;
    maxOutstanding: number;
    now: () => number;
    barriers: (name: string) => void | Promise<void>;
  }) {
    this.homeId = init.homeId;
    this.stateDir = init.stateDir;
    this.socketPath = init.socketPath;
    this.storePath = init.storePath;
    this.runtimeStorePath = init.runtimeStorePath;
    this.startedAt = init.startedAt;
    this.lock = init.lock;
    this.store = init.store;
    this.provider = init.provider;
    this.logger = init.logger;
    this.maxMessageBytes = init.maxMessageBytes;
    this.maxOutstanding = init.maxOutstanding;
    this.now = init.now;
    this.barriers = init.barriers;
  }

  static async start(options: SidecarOptions): Promise<DurableSidecar> {
    const now = options.now ?? Date.now;
    const logger = options.logger ?? (() => {});
    const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const maxOutstanding = options.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING;

    mkdirSync(options.home, { recursive: true });
    const homeId = realpathSync(options.home);
    const stateDir = join(homeId, "state", "pi-durable");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);

    const lock = OwnerLock.acquire(join(stateDir, "store.lock"), homeId, now);    const storePath = options.storePath ?? join(stateDir, "operations.sqlite");
    const runtimeStorePath = options.runtimeStorePath ?? join(stateDir, "runtime.sqlite");
    const socketPath = options.socketPath ?? join(stateDir, "sidecar.sock");

    let store: OperationStore | null = null;
    let provider: DurableProvider | null = null;
    let server: Server | null = null;
    try {
      store = new OperationStore(storePath);
      provider = new DurableProvider({
        storePath: runtimeStorePath,
        ...(options.configureModels ? { configureModels: options.configureModels } : {}),
      });

      // The lock proves no live owner exists, so a leftover socket is stale.
      try {
        unlinkSync(socketPath);
      } catch {
        // No stale socket.
      }

      const instance = new DurableSidecar({
        homeId,
        stateDir,
        socketPath,
        storePath,
        runtimeStorePath,
        startedAt: now(),
        lock,
        store,
        provider,
        logger,
        maxMessageBytes,
        maxOutstanding,
        now,
        barriers: options.barriers ?? (() => {}),
      });

      server = createServer((socket) => instance.accept(socket));
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(socketPath, () => resolve());
      });
      chmodSync(socketPath, 0o600);
      instance.server = server;
      instance.logger(`op=start homeId=${homeId} socket=${socketPath} pid=${process.pid}`);
      return instance;
    } catch (error) {
      server?.close();
      await provider?.close().catch(() => {});
      store?.close();
      lock.release();
      throw error;
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > this.maxMessageBytes) {
        this.respond(socket, {
          ok: false,
          error: { code: "MESSAGE_TOO_LARGE", message: `frame exceeds ${this.maxMessageBytes} bytes` },
        });
        socket.end();
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void this.handleLine(socket, line);
        index = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    if (line.trim().length === 0) return;
    if (this.outstanding >= this.maxOutstanding) {
      this.respond(socket, {
        ok: false,
        error: { code: "BUSY", message: `more than ${this.maxOutstanding} requests outstanding` },
      });
      return;
    }
    this.outstanding += 1;
    try {
      const response = await this.dispatch(line);
      this.respond(socket, response);
    } finally {
      this.outstanding -= 1;
    }
  }

  private async dispatch(line: string): Promise<SidecarResponse> {
    let request: SidecarRequest;
    try {
      request = parseRequest(JSON.parse(line));
    } catch (error) {
      return this.failure("parse", undefined, error);
    }
    if (request.protocolVersion !== PROTOCOL_VERSION) {
      return this.failure(
        request.op,
        undefined,
        new ProtocolError(
          "PROTOCOL_MISMATCH",
          `service speaks protocol ${PROTOCOL_VERSION}, request used ${request.protocolVersion}`,
        ),
      );
    }
    if (request.homeId !== this.homeId) {
      return this.failure(
        request.op,
        undefined,
        new ProtocolError("HOME_MISMATCH", "request home does not match this owner's home"),
      );
    }
    try {
      return { ok: true, result: await this.run(request) };
    } catch (error) {
      return this.failure(request.op, operationIdOf(request), error);
    }
  }

  private async run(request: SidecarRequest): Promise<SidecarResult> {
    switch (request.op) {
      case "health":
        return this.health();
      case "ensureSupervisor":
        return this.ensureSupervisor(request);
      case "submit":
        return this.submit(request);
      case "inspect":
        return { record: this.store.getOperation(request.operationId) };
      case "dispatch":
        return this.dispatchOperation(request);
      case "receipt":
        return this.receipt(request);
      case "observe":
        return this.observe(request);
      case "observeAck":
        return this.observeAck(request);
      case "resume":
        return this.resume(request);
      case "cancel":
        return this.cancel(request);
      case "readTool":
        return this.readTool(request);
      case "shutdown": {
        setImmediate(() => {
          void this.stop();
        });
        return { stopped: true as const };
      }
    }
  }

  private health(): HealthResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      homeId: this.homeId,
      node: process.version,
      dependencies: dependencyVersions(),
      owner: { pid: process.pid, startedAt: this.startedAt },
      store: { path: this.storePath },
    };
  }

  /**
   * Find or create the pinned supervision conversation and record the current
   * FirstMate authority binding.
   *
   * Same-generation reconnects are idempotent and must match the recorded
   * configuration and claim; a higher generation is a new owner and may pin a
   * new configuration; a lower generation is stale and refused.
   */
  private async ensureSupervisor(request: EnsureSupervisorRequest) {
    validateCwd(request.agent.cwd);
    const configDigest = pinnedConfigDigest(request.capabilityProfile, request.agent);
    const existing = this.store.getSupervisorBinding(this.homeId, request.supervisorId);
    const now = this.now();

    let conversationId: string;
    let created: boolean;

    if (!existing) {
      ({ conversationId, created } = await this.provider.ensureConversation({ agent: request.agent }));
    } else if (request.ownerGeneration < existing.generation) {
      throw new ProtocolError(
        "AUTHORITY_STALE",
        `generation ${request.ownerGeneration} is behind the recorded generation ${existing.generation}`,
      );
    } else if (request.ownerGeneration === existing.generation) {
      if (existing.configDigest !== configDigest) {
        throw new ProtocolError(
          "CONFIG_CONFLICT",
          "same generation cannot repin the supervisor configuration",
        );
      }
      requireSameClaim(existing, request);
      ({ conversationId, created } = await this.provider.ensureConversation({
        conversationId: existing.conversationId,
        agent: request.agent,
      }));
    } else if (existing.configDigest === configDigest) {
      ({ conversationId, created } = await this.provider.ensureConversation({
        conversationId: existing.conversationId,
        agent: request.agent,
      }));
    } else {
      // A new owner with a different pin gets a fresh pinned conversation.
      ({ conversationId, created } = await this.provider.ensureConversation({ agent: request.agent }));
    }

    const agent = await this.provider.readAgentConfig(conversationId);
    const binding: SupervisorBinding = {
      homeId: this.homeId,
      supervisorId: request.supervisorId,
      conversationId,
      generation: request.ownerGeneration,
      wakeClaimId: request.wakeClaimId,
      rowIds: request.rowIds,
      capabilityProfile: request.capabilityProfile,
      configDigest,
      agent,
      createdAt: created || !existing ? now : existing.createdAt,
      updatedAt: now,
    };
    this.store.putSupervisorBinding(binding);
    return {
      homeId: this.homeId,
      supervisorId: request.supervisorId,
      conversationId,
      created,
      generation: request.ownerGeneration,
      capabilityProfile: request.capabilityProfile,
      configDigest,
      agent,
    };
  }

  /**
   * Resolve and validate the recorded authority for a guarded operation. The
   * check runs before any effect, and again at every guarded boundary.
   */
  private authorize(
    request: { supervisorId: string; capabilityProfile: string } & AuthorityBinding,
  ): SupervisorBinding {
    const existing = this.store.getSupervisorBinding(this.homeId, request.supervisorId);
    if (!existing) {
      throw new ProtocolError("AUTHORITY_UNKNOWN", "no recorded authority for this supervisor");
    }
    if (existing.capabilityProfile !== request.capabilityProfile) {
      throw new ProtocolError("AUTHORITY_CONFLICT", "capability profile does not match the recorded authority");
    }
    if (request.ownerGeneration < existing.generation) {
      throw new ProtocolError(
        "AUTHORITY_STALE",
        `generation ${request.ownerGeneration} is behind the recorded generation ${existing.generation}`,
      );
    }
    if (request.ownerGeneration > existing.generation) {
      throw new ProtocolError("AUTHORITY_UNKNOWN", "generation is not the recorded authority");
    }
    if (request.wakeClaimId !== existing.wakeClaimId) {
      throw new ProtocolError("AUTHORITY_CONFLICT", "wake claim does not match the recorded authority");
    }
    if (!rowSubset(request.rowIds, existing.rowIds)) {
      throw new ProtocolError("AUTHORITY_SCOPE", "requested rows are outside the recorded claim scope");
    }
    return existing;
  }

  /**
   * Guarded mutation: resume unfinished execution only under current authority.
   * The authority check runs before the resume call.
   */
  private async resume(request: ResumeRequest) {
    const existing = this.authorize(request);
    await this.provider.resume();
    return { resumed: true as const, generation: existing.generation };
  }

  /**
   * Declared read tool: structured arguments only, no side effects, and a
   * declared safe-replay treatment. An undeclared name is refused, so the model
   * can never reach anything outside the declaration table.
   */
  private async readTool(request: ReadToolRequest): Promise<ReadToolResult> {
    this.authorize(request);
    const declaration = READ_TOOL_DECLARATIONS[request.tool as ReadToolName];
    if (!declaration) {
      throw new ProtocolError(
        "CAPABILITY_UNKNOWN",
        `undeclared read tool ${JSON.stringify(request.tool)}`,
      );
    }
    const priorAttempts = this.store
      .listObservations(this.homeId, 0, MAX_OBSERVATIONS)
      .filter(
        (observation) => observation.operationId === request.operationId && observation.kind === "read",
      ).length;

    await this.barrier("tool.read.before");
    const snapshot = this.store.getOperation(request.operationId);
    const attempt = priorAttempts + 1;
    this.recordObservation("read", request.operationId, {
      tool: request.tool,
      category: declaration.category,
      replay: declaration.replay,
      attempt,
    });
    await this.barrier("tool.read.after");

    return {
      operationId: request.operationId,
      tool: request.tool as ReadToolName,
      category: declaration.category,
      replay: declaration.replay,
      attempt,
      replayed: priorAttempts > 0,
      snapshot: snapshot as unknown as JsonValue,
    };
  }

  /**
   * Cancellation: persist intent, request runtime abort, then verify the
   * ownership tree and every owned effect before reporting anything settled.
   * Abort is not rollback, so an effect that may already exist keeps the
   * operation unresolved and escalates instead of claiming completion.
   */
  private async cancel(request: CancelRequest): Promise<CancelResult> {
    this.authorize(request);
    const existing = this.store.getOperation(request.operationId);
    if (!existing) {
      throw new ProtocolError("NOT_FOUND", "unknown operation");
    }

    // Intent first: the `cancelling` state is durable before any abort request.
    this.store.requestCancel(request.operationId, this.now());
    this.recordObservation("cancellation-intent", request.operationId, {
      scope: request.scope,
      state: "cancelling",
    });

    const aborted = this.provider.abort(request.operationId);
    this.recordObservation("cancellation-abort", request.operationId, { aborted });

    const idle = await this.waitForIdle(request.operationId, CANCEL_DEADLINE_MS);
    const unresolved: string[] = [];
    if (!idle) unresolved.push("ownership-tree-active");
    // The pre-cancel snapshot carries the state cancellation just overwrote;
    // the fresh read carries any receipt recorded while the abort unwound.
    const current = this.store.getOperation(request.operationId) ?? existing;
    if (existing.state === "settled" && current.receipt === null) {
      unresolved.push("outcome-effect-unresolved");
    }

    const state = unresolved.length === 0 ? "cancelled" : "cancel-unresolved";
    this.store.settleCancellation(request.operationId, state, this.now());
    this.recordObservation("cancellation-settled", request.operationId, { state, unresolved });

    // Nothing is released here: the operation record, its observations, and any
    // outcome row stay for FirstMate to release or archive.
    return {
      operationId: request.operationId,
      scope: request.scope,
      intentPersisted: true,
      settled: unresolved.length === 0,
      state,
      unresolved,
      retained: {
        operation: true,
        observations: this.store.countObservations(this.homeId),
        outcomesUntouched: true,
      },
    };
  }

  /** Wait, bounded, until this operation's ownership tree stops running. */
  private async waitForIdle(operationId: string, deadlineMs: number): Promise<boolean> {
    const deadline = this.now() + deadlineMs;
    while (this.provider.activeOperations().includes(operationId)) {
      if (this.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, CANCEL_POLL_MS));
    }
    return true;
  }

  /**
   * Execute one accepted supervision operation under current authority and
   * return its candidate result. A settled repeat returns the original result;
   * an accepted-but-unsettled repeat requires reconciliation.
   */
  /** Fire the test-only barrier seam at a named boundary. */
  private async barrier(name: string): Promise<void> {
    await this.barriers(name);
  }

  private async dispatchOperation(request: DispatchRequest) {
    const binding = this.authorize(request);
    const payloadDigest = digestOf(request.payload);
    if (request.payloadDigest !== undefined && request.payloadDigest !== payloadDigest) {
      throw new ProtocolError("DIGEST_MISMATCH", "payloadDigest does not match the submitted payload");
    }

    const existing = this.store.getOperation(request.operationId);
    if (existing) {
      if (existing.supervisorId !== request.supervisorId || existing.payloadDigest !== payloadDigest) {
        throw new ProtocolError("CONFLICT", "operation ID already accepted with a different payload");
      }
      if (existing.state !== "settled") {
        throw new ProtocolError(
          "RECONCILE_REQUIRED",
          "operation was accepted but not settled; reconcile before retrying",
        );
      }
      return { record: existing, result: existing.result, replayed: true };
    }

    const at = this.now();
    const record: OperationRecord = {
      operationId: request.operationId,
      homeId: this.homeId,
      supervisorId: request.supervisorId,
      state: "accepted",
      payloadDigest,
      configDigest: binding.configDigest,
      rowIds: request.rowIds,
      ownerGeneration: request.ownerGeneration,
      wakeClaimId: request.wakeClaimId,
      result: null,
      receipt: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.barrier("dispatch.accept.before");
    this.store.insertOperation(record);
    this.recordObservation("accepted", request.operationId, { state: "accepted" });
    await this.barrier("dispatch.accept.after");
    await this.barrier("dispatch.model.before");
    let result: JsonValue;
    try {
      result = await this.provider.runSupervision({
        conversationId: binding.conversationId,
        prompt: request.prompt,
        operationId: request.operationId,
      });
    } catch (error) {
      // Accepted but unresolved: the effect may have happened, so it must be
      // reconciled rather than blindly retried. A run stopped by a recorded
      // cancellation is not an unresolved effect, so it is not reported as one.
      const message = error instanceof Error ? error.message : String(error);
      const cancelState = this.store.getOperation(request.operationId)?.state;
      if (
        cancelState !== "cancelling" &&
        cancelState !== "cancelled" &&
        cancelState !== "cancel-unresolved"
      ) {
        this.recordObservation("unresolved", request.operationId, { state: "accepted", error: message });
      }
      throw error;
    }
    await this.barrier("dispatch.model.after");
    this.store.settleOperation(request.operationId, result, this.now());
    this.recordObservation("settlement", request.operationId, result);
    await this.barrier("dispatch.settle.after");
    const settled = this.store.getOperation(request.operationId) ?? record;
    return { record: settled, result, replayed: false };
  }

  /** Append one durable outbox observation and bound the queue. */
  private recordObservation(kind: string, operationId: string | null, payload: JsonValue): void {
    this.store.appendObservation({
      homeId: this.homeId,
      kind,
      operationId,
      payload,
      at: this.now(),
    });
    this.store.pruneObservations(this.homeId, MAX_OBSERVATIONS);
  }

  /**
   * Read normalized observations after a cursor. A cursor behind the retained
   * window is refused as a gap rather than silently skipping settlements.
   */
  private observe(request: ObserveRequest) {
    const after = request.after ?? this.store.getObserveCursor(this.homeId);
    const oldestSeq = this.store.oldestObservationSeq(this.homeId);
    if (oldestSeq !== null && after < oldestSeq - 1) {
      throw new ProtocolError(
        "OBSERVE_GAP",
        `cursor ${after} is behind the retained observation window starting at ${oldestSeq}`,
      );
    }
    const limit = request.limit ?? DEFAULT_OBSERVE_LIMIT;
    const page = this.store.listObservations(this.homeId, after, limit + 1);
    const hasMore = page.length > limit;
    const observations = hasMore ? page.slice(0, limit) : page;
    const cursor = observations.length > 0 ? observations[observations.length - 1]!.seq : after;
    return { observations, cursor, hasMore, oldestSeq };
  }

  /**
   * Advance the observe cursor. A settlement observation cannot be acknowledged
   * before its delivery receipt is committed, and the cursor never moves back.
   */
  private observeAck(request: ObserveAckRequest) {
    const current = this.store.getObserveCursor(this.homeId);
    if (request.cursor < current) {
      throw new ProtocolError(
        "CURSOR_INVALID",
        `cursor ${request.cursor} is behind the committed cursor ${current}`,
      );
    }
    for (const settlement of this.store.settlementObservationsBetween(
      this.homeId,
      current,
      request.cursor,
    )) {
      if (!settlement.operationId) continue;
      const record = this.store.getOperation(settlement.operationId);
      if (!record || record.receipt === null) {
        throw new ProtocolError(
          "RECEIPT_REQUIRED",
          `settlement ${settlement.seq} has no committed delivery receipt`,
        );
      }
    }
    this.store.setObserveCursor(this.homeId, request.cursor, this.now());
    return { cursor: request.cursor };
  }

  /** Record the mirrored outcome receipt for an operation. Idempotent. */
  private async receipt(request: ReceiptRequest) {
    const existing = this.store.getOperation(request.operationId);
    if (!existing) {
      throw new ProtocolError("NOT_FOUND", "unknown operation");
    }
    if (existing.receipt && existing.receipt.seq !== request.seq) {
      throw new ProtocolError("CONFLICT", "operation already has a different outcome receipt");
    }
    await this.barrier("receipt.before");
    this.store.recordReceipt(request.operationId, request.seq, this.now());
    await this.barrier("receipt.after");
    return { recorded: true as const };
  }

  private submit(request: SubmitInput): SubmitResult {
    const payloadDigest = digestOf(request.payload);
    const configDigest = digestOf(request.config ?? null);
    if (request.payloadDigest !== undefined && request.payloadDigest !== payloadDigest) {
      throw new ProtocolError("DIGEST_MISMATCH", "payloadDigest does not match the submitted payload");
    }
    if (request.configDigest !== undefined && request.configDigest !== configDigest) {
      throw new ProtocolError("DIGEST_MISMATCH", "configDigest does not match the submitted configuration");
    }

    const existing = this.store.getOperation(request.operationId);
    if (existing) {
      if (
        existing.payloadDigest === payloadDigest &&
        existing.configDigest === configDigest &&
        existing.supervisorId === request.supervisorId
      ) {
        return { record: existing, replayed: true };
      }
      throw new ProtocolError(
        "CONFLICT",
        "operation ID already accepted with a different payload or configuration",
      );
    }

    const at = this.now();
    const record: OperationRecord = {
      operationId: request.operationId,
      homeId: this.homeId,
      supervisorId: request.supervisorId,
      state: "accepted",
      payloadDigest,
      configDigest,
      rowIds: request.rowIds ?? [],
      ownerGeneration: request.ownerGeneration ?? null,
      wakeClaimId: request.wakeClaimId ?? null,
      result: null,
      receipt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.store.insertOperation(record);
    return { record, replayed: false };
  }

  private failure(op: string, operationId: string | undefined, error: unknown): SidecarResponse {
    const code = error instanceof ProtocolError ? error.code : "INTERNAL";
    const id = operationId ? ` operationId=${operationId}` : "";
    this.logger(`op=${op} code=${code}${id}`);
    return errorResponse(error);
  }

  private respond(socket: Socket, response: SidecarResponse): void {
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${encodeResponse(response)}\n`);
  }

  /** Stop accepting, close the store and provider, and release the lock. */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = this.doStop();
    }
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.logger(`op=stop homeId=${this.homeId} pid=${process.pid}`);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.provider.close();
    this.store.close();
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Already gone.
    }
    this.lock.release();
  }
}

function validateCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw new ProtocolError("CWD_INVALID", "cwd must be an absolute path");
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      throw new ProtocolError("CWD_INVALID", "cwd must be a directory");
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("CWD_INVALID", "cwd does not exist");
  }
}

function requireSameClaim(existing: SupervisorBinding, request: AuthorityBinding): void {
  if (existing.wakeClaimId !== request.wakeClaimId || !sameRows(existing.rowIds, request.rowIds)) {
    throw new ProtocolError("AUTHORITY_CONFLICT", "same generation carries a different claim or row set");
  }
}

function sameRows(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((row) => set.has(row));
}

function rowSubset(requested: readonly string[], recorded: readonly string[]): boolean {
  const set = new Set(recorded);
  return requested.every((row) => set.has(row));
}

function operationIdOf(request: SidecarRequest): string | undefined {
  return request.op === "submit" || request.op === "inspect" ? request.operationId : undefined;
}
