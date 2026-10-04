/**
 * Service lifecycle and boundary tests: owner exclusion, socket permissions,
 * home and protocol refusal, supervisor identity, and shutdown.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DurableSidecar } from "../src/service.ts";
import { OwnerConflictError } from "../src/lock.ts";
import { PROTOCOL_VERSION, type HealthResult } from "../src/protocol.ts";
import { call } from "./helpers/client.ts";
import { ensureSupervisorRequest } from "./helpers/requests.ts";

const homes: string[] = [];
const sidecars: DurableSidecar[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-pi-durable-home-"));
  homes.push(home);
  return home;
}

async function start(home: string, overrides: Partial<Parameters<typeof DurableSidecar.start>[0]> = {}) {
  const sidecar = await DurableSidecar.start({ home, ...overrides });
  sidecars.push(sidecar);
  return sidecar;
}

after(async () => {
  for (const sidecar of sidecars) await sidecar.stop();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("health reports protocol, home, owner, and dependencies", async () => {
  const sidecar = await start(tempHome());
  const response = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "health",
  });
  assert.equal(response.ok, true);
  const health = (response as { ok: true; result: HealthResult }).result;
  assert.equal(health.protocolVersion, PROTOCOL_VERSION);
  assert.equal(health.homeId, sidecar.homeId);
  assert.equal(health.owner.pid, process.pid);
  assert.equal(health.dependencies["@earendil-works/pi-durable"], "1.0.1");
});

test("the socket and its directory are private", async () => {
  const sidecar = await start(tempHome());
  assert.equal(statSync(sidecar.socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(sidecar.stateDir).mode & 0o777, 0o700);
});

test("a wrong home is refused", async () => {
  const sidecar = await start(tempHome());
  const response = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: "/some/other/home",
    op: "health",
  });
  assert.equal(response.ok, false);
  assert.equal((response as { ok: false; error: { code: string } }).error.code, "HOME_MISMATCH");
});

test("an incompatible protocol is refused", async () => {
  const sidecar = await start(tempHome());
  const response = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION + 1,
    homeId: sidecar.homeId,
    op: "health",
  });
  assert.equal(response.ok, false);
  assert.equal((response as { ok: false; error: { code: string } }).error.code, "PROTOCOL_MISMATCH");
});

test("a second owner for the same home is refused", async () => {
  const home = tempHome();
  await start(home);
  await assert.rejects(() => DurableSidecar.start({ home }), (error: unknown) => {
    return error instanceof OwnerConflictError;
  });
});

test("ensureSupervisor is idempotent per home and supervisor", async () => {
  const home = tempHome();
  const sidecar = await start(home);
  const request = ensureSupervisorRequest({ homeId: sidecar.homeId, cwd: home });
  const first = await call(sidecar.socketPath, request);
  const second = await call(sidecar.socketPath, request);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const a = (first as { ok: true; result: { conversationId: string; created: boolean } }).result;
  const b = (second as { ok: true; result: { conversationId: string; created: boolean } }).result;
  assert.equal(a.conversationId, b.conversationId);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
});

test("shutdown stops the service and releases the socket", async () => {
  const home = tempHome();
  const sidecar = await start(home);
  const response = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "shutdown",
  });
  assert.equal(response.ok, true);
  await sidecar.stop();
  assert.equal(existsSync(sidecar.socketPath), false);
  // The home can be owned again after shutdown.
  const restarted = await start(home);
  assert.equal(restarted.homeId, sidecar.homeId);
});

test("cancellation persists intent before abort and retains the records", async () => {
  const home = tempHome();
  const sidecar = await start(home);
  const ensured = await call(
    sidecar.socketPath,
    ensureSupervisorRequest({ homeId: sidecar.homeId, cwd: home }),
  );
  assert.equal(ensured.ok, true);
  const conversationId = ensured.ok
    ? (ensured.result as { conversationId: string }).conversationId
    : "";

  const authority = {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    supervisorId: "pi-supervisor",
    capabilityProfile: "supervision-observe-v1",
    ownerGeneration: 1,
    wakeClaimId: "claim-1",
    rowIds: [],
  };

  const submitted = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "submit",
    operationId: "op-cancel",
    supervisorId: "pi-supervisor",
    payload: { task: "T1" },
    config: { conversationId },
  });
  assert.equal(submitted.ok, true);

  const missing = await call(sidecar.socketPath, {
    ...authority,
    op: "cancel",
    operationId: "op-other",
    scope: "operation",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? "" : missing.error.code, "NOT_FOUND");

  const background = await call(sidecar.socketPath, {
    ...authority,
    op: "cancel",
    operationId: "op-cancel",
    scope: "background",
  });
  assert.equal(background.ok, false);
  assert.equal(background.ok ? "" : background.error.code, "SCOPE_UNSUPPORTED");

  const cancelled = await call(sidecar.socketPath, {
    ...authority,
    op: "cancel",
    operationId: "op-cancel",
    scope: "operation",
  });
  assert.equal(cancelled.ok, true);
  const result = cancelled.ok
    ? (cancelled.result as {
        settled: boolean;
        state: string;
        intentPersisted: boolean;
        unresolved: string[];
        retained: { operation: boolean; outcomesUntouched: boolean };
      })
    : null;
  assert.equal(result?.intentPersisted, true);
  assert.equal(result?.settled, true);
  assert.equal(result?.state, "cancelled");
  assert.deepEqual(result?.unresolved, []);
  assert.equal(result?.retained.operation, true);
  assert.equal(result?.retained.outcomesUntouched, true);
  assert.ok((result?.retained.observations ?? 0) >= 3, "cancellation observations must be retained");

  const observed = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "observe",
    after: 0,
    limit: 64,
  });
  const kinds = observed.ok
    ? (observed.result as { observations: { kind: string; operationId: string | null }[] })
        .observations.filter((observation) => observation.operationId === "op-cancel")
        .map((observation) => observation.kind)
    : [];
  const intentIndex = kinds.indexOf("cancellation-intent");
  const abortIndex = kinds.indexOf("cancellation-abort");
  assert.ok(intentIndex >= 0, "cancellation intent must be recorded");
  assert.ok(abortIndex > intentIndex, "intent must be durable before the abort request");
  assert.ok(kinds.includes("cancellation-settled"), "the verified outcome must be recorded");

  const inspected = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "inspect",
    operationId: "op-cancel",
  });
  const record = inspected.ok
    ? (inspected.result as { record: { state: string } | null }).record
    : null;
  assert.equal(record?.state, "cancelled");

  const redispatch = await call(sidecar.socketPath, {
    ...authority,
    op: "dispatch",
    operationId: "op-cancel",
    prompt: "p",
    payload: { task: "T1" },
  });
  assert.equal(redispatch.ok, false);
  assert.equal(redispatch.ok ? "" : redispatch.error.code, "RECONCILE_REQUIRED");
});
