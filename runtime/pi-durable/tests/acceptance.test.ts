/**
 * Acceptance-gate tests for durable operation acceptance.
 *
 * These exercise the P1A gate: a repeat operation ID returns the original, a
 * changed payload or configuration under the same ID is refused, a lost reply
 * reconciles without a new execution, no secret reaches recorded payloads or
 * diagnostics, and the message and outstanding bounds hold.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DurableSidecar } from "../src/service.ts";
import { PROTOCOL_VERSION, digestOf, type SubmitResult } from "../src/protocol.ts";
import { call, exchange } from "./helpers/client.ts";

const homes: string[] = [];
const sidecars: DurableSidecar[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-pi-durable-accept-"));
  homes.push(home);
  return home;
}

async function start(home: string, overrides: Partial<Parameters<typeof DurableSidecar.start>[0]> = {}) {
  const sidecar = await DurableSidecar.start({ home, ...overrides });
  sidecars.push(sidecar);
  return sidecar;
}

function submitRequest(homeId: string, operationId: string, payload: unknown, config?: unknown) {
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

function resultOf(response: unknown): SubmitResult {
  assert.equal((response as { ok: boolean }).ok, true);
  return (response as { ok: true; result: SubmitResult }).result;
}

after(async () => {
  for (const sidecar of sidecars) await sidecar.stop();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("a repeat operation ID returns the original acceptance without a new execution", async () => {
  const sidecar = await start(tempHome());
  const payload = { rowIds: ["row-101"], wakeClaimId: "claim-1" };
  const config = { model: "pi", effort: "high" };

  const first = resultOf(await call(sidecar.socketPath, submitRequest(sidecar.homeId, "op-1", payload, config)));
  assert.equal(first.replayed, false);
  assert.equal(first.record.state, "accepted");
  assert.equal(first.record.payloadDigest, digestOf(payload as never));
  assert.equal(first.record.configDigest, digestOf(config as never));

  // A lost reply is reconciled by repeating the identical operation.
  const second = resultOf(await call(sidecar.socketPath, submitRequest(sidecar.homeId, "op-1", payload, config)));
  assert.equal(second.replayed, true);
  assert.deepEqual(second.record, first.record);

  const inspected = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "inspect",
    operationId: "op-1",
  });
  assert.equal((inspected as { ok: true; result: { record: unknown } }).result.record !== null, true);
  assert.equal(sidecar.storePath.length > 0, true);
});

test("a changed payload under a repeated operation ID is refused", async () => {
  const sidecar = await start(tempHome());
  resultOf(await call(sidecar.socketPath, submitRequest(sidecar.homeId, "op-2", { a: 1 })));
  const conflict = await call(sidecar.socketPath, submitRequest(sidecar.homeId, "op-2", { a: 2 }));
  assert.equal(conflict.ok, false);
  assert.equal((conflict as { ok: false; error: { code: string } }).error.code, "CONFLICT");
});

test("a changed configuration under a repeated operation ID is refused", async () => {
  const sidecar = await start(tempHome());
  resultOf(await call(sidecar.socketPath, submitRequest(sidecar.homeId, "op-3", { a: 1 }, { effort: "low" })));
  const conflict = await call(sidecar.socketPath, submitRequest(sidecar.homeId, "op-3", { a: 1 }, { effort: "high" }));
  assert.equal(conflict.ok, false);
  assert.equal((conflict as { ok: false; error: { code: string } }).error.code, "CONFLICT");
});

test("a supplied digest that disagrees with the payload is refused", async () => {
  const sidecar = await start(tempHome());
  const response = await call(sidecar.socketPath, {
    ...submitRequest(sidecar.homeId, "op-4", { a: 1 }),
    payloadDigest: digestOf({ a: 999 }),
  });
  assert.equal(response.ok, false);
  assert.equal((response as { ok: false; error: { code: string } }).error.code, "DIGEST_MISMATCH");
});

test("inspect returns null for an unknown operation", async () => {
  const sidecar = await start(tempHome());
  const response = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "inspect",
    operationId: "missing",
  });
  assert.equal(response.ok, true);
  assert.equal((response as { ok: true; result: { record: null } }).result.record, null);
});

test("no secret appears in recorded payloads, diagnostics, or replies", async () => {
  const secret = "sk-live-super-secret-2f8a1c";
  const logs: string[] = [];
  const sidecar = await start(tempHome(), { logger: (line) => logs.push(line) });
  const payload = { note: "routine", apiKey: secret, nested: { password: secret } };

  const response = await call(sidecar.socketPath, submitRequest(sidecar.homeId, "op-secret", payload));
  assert.equal(response.ok, true);

  // The response carries only digests, never the payload.
  assert.equal(JSON.stringify(response).includes(secret), false);

  // The adapter store records only digests, so the store file cannot hold it.
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${sidecar.storePath}${suffix}`;
    if (existsSync(path)) {
      assert.equal(readFileSync(path).includes(secret), false, `${path} must not contain the secret`);
    }
  }

  // Diagnostics never echo payload values.
  assert.equal(logs.join("\n").includes(secret), false);
  assert.ok(logs.some((line) => line.includes("op=start")));
});

test("an oversized frame is refused", async () => {
  const sidecar = await start(tempHome(), { maxMessageBytes: 512 });
  const frame = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "submit",
    operationId: "op-big",
    supervisorId: "sup",
    payload: { blob: "x".repeat(4096) },
  });
  const response = await call(sidecar.socketPath, JSON.parse(frame));
  assert.equal(response.ok, false);
  assert.equal((response as { ok: false; error: { code: string } }).error.code, "MESSAGE_TOO_LARGE");
});

test("the outstanding-operations bound is enforced", async () => {
  const sidecar = await start(tempHome(), { maxOutstanding: 1 });
  const frames = [
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      homeId: sidecar.homeId,
      op: "ensureSupervisor",
      supervisorId: "sup-a",
    }),
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      homeId: sidecar.homeId,
      op: "ensureSupervisor",
      supervisorId: "sup-b",
    }),
  ];
  const lines = await exchange(sidecar.socketPath, frames, 2);
  const codes = lines.map((line) => {
    const parsed = JSON.parse(line) as { ok: boolean; error?: { code: string } };
    return parsed.ok ? "ok" : parsed.error?.code;
  });
  assert.deepEqual(codes.sort(), ["BUSY", "ok"]);
});
