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
  /**
   * Append the settled operation's outcome and record its delivery receipt as
   * one authority-guarded unit on the sidecar. The sidecar owns the append, so
   * a replacement cannot land between the authority check and the write.
   */
  appendOutcome(input: { operationId: string; result: CandidateResult }): Promise<{ seq: number }>;
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
 * appends nothing, so a repeated result cannot commit a conflicting outcome.
 * The sidecar performs the append and the receipt under its ownership lock, so
 * an owner replacement cannot slip a stale outcome row into the store.
 */
export async function runDurableDispatch(
  deps: { transport: DispatchTransport },
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
  let seq: number;
  try {
    seq = (
      await deps.transport.appendOutcome({ operationId: input.operationId, result: candidate })
    ).seq;
  } catch (error) {
    // A definite refusal means nothing was appended; surface its own code. Any
    // other failure may or may not have applied the outcome, so never declare
    // success.
    if (error instanceof BridgeError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new BridgeError(
      "RECONCILE_REQUIRED",
      `outcome append could not be completed (${reason}); reconcile before retrying`,
    );
  }
  return dispatched.replayed
    ? { seq, replayed: true, reconciled: true }
    : { seq, replayed: false };
}
