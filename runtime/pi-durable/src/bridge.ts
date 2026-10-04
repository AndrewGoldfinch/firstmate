/**
 * Dispatch and outcome bridge (P1C).
 *
 * The bridge submits one accepted supervision scope to the sidecar, validates
 * the candidate result, and routes it to the existing FirstMate outcome sink
 * with the same claim, sequence, and generation semantics. It never
 * acknowledges wake rows and never mutates the task lifecycle: it only appends
 * an outcome record and records the mirrored delivery receipt.
 */

import type { JsonValue } from "./protocol.ts";

export type CandidateVerdict = "routine" | "captain";

/** The schema-validated candidate supervision result. */
export type CandidateResult = {
  task: string;
  verdict: CandidateVerdict;
  summary: string;
  wake?: string;
  silent?: boolean;
};

export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

function malformed(message: string): never {
  throw new BridgeError("MALFORMED_RESULT", message);
}

/** Validate one candidate result; every malformed shape is refused with a reason. */
export function parseCandidateResult(raw: unknown): CandidateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    malformed("candidate result must be a JSON object");
  }
  const source = raw as Record<string, unknown>;
  const allowed = new Set(["task", "verdict", "summary", "wake", "silent"]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) malformed(`candidate result has an unknown field ${JSON.stringify(key)}`);
  }
  const task = source.task;
  if (typeof task !== "string" || task.trim().length === 0) {
    malformed("candidate result task must be a non-empty string");
  }
  const verdict = source.verdict;
  if (verdict !== "routine" && verdict !== "captain") {
    malformed("candidate result verdict must be routine or captain");
  }
  const summary = source.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    malformed("candidate result summary must be a non-empty string");
  }
  const wake = source.wake;
  if (wake !== undefined && typeof wake !== "string") {
    malformed("candidate result wake must be a string when present");
  }
  const silent = source.silent;
  if (silent !== undefined && typeof silent !== "boolean") {
    malformed("candidate result silent must be a boolean when present");
  }
  return {
    task,
    verdict,
    summary,
    ...(wake !== undefined ? { wake } : {}),
    ...(silent !== undefined ? { silent } : {}),
  };
}

/** The existing outcome sink, owner: `bin/fm-branch-outcome.sh`. */
export type OutcomeSink = {
  /**
   * Atomically append the candidate result under the operation key, or return
   * the sequence of the row already stored under that key. The key is the
   * operation identity, so a retry and two distinct operations with identical
   * text can never collide or duplicate.
   */
  appendOrGet(operationKey: string, result: CandidateResult): Promise<number>;
};

export type DispatchOutcome =
  | { ok: true; result: JsonValue; replayed: boolean; receipt: { seq: number } | null }
  | { ok: false; code: string; message: string };

/** The sidecar transport the bridge depends on. */
export type DispatchTransport = {
  dispatch(input: {
    operationId: string;
    prompt: string;
    payload: JsonValue;
  }): Promise<DispatchOutcome>;
  recordReceipt(operationId: string, seq: number): Promise<void>;
};

export type DurableDispatchInput = {
  operationId: string;
  prompt: string;
  payload: JsonValue;
};

export type DurableDispatchResult = {
  seq: number;
  replayed: boolean;
  /** True when a missing receipt was reconciled through the sink read-back. */
  reconciled?: boolean;
};

/**
 * Submit one accepted scope, validate the result, and route it to the outcome
 * sink.
 *
 * A settled repeat whose receipt was already recorded returns that receipt and
 * appends nothing, so a repeated result cannot commit a conflicting outcome. A
 * settled repeat with no receipt is reconciled through the sink read-back when
 * the sink has one, and refused as before when it does not.
 */
export async function runDurableDispatch(
  deps: { transport: DispatchTransport; sink: OutcomeSink },
  input: DurableDispatchInput,
): Promise<DurableDispatchResult> {
  const dispatched = await deps.transport.dispatch({
    operationId: input.operationId,
    prompt: input.prompt,
    payload: input.payload,
  });
  if (!dispatched.ok) {
    throw new BridgeError(dispatched.code, dispatched.message);
  }
  if (dispatched.replayed && dispatched.receipt) {
    return { seq: dispatched.receipt.seq, replayed: true };
  }
  const candidate = parseCandidateResult(dispatched.result);
  // Outcome mutation boundary: revalidate current authority with the sidecar
  // after settlement and before anything is appended or receipted. An owner
  // replacement between the model run and this point refuses here, so the
  // stale operation never appends an outcome or records a receipt.
  const verified = await deps.transport.dispatch({
    operationId: input.operationId,
    prompt: input.prompt,
    payload: input.payload,
  });
  if (!verified.ok) {
    throw new BridgeError(verified.code, verified.message);
  }
  let seq: number;
  try {
    seq = await deps.sink.appendOrGet(input.operationId, candidate);
  } catch (error) {
    // The outcome may or may not have been applied; never declare success.
    const reason = error instanceof Error ? error.message : String(error);
    throw new BridgeError(
      "RECONCILE_REQUIRED",
      `outcome append-or-get could not be completed (${reason}); reconcile before retrying`,
    );
  }
  await deps.transport.recordReceipt(input.operationId, seq);
  return dispatched.replayed
    ? { seq, replayed: true, reconciled: true }
    : { seq, replayed: false };
}
