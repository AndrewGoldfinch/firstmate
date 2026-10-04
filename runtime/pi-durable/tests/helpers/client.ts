/**
 * Minimal NDJSON client used by the sidecar tests.
 *
 * It speaks the protocol over a Unix-domain socket and returns decoded
 * responses. It asserts nothing; tests own the assertions.
 */

import { connect } from "node:net";
import type { SidecarResponse } from "../../src/protocol.ts";

export function exchange(socketPath: string, frames: string[], expected: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    const out: string[] = [];
    let settled = false;

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      for (const frame of frames) socket.write(`${frame}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        out.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (out.length >= expected && !settled) {
          settled = true;
          socket.end();
          resolve(out);
          return;
        }
        index = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.on("close", () => {
      if (!settled && out.length < expected) {
        settled = true;
        reject(new Error(`socket closed after ${out.length} of ${expected} responses`));
      }
    });
  });
}

export async function call(socketPath: string, request: unknown): Promise<SidecarResponse> {
  const [line] = await exchange(socketPath, [JSON.stringify(request)], 1);
  return JSON.parse(line!) as SidecarResponse;
}

export async function raw(socketPath: string, frame: string): Promise<SidecarResponse> {
  const [line] = await exchange(socketPath, [frame], 1);
  return JSON.parse(line!) as SidecarResponse;
}
