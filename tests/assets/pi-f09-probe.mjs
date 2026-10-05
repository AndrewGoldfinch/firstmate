// Delivery-boundary regression probe. Called by fm-pi-branch-live-e2e.test.sh.
// Real extension, SDK, renderer and stores; no model calls. The controller
// survives SIGKILL of each consumer and observes session JSONL independently,
// and asserts one committed note yields exactly one home-wide delivery across
// restart, destination replacement, and stale-owner takeover, with no loss.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fork, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { createHash } from "node:crypto";

const SUMMARY = "F09_PROBE_ONE_LOGICAL_NOTE";
const TYPE = "fm-branch-visible-routine";
const self = fileURLToPath(import.meta.url);
const root = resolve(process.env.FM_F09_ROOT);
const pkg = resolve(process.env.PI_PACKAGE_DIR);
const readJsonl = (path) => fs.existsSync(path)
  ? fs.readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const isNote = (entry) => (entry.type === "custom" && entry.customType === TYPE && entry.data?.summary === SUMMARY)
  || (entry.type === "custom_message" && entry.customType === "fm-branch-merge" && entry.content?.includes(SUMMARY));

async function worker() {
  const home = process.env.FM_HOME;
  const sessionFile = process.env.FM_F09_SESSION;
  // Only this disposable destination is intercepted, at the filesystem write
  // after the extension's ownership check. All actual writes use the real SDK.
  let pauseBeforeWrite = false;
  const ioErrors = [];
  const append = fs.appendFileSync;
  fs.appendFileSync = function (path, data, ...args) {
    if (pauseBeforeWrite && path === sessionFile && String(data).includes(TYPE)) {
      pauseBeforeWrite = false;
      fs.writeFileSync(join(home, "before-write"), String(process.pid));
      process.kill(process.pid, "SIGSTOP");
    }
    try {
      return append(path, data, ...args);
    } catch (error) {
      if (path === sessionFile) ioErrors.push(error.code);
      throw error;
    }
  };
  syncBuiltinESMExports();
  globalThis.fetch = async () => { throw new Error("network is forbidden in the F09 probe"); };
  const { DefaultResourceLoader, InteractiveMode, SessionManager, SettingsManager,
    createAgentSession, initTheme } = await import(pathToFileURL(join(pkg, "dist/index.js")).href);
  initTheme("dark");
  const cwd = join(home, "cwd");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const manager = SessionManager.open(sessionFile, dirname(sessionFile));
  if (process.env.FM_F09_INITIALIZE === "1" && !fs.existsSync(sessionFile)) {
    manager.appendMessage({ role: "user", content: "Local fixture initialization", timestamp: Date.now() });
  }
  const settings = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: [process.env.FM_F09_PLUGIN], noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "extension must load, never pass vacuously");
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager,
    settingsManager: settings, resourceLoader: loader, tools: [] });
  assert.ok(session.extensionRunner.getEntryRenderer(TYPE), "real routine renderer must be registered");
  const ui = new InteractiveMode({ session, setBeforeSessionInvalidate() {}, setRebindSession() {} },
    { tuiMode: "alt-screen" });
  ui.isInitialized = true;
  ui.subscribeToAgent();
  ui.renderInitialMessages();
  const errors = [];
  const snapshot = () => ({ pid: process.pid, sessionFile,
    memoryRecords: manager.getEntries().filter(isNote).length,
    renderedCopies: ui.chatContainer.render(240).join("\n").split(SUMMARY).length - 1,
    errors: [...errors], ioErrors: [...ioErrors] });
  let chain = Promise.resolve();
  process.on("message", ({ id, command }) => {
    chain = chain.then(async () => {
      if (command === "start") await session.bindExtensions({ onError: (error) => errors.push(String(error.error)) });
      // Deterministic retry trigger, through the real ExtensionRunner. No model
      // turn or live terminal is claimed by emitting this lifecycle event.
      else if (command === "retry") await session.extensionRunner.emit({ type: "turn_end", turnIndex: 0,
        message: { role: "assistant", content: [] }, toolResults: [] });
      else if (command === "pause-before-write") pauseBeforeWrite = true;
      else if (command === "converse") manager.appendMessage({ role: "user", content: "Local fixture conversation", timestamp: Date.now() });
      else assert.equal(command, "snapshot");
      process.send({ id, snapshot: snapshot() });
    }).catch((error) => { process.send({ id, error: error.stack }); });
  });
  process.send({ ready: snapshot() });
}

async function controller() {
  const lab = resolve(process.env.FM_F09_LAB);
  fs.mkdirSync(lab, { recursive: true });
  const active = new Set();
  const observations = [];
  const hash = (path) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
  const report = { schemaVersion: 1,
    sourceCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    extensionSha256: hash(process.env.FM_F09_PLUGIN), probeSha256: hash(self),
    piVersion: JSON.parse(fs.readFileSync(join(pkg, "package.json"), "utf8")).version,
    nodeVersion: process.version, platform: process.platform, timestamp: new Date().toISOString(),
    verdict: "INCOMPLETE", scope: "Real SDK + extension + renderer; synthetic lifecycle triggers, no model or terminal",
    observations };
  // Retain partial evidence too: a missed barrier or broken harness is never
  // silently omitted from a requested result file.
  const save = () => {
    if (process.env.FM_PI_F09_OUTPUT) fs.writeFileSync(process.env.FM_PI_F09_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  };
  const bash = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  const fakebin = join(lab, "fakebin");
  fs.mkdirSync(fakebin);
  fs.writeFileSync(join(fakebin, "bash"), `#!/bin/sh
if [ "$1" = "$FM_F09_ROOT/bin/fm-branch-outcome.sh" ] && [ "$2" = mark-read ] && [ -f "$FM_HOME/fail-ack" ]; then
  rm "$FM_HOME/fail-ack"
  echo cursor-write-failed >> "$FM_HOME/faults.log"
  exit 9
fi
exec "$FM_F09_BASH" "$@"
`, { mode: 0o755 });
  const outcome = (home, args) => execFileSync(bash, [join(root, "bin/fm-branch-outcome.sh"), ...args], {
    encoding: "utf8", env: { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: root,
      FM_STATE_OVERRIDE: join(home, "state"), FM_CONFIG_OVERRIDE: join(home, "config") },
  }).trim();
  function setup(name) {
    const home = join(lab, name);
    for (const dir of ["state", "config", "sessions"]) fs.mkdirSync(join(home, dir), { recursive: true });
    const seq = outcome(home, ["append", "--task", "fixture", "--verdict", "routine", "--summary", SUMMARY,
      "--operation-key", `fm:f09:${name}:1`]);
    assert.equal(seq, "1");
    // Independently prove this scenario begins with a single idempotent row.
    assert.equal(outcome(home, ["append", "--task", "fixture", "--verdict", "routine", "--summary", SUMMARY,
      "--operation-key", `fm:f09:${name}:1`]), "1");
    return home;
  }
  function observe(home, stage, snapshot) {
    const files = fs.readdirSync(join(home, "sessions")).filter((file) => file.endsWith(".jsonl"));
    const record = { scenario: home.split("/").at(-1), stage, ...snapshot,
      cursor: fs.existsSync(join(home, "state/.branch-outcomes-cursor"))
        ? Number(fs.readFileSync(join(home, "state/.branch-outcomes-cursor"), "utf8")) : 0,
      unread: outcome(home, ["unread"]).split("\n").filter(Boolean).length,
      outcomeRows: readJsonl(join(home, "state/branch-outcomes.jsonl")).length,
      diskRecords: files.flatMap((file) => readJsonl(join(home, "sessions", file))).filter(isNote).length,
      destinationRecords: readJsonl(snapshot.sessionFile).filter(isNote).length,
      lockPid: Number(fs.readFileSync(join(home, "state/.lock"), "utf8")),
      failedAcks: fs.existsSync(join(home, "faults.log"))
        ? fs.readFileSync(join(home, "faults.log"), "utf8").trim().split("\n").length : 0,
      deliveryMarkers: fs.existsSync(join(home, "state/.branch-outcomes-delivered"))
        ? fs.readdirSync(join(home, "state/.branch-outcomes-delivered")).length : 0 };
    assert.equal(record.outcomeRows, 1, "delivery must never alter outcome cardinality");
    assert.deepEqual(record.errors, [], "unexpected SDK error invalidates the probe");
    observations.push(record);
    save();
    return record;
  }
  async function launch(home, { durable = true, initialize = true, destination = "main" } = {}) {
    const child = fork(self, ["--worker"], { execArgv: [], cwd: home, silent: true, env: {
      ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: root, FM_STATE_OVERRIDE: join(home, "state"),
      FM_CONFIG_OVERRIDE: join(home, "config"), FM_PI_DURABLE_DELIVERY: durable ? "1" : "0",
      PI_CODING_AGENT_DIR: join(home, "agent-dir"), FM_F09_SESSION: join(home, "sessions", `${destination}.jsonl`),
      FM_F09_INITIALIZE: initialize ? "1" : "0", FM_F09_BASH: bash, PATH: `${fakebin}:${process.env.PATH}`,
    } });
    active.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const pending = new Map();
    let serial = 0;
    function wait(id) {
      return new Promise((resolveWait, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`consumer ${id} timeout: ${output}`)); }, 30000);
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveWait(value); },
          reject: (error) => { clearTimeout(timer); reject(error); } });
      });
    }
    child.on("message", (message) => {
      const id = message.ready ? "ready" : message.id;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.ready ?? message.snapshot);
    });
    child.on("exit", (code, signal) => {
      active.delete(child);
      for (const waiter of pending.values()) waiter.reject(new Error(`consumer exited ${code}/${signal}: ${output}`));
      pending.clear();
    });
    child.on("error", (error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
    const ready = await wait("ready");
    return { child, ready, async request(command) {
      const id = ++serial;
      const result = wait(id);
      child.send({ id, command });
      return result;
    } };
  }
  async function kill(consumer) {
    const exited = once(consumer.child, "exit");
    consumer.child.kill("SIGKILL");
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    observations.push({ stage: "consumer-killed", pid: consumer.child.pid, signal });
  }
  const grant = (home, consumer) => fs.writeFileSync(join(home, "state/.lock"), `${consumer.child.pid}\n`);
  const failAck = (home) => fs.writeFileSync(join(home, "fail-ack"), "1");
  try {
    for (const durable of [false, true]) {
      const home = setup(durable ? "durable-restart" : "default-restart");
      const first = await launch(home, { durable });
      grant(home, first);
      failAck(home);
      const before = observe(home, "delivery-before-failed-ack", await first.request("start"));
      assert.equal(before.renderedCopies, 1);
      assert.equal(before.diskRecords, 1);
      assert.equal(before.unread, 1);
      assert.equal(before.failedAcks, 1);
      await kill(first);
      const second = await launch(home, { durable });
      grant(home, second);
      const after = observe(home, "reopened-and-retried", await second.request("start"));
      assert.equal(after.diskRecords, durable ? 1 : 2);
      assert.equal(after.renderedCopies, durable ? 1 : 2);
      assert.equal(after.unread, 0);
      await kill(second);
    }
    {
      const home = setup("fresh-session");
      const first = await launch(home, { initialize: false });
      grant(home, first);
      const before = observe(home, "fresh-session-ack", await first.request("start"));
      assert.equal(before.memoryRecords, 1);
      assert.equal(before.diskRecords, 0);
      // A session Pi has not flushed cannot acknowledge: the note is deferred,
      // never lost, and the cursor must not cross it.
      assert.equal(before.unread, 1);
      assert.equal(before.cursor, 0);
      assert.equal(before.deliveryMarkers, 0);
      await kill(first);
      const second = await launch(home, { initialize: false });
      grant(home, second);
      const after = observe(home, "restart-after-skipped-persistence", await second.request("start"));
      assert.equal(after.diskRecords, 0);
      assert.equal(after.unread, 1, "the deferred note must still be recoverable after a restart");
      assert.equal(after.deliveryMarkers, 0);
      // The first conversation is what lets Pi flush the session file: the
      // deferred note lands on disk exactly once, then reconciles and reads.
      const flushed = observe(home, "conversation-flushes-deferred-note", await second.request("converse"));
      assert.equal(flushed.diskRecords, 1);
      assert.equal(flushed.unread, 1);
      const settled = observe(home, "reconcile-after-flush", await second.request("retry"));
      assert.equal(settled.diskRecords, 1);
      assert.equal(settled.unread, 0);
      assert.equal(settled.deliveryMarkers, 0, "a read row clears its home-wide marker");
      await kill(second);
    }
    {
      const home = setup("write-failure");
      const first = await launch(home);
      grant(home, first);
      fs.chmodSync(first.ready.sessionFile, 0o400);
      const failed = observe(home, "session-write-denied", await first.request("start"));
      // The denied append is rolled back out of Pi's in-memory model, so no
      // phantom can suppress the retry that persists it.
      assert.equal(failed.memoryRecords, 0);
      assert.equal(failed.diskRecords, 0);
      assert.equal(failed.renderedCopies, 0);
      assert.equal(failed.unread, 1);
      assert.equal(failed.deliveryMarkers, 0);
      assert.deepEqual(failed.ioErrors, ["EACCES"], "the real session write must be denied by the OS");
      // The denied append is retried for real once the file is writable again:
      // the durable record lands exactly once and only then does the cursor
      // cross it.
      fs.chmodSync(first.ready.sessionFile, 0o600);
      const recovered = observe(home, "retry-after-storage-recovery", await first.request("retry"));
      assert.equal(recovered.diskRecords, 1);
      assert.equal(recovered.unread, 0);
      assert.equal(recovered.deliveryMarkers, 0);
      await kill(first);
      const second = await launch(home);
      grant(home, second);
      const after = observe(home, "restart-after-recovery", await second.request("start"));
      assert.equal(after.diskRecords, 1);
      assert.equal(after.unread, 0);
      assert.equal(after.deliveryMarkers, 0);
      await kill(second);
    }
    {
      const home = setup("new-destination-before-ack");
      const first = await launch(home);
      grant(home, first);
      failAck(home);
      const before = observe(home, "delivered-in-original-destination", await first.request("start"));
      assert.equal(before.diskRecords, 1);
      assert.equal(before.renderedCopies, 1);
      assert.equal(before.unread, 1);
      await kill(first);
      const second = await launch(home, { destination: "replacement" });
      grant(home, second);
      const after = observe(home, "delivered-in-replacement-destination", await second.request("start"));
      // One committed note is one home-wide delivery: the replacement recognizes
      // it by identity, renders nothing new, and only completes the cursor.
      assert.equal(after.diskRecords, 1);
      assert.equal(after.renderedCopies, 0);
      assert.equal(after.unread, 0);
      assert.equal(after.deliveryMarkers, 0);
      await kill(second);
    }
    {
      const home = setup("takeover-at-destination-write");
      const first = await launch(home);
      const second = await launch(home);
      // Control: a stale consumer checked before delivery must remain inert.
      grant(home, second);
      const refused = observe(home, "old-owner-before-check", await first.request("start"));
      assert.equal(refused.diskRecords, 0);
      assert.equal(refused.unread, 1);
      grant(home, first);
      await first.request("pause-before-write");
      const blocked = first.request("start");
      // Cleanup may kill this consumer if another assertion fails before the
      // barrier is released. Preserve that rejection for await below.
      blocked.catch(() => {});
      // Observe the actual stopped process, not merely a marker preceding stop.
      let stopped = false;
      for (let i = 0; i < 300; i++) {
        const status = execFileSync("ps", ["-o", "stat=", "-p", String(first.child.pid)], { encoding: "utf8" });
        if (fs.existsSync(join(home, "before-write")) && status.trim().startsWith("T")) { stopped = true; break; }
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.ok(stopped, "old consumer must reach the real destination-write barrier");
      grant(home, second);
      const coreReplacement = observe(home, "replacement-delivers-while-old-stopped", await second.request("start"));
      assert.equal(coreReplacement.diskRecords, 1);
      assert.equal(coreReplacement.renderedCopies, 1);
      assert.equal(coreReplacement.unread, 0);
      assert.equal(coreReplacement.deliveryMarkers, 0);
      first.child.kill("SIGCONT");
      const stale = observe(home, "old-owner-resumes-after-replacement", await blocked);
      assert.notEqual(stale.pid, stale.lockPid);
      // The stale owner lost the delivery fence and removed its own duplicate;
      // the home keeps exactly one recorded delivery.
      assert.equal(stale.diskRecords, 1);
      assert.equal(stale.renderedCopies, 1);
      assert.equal(stale.unread, 0);
      assert.equal(stale.deliveryMarkers, 0);
      await kill(first);
      await kill(second);
    }
    report.verdict = "PASS";
    save();
    for (const row of observations.filter((row) => row.scenario)) console.log(JSON.stringify(row));
    console.log("F09_PROBE_COMPLETE verdict=PASS; one committed note is one home-wide delivery across restart, destination replacement, and stale-owner takeover");
  } catch (error) {
    report.verdict = "PROBE_FAILED";
    report.error = error.stack;
    save();
    throw error;
  } finally {
    await Promise.all([...active].map(async (child) => { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }));
  }
}

if (process.argv.includes("--worker")) await worker();
else await controller();
