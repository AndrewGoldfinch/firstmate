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
  const sidecar = await start(tempHome());
  const first = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "ensureSupervisor",
    supervisorId: "pi-supervisor",
  });
  const second = await call(sidecar.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: sidecar.homeId,
    op: "ensureSupervisor",
    supervisorId: "pi-supervisor",
  });
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
