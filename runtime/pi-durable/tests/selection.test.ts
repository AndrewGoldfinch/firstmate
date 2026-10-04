/**
 * P1C provider-selection tests: the existing path is the default, and only an
 * explicit config value selects the durable sidecar.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  EXECUTION_PROVIDER_FILE,
  SelectionError,
  readExecutionProvider,
} from "../src/selection.ts";

const dirs: string[] = [];

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fm-pi-durable-selection-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("an absent config selects the existing path", () => {
  assert.equal(readExecutionProvider(tempConfigDir()), "existing");
});

test("an empty config selects the existing path", () => {
  const dir = tempConfigDir();
  writeFileSync(join(dir, EXECUTION_PROVIDER_FILE), "\n");
  assert.equal(readExecutionProvider(dir), "existing");
});

test("an explicit pi-durable value selects the durable path", () => {
  const dir = tempConfigDir();
  writeFileSync(join(dir, EXECUTION_PROVIDER_FILE), "pi-durable\n");
  assert.equal(readExecutionProvider(dir), "pi-durable");
});

test("an explicit existing value selects the existing path", () => {
  const dir = tempConfigDir();
  writeFileSync(join(dir, EXECUTION_PROVIDER_FILE), "existing\n");
  assert.equal(readExecutionProvider(dir), "existing");
});

test("an unknown value is refused rather than silently defaulted", () => {
  const dir = tempConfigDir();
  writeFileSync(join(dir, EXECUTION_PROVIDER_FILE), "something-else\n");
  assert.throws(
    () => readExecutionProvider(dir),
    (error: unknown) => error instanceof SelectionError,
  );
});
