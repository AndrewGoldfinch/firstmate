/**
 * P1B identity and authority tests.
 *
 * Gate: restart returns to the original operation and conversation; stale work
 * cannot execute a guarded mutation; a fresh conversation is pinned to the
 * narrow capability profile and cannot inherit broader tools.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DurableSidecar } from "../src/service.ts";
import { PROTOCOL_VERSION, type EnsureSupervisorResult, type JsonValue } from "../src/protocol.ts";
import { call } from "./helpers/client.ts";
import { ensureSupervisorRequest, resumeRequest, submitRequest } from "./helpers/requests.ts";

const homes: string[] = [];
const sidecars: DurableSidecar[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-pi-durable-identity-"));
  homes.push(home);
  return home;
}

async function start(home: string, overrides: Partial<Parameters<typeof DurableSidecar.start>[0]> = {}) {
  const sidecar = await DurableSidecar.start({ home, ...overrides });
  sidecars.push(sidecar);
  return sidecar;
}

function errorCode(response: unknown): string | undefined {
  const parsed = response as { ok: boolean; error?: { code: string } };
  return parsed.ok ? undefined : parsed.error?.code;
}

function ensuredResult(response: unknown): EnsureSupervisorResult {
  assert.equal((response as { ok: boolean }).ok, true);
  return (response as { ok: true; result: EnsureSupervisorResult }).result;
}

after(async () => {
  for (const sidecar of sidecars) await sidecar.stop();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("restart returns to the original operation and conversation", async () => {
  const home = tempHome();
  const first = await start(home);
  const ensure = ensureSupervisorRequest({
    homeId: first.homeId,
    cwd: home,
    generation: 17,
    wakeClaimId: "claim-17",
    rowIds: ["row-1", "row-2"],
  });
  const conversationId = ensuredResult(await call(first.socketPath, ensure)).conversationId;
  assert.equal((await call(first.socketPath, submitRequest(first.homeId, "op-restart", { a: 1 }))).ok, true);
  await first.stop();

  const second = await start(home);
  const reensured = ensuredResult(await call(second.socketPath, ensure));
  assert.equal(reensured.conversationId, conversationId);
  assert.equal(reensured.created, false);

  const inspected = await call(second.socketPath, {
    protocolVersion: PROTOCOL_VERSION,
    homeId: second.homeId,
    op: "inspect",
    operationId: "op-restart",
  });
  assert.equal((inspected as { ok: true; result: { record: unknown } }).result.record !== null, true);
});

test("stale work cannot execute a guarded mutation", async () => {
  const home = tempHome();
  const sidecar = await start(home);
  const base = {
    homeId: sidecar.homeId,
    cwd: home,
    generation: 17,
    wakeClaimId: "claim-17",
    rowIds: ["row-1", "row-2"],
  };
  ensuredResult(await call(sidecar.socketPath, ensureSupervisorRequest(base)));

  assert.equal(
    errorCode(await call(sidecar.socketPath, resumeRequest({ ...base, generation: 16 }))),
    "AUTHORITY_STALE",
  );
  assert.equal(
    errorCode(await call(sidecar.socketPath, resumeRequest({ ...base, generation: 18 }))),
    "AUTHORITY_UNKNOWN",
  );
  assert.equal(
    errorCode(await call(sidecar.socketPath, resumeRequest({ ...base, wakeClaimId: "other" }))),
    "AUTHORITY_CONFLICT",
  );
  assert.equal(
    errorCode(await call(sidecar.socketPath, resumeRequest({ ...base, rowIds: ["row-9"] }))),
    "AUTHORITY_SCOPE",
  );

  const allowed = await call(sidecar.socketPath, resumeRequest(base));
  assert.equal(allowed.ok, true);
  assert.equal((allowed as { ok: true; result: { resumed: boolean } }).result.resumed, true);
});

test("a fresh conversation is pinned to the narrow capability profile", async () => {
  const home = tempHome();
  const sidecar = await start(home);
  const result = ensuredResult(
    await call(sidecar.socketPath, ensureSupervisorRequest({ homeId: sidecar.homeId, cwd: home })),
  );
  const agent = result.agent as Record<string, JsonValue>;
  assert.deepEqual(agent.extensions, []);
  assert.deepEqual(agent.tools, []);
  assert.equal(agent.cwd, home);
});

test("unknown capability profiles and invalid cwd are refused", async () => {
  const home = tempHome();
  const sidecar = await start(home);
  assert.equal(
    errorCode(
      await call(sidecar.socketPath, {
        ...ensureSupervisorRequest({ homeId: sidecar.homeId, cwd: home }),
        capabilityProfile: "supervision-admin-v1",
      }),
    ),
    "CAPABILITY_UNKNOWN",
  );
  assert.equal(
    errorCode(await call(sidecar.socketPath, ensureSupervisorRequest({ homeId: sidecar.homeId, cwd: "relative/path" }))),
    "CWD_INVALID",
  );
});

test("the pin is immutable within a generation and renewed across generations", async () => {
  const home = tempHome();
  const sidecar = await start(home);
  const first = ensuredResult(
    await call(sidecar.socketPath, ensureSupervisorRequest({ homeId: sidecar.homeId, cwd: home, generation: 5, instructions: "one" })),
  );
  assert.equal(
    errorCode(
      await call(
        sidecar.socketPath,
        ensureSupervisorRequest({ homeId: sidecar.homeId, cwd: home, generation: 5, instructions: "two" }),
      ),
    ),
    "CONFIG_CONFLICT",
  );

  const second = ensuredResult(
    await call(sidecar.socketPath, ensureSupervisorRequest({ homeId: sidecar.homeId, cwd: home, generation: 6, instructions: "two" })),
  );
  assert.notEqual(second.conversationId, first.conversationId);
  assert.equal(second.created, true);
});
