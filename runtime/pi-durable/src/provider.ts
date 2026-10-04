/**
 * Upstream Durable adapter (P1A).
 *
 * Every call into `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and
 * `@earendil-works/chord` lives here so the service and protocol stay free of
 * upstream API details. P1A opens the durable conversation store and finds or
 * creates the root supervision conversation; it does not submit or resume any
 * model work.
 */

import { createRequire } from "node:module";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const require = createRequire(import.meta.url);

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

  /** Find or create the root supervision conversation and return its id. */
  async ensureRootConversation(): Promise<string> {
    const harness = await this.openHarness();
    const root = await harness.root(BACKGROUND_CONTEXT);
    return String(root.id);
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
