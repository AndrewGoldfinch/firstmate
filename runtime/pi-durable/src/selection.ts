/**
 * Provider selection for the supervision branch execution seam (P1C).
 *
 * The existing in-process Pi branch is the default. The durable sidecar is
 * selected only by an explicit local config value, so an unconfigured home
 * keeps the current path unchanged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ExecutionProvider = "existing" | "pi-durable";

/** Config key under the home's `config/` directory. */
export const EXECUTION_PROVIDER_FILE = "supervision-execution";

export class SelectionError extends Error {
  readonly code = "SELECTION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SelectionError";
  }
}

/**
 * Read the configured execution provider.
 *
 * Absent or empty selects `existing`. An unrecognized value is refused rather
 * than silently falling back.
 */
export function readExecutionProvider(configDir: string): ExecutionProvider {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, EXECUTION_PROVIDER_FILE), "utf8").trim();
  } catch {
    return "existing";
  }
  if (raw === "" || raw === "existing") return "existing";
  if (raw === "pi-durable") return "pi-durable";
  throw new SelectionError(
    `unknown supervision execution provider ${JSON.stringify(raw)} (expected existing or pi-durable)`,
  );
}
