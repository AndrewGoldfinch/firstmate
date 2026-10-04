/**
 * Durable dispatch CLI (P1C).
 *
 * The Pi supervision extension runs inside Pi's own process and cannot import
 * this package, so it invokes the bridge through this small CLI. One JSON
 * request on stdin, one JSON result on stdout. The CLI adds no policy of its
 * own: selection, authority, and outcome semantics live in the modules it
 * composes.
 */

import { readFileSync } from "node:fs";
import { runDurableDispatch } from "./bridge.ts";
import { SidecarClient } from "./sidecar-client.ts";
import { createOutcomeSink } from "./outcome-sink.ts";
import type { JsonValue } from "./protocol.ts";

type CliInput = {
  socketPath: string;
  homeId: string;
  supervisorId: string;
  capabilityProfile: string;
  ownerGeneration: number;
  wakeClaimId: string;
  rowIds: string[];
  operationId: string;
  prompt: string;
  payload: JsonValue;
  outcomeScript: string;
};

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(0, "utf8")) as CliInput;
  const transport = new SidecarClient({
    socketPath: input.socketPath,
    homeId: input.homeId,
    supervisorId: input.supervisorId,
    capabilityProfile: input.capabilityProfile,
    ownerGeneration: input.ownerGeneration,
    wakeClaimId: input.wakeClaimId,
    rowIds: input.rowIds,
  });
  const sink = createOutcomeSink({ scriptPath: input.outcomeScript });
  const result = await runDurableDispatch(
    { transport, sink },
    { operationId: input.operationId, prompt: input.prompt, payload: input.payload },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
