/**
 * Unix-domain socket client for the sidecar protocol (P1C).
 *
 * One request per connection, NDJSON framing, bounded by the protocol's own
 * message cap on the server side. The client never interprets upstream state;
 * it only transports the protocol.
 */

import { connect } from "node:net";
import {
  PROTOCOL_VERSION,
  type CancelResult,
  type CancelScope,
  type DispatchResult,
  type ReadToolResult,
  type SidecarRequest,
  type SidecarResponse,
} from "./protocol.ts";
import type { DispatchOutcome, DispatchTransport } from "./bridge.ts";

export type SidecarClientOptions = {
  socketPath: string;
  homeId: string;
  supervisorId: string;
  capabilityProfile: string;
  ownerGeneration: number;
  wakeClaimId: string;
  rowIds: string[];
};

export async function sidecarRequest(
  socketPath: string,
  request: SidecarRequest,
): Promise<SidecarResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index >= 0 && !settled) {
        settled = true;
        const line = buffer.slice(0, index);
        socket.end();
        resolve(JSON.parse(line) as SidecarResponse);
      }
    });
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("sidecar closed before responding"));
      }
    });
  });
}

export class SidecarClient implements DispatchTransport {
  private readonly options: SidecarClientOptions;

  constructor(options: SidecarClientOptions) {
    this.options = options;
  }

  private authority() {
    const { homeId, supervisorId, capabilityProfile, ownerGeneration, wakeClaimId, rowIds } =
      this.options;
    return {
      protocolVersion: PROTOCOL_VERSION,
      homeId,
      supervisorId,
      capabilityProfile,
      ownerGeneration,
      wakeClaimId,
      rowIds,
    };
  }

  async dispatch(input: {
    operationId: string;
    prompt: string;
    payload: unknown;
  }): Promise<DispatchOutcome> {
    const response = await sidecarRequest(this.options.socketPath, {
      ...this.authority(),
      op: "dispatch",
      operationId: input.operationId,
      prompt: input.prompt,
      payload: input.payload as never,
    });
    if (!response.ok) {
      return { ok: false, code: response.error.code, message: response.error.message };
    }
    const result = response.result as DispatchResult;
    return {
      ok: true,
      result: result.result,
      replayed: result.replayed,
      receipt: result.record.receipt,
    };
  }

  async recordReceipt(operationId: string, seq: number): Promise<void> {
    const response = await sidecarRequest(this.options.socketPath, {
      protocolVersion: PROTOCOL_VERSION,
      homeId: this.options.homeId,
      op: "receipt",
      operationId,
      seq,
    });
    if (!response.ok) {
      throw new Error(`sidecar refused the outcome receipt: ${response.error.code}`);
    }
  }

  /** Invoke one declared read tool under this client's authority binding. */
  async readTool(operationId: string, tool: string): Promise<ReadToolResult> {
    const response = await sidecarRequest(this.options.socketPath, {
      ...this.authority(),
      op: "readTool",
      operationId,
      tool,
    });
    if (!response.ok) {
      throw new Error(`sidecar refused read tool ${tool}: ${response.error.code}`);
    }
    return response.result as ReadToolResult;
  }

  /** Persist cancellation intent and request runtime abort for one operation. */
  async cancel(operationId: string, scope: CancelScope = "operation"): Promise<CancelResult> {
    const response = await sidecarRequest(this.options.socketPath, {
      ...this.authority(),
      op: "cancel",
      operationId,
      scope,
    });
    if (!response.ok) {
      throw new Error(`sidecar refused cancellation: ${response.error.code}`);
    }
    return response.result as CancelResult;
  }
}
