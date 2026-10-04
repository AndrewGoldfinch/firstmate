/**
 * Upstream Durable adapter (P1A service/protocol, P1B identity and authority).
 *
 * Every call into `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and
 * `@earendil-works/chord` lives here so the service and protocol stay free of
 * upstream API details. P1B creates or reattaches a dedicated supervision
 * conversation with an explicit pinned agent configuration, so it never
 * inherits tools from an unrelated root conversation.
 */

import { createRequire } from "node:module";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { JsonValue, PinnedAgent } from "./protocol.ts";

const require = createRequire(import.meta.url);

type Conversation = Awaited<ReturnType<Harness["createConversation"]>>;

function packageVersion(name: string): string {
  try {
    return (require(`${name}/package.json`) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/** Versions of the pinned upstream dependencies, for the health response. */
export function dependencyVersions(): Record<string, string> {
  return {
    "@earendil-works/pi-durable": packageVersion("@earendil-works/pi-durable"),
    "@earendil-works/pi-ai": packageVersion("@earendil-works/pi-ai"),
    "@earendil-works/chord": packageVersion("@earendil-works/chord"),
  };
}

export type DurableProviderOptions = {
  /** Path to the upstream Durable SQLite conversation store. */
  storePath: string;
};

export type EnsureConversationResult = {
  conversationId: string;
  created: boolean;
};

export class DurableProvider {
  readonly storePath: string;
  private harness: Harness | null = null;
  private opening: Promise<Harness> | null = null;

  constructor(options: DurableProviderOptions) {
    this.storePath = options.storePath;
  }

  private async openHarness(): Promise<Harness> {
    if (this.harness) return this.harness;
    if (!this.opening) {
      this.opening = (async () => {
        const storage = await openNodeSqliteStorage(this.storePath);
        const harness = await Harness.open(
          storage,
          { models: createModels(), registry: createRegistry() },
          BACKGROUND_CONTEXT,
        );
        this.harness = harness;
        return harness;
      })();
    }
    return this.opening;
  }

  /**
   * Locate the recorded conversation, or create a fresh one pinned to `agent`.
   *
   * A new conversation is created with `ownership: ownerless` and an explicit
   * agent grant, never by adopting the reserved root conversation, so an
   * unrelated root configuration cannot widen its tools.
   */
  async ensureConversation(input: {
    conversationId?: string;
    agent: PinnedAgent;
  }): Promise<EnsureConversationResult> {
    const harness = await this.openHarness();
    if (input.conversationId) {
      const existing = await harness.conversation(input.conversationId as never, BACKGROUND_CONTEXT);
      if (existing) {
        return { conversationId: String(existing.id), created: false };
      }
    }
    const created = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: {
            provider: input.agent.model.provider,
            modelId: input.agent.model.modelId,
          },
          thinkingLevel: input.agent.thinkingLevel,
          extensions: [],
          tools: [],
          ...(input.agent.instructions !== undefined
            ? { instructions: input.agent.instructions }
            : {}),
          cwd: input.agent.cwd,
        },
      },
      BACKGROUND_CONTEXT,
    );
    return { conversationId: String(created.id), created: true };
  }

  /** Read the pinned `pi.agent` document of a conversation, for verification. */
  async readAgentConfig(conversationId: string): Promise<JsonValue> {
    const harness = await this.openHarness();
    const conversation: Conversation | undefined = await harness.conversation(
      conversationId as never,
      BACKGROUND_CONTEXT,
    );
    if (!conversation) return null;
    const state = await conversation.viewState(BACKGROUND_CONTEXT);
    const docs = (state as unknown as { value: { docs?: Record<string, JsonValue> } }).value?.docs;
    return docs?.["pi.agent"] ?? null;
  }

  /** Resume any run the previous process left unfinished. Harness-wide. */
  async resume(): Promise<void> {
    const harness = await this.openHarness();
    harness.resume();
  }

  async close(): Promise<void> {
    const harness = this.harness;
    this.harness = null;
    this.opening = null;
    if (harness) {
      await harness.close(BACKGROUND_CONTEXT);
    }
  }
}
