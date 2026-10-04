/**
 * Request builders for the sidecar tests.
 *
 * They keep the wire shape in one place so a protocol change updates the tests
 * from a single edit rather than every call site.
 */

import { PROTOCOL_VERSION } from "../../src/protocol.ts";

export type SupervisorInput = {
  homeId: string;
  cwd: string;
  supervisorId?: string;
  generation?: number;
  wakeClaimId?: string;
  rowIds?: string[];
  capabilityProfile?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  instructions?: string;
};

export function ensureSupervisorRequest(input: SupervisorInput) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    homeId: input.homeId,
    op: "ensureSupervisor",
    supervisorId: input.supervisorId ?? "pi-supervisor",
    ownerGeneration: input.generation ?? 1,
    wakeClaimId: input.wakeClaimId ?? "claim-1",
    rowIds: input.rowIds ?? [],
    capabilityProfile: input.capabilityProfile ?? "supervision-observe-v1",
    model: input.model ?? { provider: "openai", modelId: "gpt-6-sol" },
    thinkingLevel: input.thinkingLevel ?? "high",
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    cwd: input.cwd,
  };
}

export function resumeRequest(input: SupervisorInput) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    homeId: input.homeId,
    op: "resume",
    supervisorId: input.supervisorId ?? "pi-supervisor",
    ownerGeneration: input.generation ?? 1,
    wakeClaimId: input.wakeClaimId ?? "claim-1",
    rowIds: input.rowIds ?? [],
    capabilityProfile: input.capabilityProfile ?? "supervision-observe-v1",
  };
}

export function submitRequest(
  homeId: string,
  operationId: string,
  payload: unknown,
  config?: unknown,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    homeId,
    op: "submit",
    operationId,
    supervisorId: "pi-supervisor",
    payload,
    ...(config !== undefined ? { config } : {}),
  };
}

export function dispatchRequest(
  input: SupervisorInput & { operationId: string; prompt: string; payload: unknown },
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    homeId: input.homeId,
    op: "dispatch",
    supervisorId: input.supervisorId ?? "pi-supervisor",
    ownerGeneration: input.generation ?? 1,
    wakeClaimId: input.wakeClaimId ?? "claim-1",
    rowIds: input.rowIds ?? [],
    capabilityProfile: input.capabilityProfile ?? "supervision-observe-v1",
    operationId: input.operationId,
    prompt: input.prompt,
    payload: input.payload,
  };
}

export function receiptRequest(homeId: string, operationId: string, seq: number) {
  return { protocolVersion: PROTOCOL_VERSION, homeId, op: "receipt", operationId, seq };
}

export function observeRequest(homeId: string, after?: number, limit?: number) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    homeId,
    op: "observe",
    ...(after !== undefined ? { after } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export function observeAckRequest(homeId: string, cursor: number) {
  return { protocolVersion: PROTOCOL_VERSION, homeId, op: "observeAck", cursor };
}
