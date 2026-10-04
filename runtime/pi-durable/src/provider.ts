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
import { createModels, type MutableModels } from "@earendil-works/pi-ai";
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
  /** Register model providers before any execution. Absent means none. */
  configureModels?: (models: MutableModels) => void;
};

/** A model-provider configurer, re-exported so the service stays upstream-free. */
export type ModelConfigurer = NonNullable<DurableProviderOptions["configureModels"]>;

export type EnsureConversationResult = {
  conversationId: string;
  created: boolean;
};

export type RunSupervisionInput = {
  conversationId: string;
  prompt: string;
};

type EntryRecordLike = {
  id?: unknown;
  model?: unknown;
};

function assistantText(entry: EntryRecordLike | undefined): string {
  const model = entry?.model;
  if (!Array.isArray(model)) return "";
  const first = model[0] as { content?: unknown } | undefined;
  const content = first?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const typed = part as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .join("");
}

export class DurableProvider {
  readonly storePath: string;
  private readonly configureModels?: (models: MutableModels) => void;
  private harness: Harness | null = null;
  private opening: Promise<Harness> | null = null;

  constructor(options: DurableProviderOptions) {
    this.storePath = options.storePath;
    this.configureModels = options.configureModels;
  }

  private async openHarness(): Promise<Harness> {
    if (this.harness) return this.harness;
    if (!this.opening) {
      this.opening = (async () => {
        const storage = await openNodeSqliteStorage(this.storePath);
        const models = createModels();
        this.configureModels?.(models);
        const harness = await Harness.open(
          storage,
          { models, registry: createRegistry() },
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

  /**
   * Run one supervision prompt on the pinned conversation and return the
   * parsed JSON of its settled assistant answer.
   */
  async runSupervision(input: RunSupervisionInput): Promise<JsonValue> {
    const harness = await this.openHarness();
    const conversation: Conversation | undefined = await harness.conversation(
      input.conversationId as never,
      BACKGROUND_CONTEXT,
    );
    if (!conversation) {
      throw new Error(`supervision conversation ${input.conversationId} was not found`);
    }
    const submission = await conversation.submit(
      { type: "input", content: input.prompt },
      BACKGROUND_CONTEXT,
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.status !== "done" || settled.type !== "input") {
      const reason = (settled as { reason?: string }).reason;
      throw new Error(`supervision submission did not settle done (${settled.status}${reason ? `: ${reason}` : ""})`);
    }
    const state = await conversation.viewState(BACKGROUND_CONTEXT);
    const entries = (state as unknown as { value: { entries?: EntryRecordLike[] } }).value?.entries ?? [];
    const answerId = (settled as { answer?: unknown }).answer;
    const entry = entries.find((candidate) => candidate.id === answerId);
    const text = assistantText(entry);
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      throw new Error("supervision answer was not valid JSON");
    }
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
