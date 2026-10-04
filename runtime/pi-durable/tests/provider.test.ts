/**
 * Provider identity test: a conversation created for the sidecar is pinned to
 * the adapter's own narrow agent grant and never adopts an unrelated root
 * conversation's broader configuration.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DurableProvider } from "../src/provider.ts";
import type { JsonValue, PinnedAgent } from "../src/protocol.ts";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-pi-durable-provider-"));
  homes.push(home);
  return home;
}

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("a fresh conversation does not inherit an unrelated root configuration", async () => {
  const home = tempHome();
  const storePath = join(home, "runtime.sqlite");

  // Pre-create the reserved root with a broad configuration the sidecar must ignore.
  const storage = await openNodeSqliteStorage(storePath);
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  await harness.root(BACKGROUND_CONTEXT, { agent: { instructions: "BROAD ROOT" } });
  await harness.close(BACKGROUND_CONTEXT);

  const agent: PinnedAgent = {
    model: { provider: "openai", modelId: "gpt-6-sol" },
    thinkingLevel: "high",
    instructions: "pinned",
    cwd: home,
  };
  const provider = new DurableProvider({ storePath });
  try {
    const created = await provider.ensureConversation({ agent });
    assert.equal(created.created, true);
    const readBack = (await provider.readAgentConfig(created.conversationId)) as Record<string, JsonValue>;
    assert.deepEqual(readBack.extensions, []);
    assert.deepEqual(readBack.tools, []);
    assert.equal(readBack.instructions, "pinned");
    assert.equal(readBack.cwd, home);

    // A second ensure call reattaches the same conversation, never a new one.
    const again = await provider.ensureConversation({ conversationId: created.conversationId, agent });
    assert.equal(again.conversationId, created.conversationId);
    assert.equal(again.created, false);
  } finally {
    await provider.close();
  }
});
