// Phase 1 bounded pilot probe. Called by fm-pi-phase1-pilot.test.sh.
//
// It drives the REAL Pi supervision extension (`.pi/extensions/fm-branch-supervision.ts`),
// the REAL installed @earendil-works/pi-coding-agent SDK, the real headless
// transcript renderer, and the real outcome store, with no model and no
// network. On top of the F09 delivery-boundary probe it exercises the REAL
// session-lock protocol: `state/.lock` names an ANCHOR process, and each
// consumer's extension process is a descendant of its own anchor, so
// ownership is decided by the extension's real `ps`-walked ancestry
// (`lockOwnership`/`lockOwnershipSync`) rather than by writing the consumer's
// own pid into the lock.
//
// It validates the three Phase 1 gates on the opt-in durable path
// (`FM_PI_DURABLE_DELIVERY=1`):
//   1. real lock handover with a delivery in flight (option 2);
//   2. normal session lifecycle (start -> delivered -> session end -> fresh
//      session -> no re-delivery) plus flag-off byte-for-byte presentation;
//   3. a bounded concurrent soak (fixed cycle count and wall-clock cap).
//
// Any duplicate or loss is a HOLD: the probe reports the failing schedule
// exactly. Env: FM_PHASE1_LAB, FM_PHASE1_PLUGIN, FM_PHASE1_ROOT, PI_PACKAGE_DIR
// (required), FM_PHASE1_BASELINE_PLUGIN, FM_PHASE1_OUTPUT, FM_PHASE1_CYCLES,
// FM_PHASE1_SOAK_SECONDS (optional).
import assert from "node:assert/strict";
import fs from "node:fs";
import { fork, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const SUMMARY = "PHASE1_ROUTINE_NOTE";
const TASK = "fixture";
const DURABLE_TYPE = "fm-branch-visible-routine";
const PLAIN_TYPE = "fm-branch-merge";
const EXPECTED_PLAIN_BODY = `\u26f5 ${TASK}: ${SUMMARY}`;
const self = fileURLToPath(import.meta.url);
const root = resolve(process.env.FM_PHASE1_ROOT ?? process.cwd());
const pkg = resolve(process.env.PI_PACKAGE_DIR ?? join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent"));

const readJsonl = (path) => fs.existsSync(path)
  ? fs.readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const isDurableNote = (entry) => entry.type === "custom" && entry.customType === DURABLE_TYPE
  && entry.data && typeof entry.data === "object" && entry.data.summary === SUMMARY;
const isPlainNote = (entry) => entry.type === "custom_message" && entry.customType === PLAIN_TYPE
  && String(entry.content ?? "").includes(SUMMARY);
const isNote = (entry) => isDurableNote(entry) || isPlainNote(entry);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// Worker: the real extension inside a real Pi session.
// ---------------------------------------------------------------------------
async function worker() {
  const home = process.env.FM_HOME;
  const sessionFile = process.env.FM_PHASE1_SESSION;
  // Only this disposable destination is intercepted, at the filesystem write
  // after the extension's ownership check. All actual writes use the real SDK.
  let pauseBeforeWrite = false;
  let pauseAfterWrite = false;
  const ioErrors = [];
  const append = fs.appendFileSync;
  fs.appendFileSync = function (path, data, ...args) {
    const note = (pauseBeforeWrite || pauseAfterWrite) && path === sessionFile && String(data).includes(DURABLE_TYPE);
    let stopAfterWrite = false;
    if (note) {
      stopAfterWrite = pauseAfterWrite;
      fs.writeFileSync(join(home, stopAfterWrite ? "after-write" : "before-write"), String(process.pid));
      pauseBeforeWrite = false;
      pauseAfterWrite = false;
      if (!stopAfterWrite) process.kill(process.pid, "SIGSTOP");
    }
    try {
      const result = append(path, data, ...args);
      if (stopAfterWrite) process.kill(process.pid, "SIGSTOP");
      return result;
    } catch (error) {
      if (path === sessionFile) ioErrors.push(error.code);
      throw error;
    }
  };
  syncBuiltinESMExports();
  globalThis.fetch = async () => { throw new Error("network is forbidden in the Phase 1 probe"); };
  const { DefaultResourceLoader, InteractiveMode, SessionManager, SettingsManager,
    createAgentSession, initTheme } = await import(pathToFileURL(join(pkg, "dist/index.js")).href);
  initTheme("dark");
  const cwd = join(home, "cwd");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const manager = SessionManager.open(sessionFile, dirname(sessionFile));
  if (process.env.FM_PHASE1_INITIALIZE === "1" && !fs.existsSync(sessionFile)) {
    manager.appendMessage({ role: "user", content: "Local fixture initialization", timestamp: Date.now() });
  }
  const settings = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: [process.env.FM_PHASE1_PLUGIN], noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "extension must load, never pass vacuously");
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager,
    settingsManager: settings, resourceLoader: loader, tools: [] });
  if (/^(1|true|yes)$/i.test(process.env.FM_PI_DURABLE_DELIVERY ?? "")) {
    assert.ok(session.extensionRunner.getEntryRenderer(DURABLE_TYPE), "real routine renderer must be registered");
  }
  const ui = new InteractiveMode({ session, setBeforeSessionInvalidate() {}, setRebindSession() {} },
    { tuiMode: "alt-screen" });
  ui.isInitialized = true;
  ui.subscribeToAgent();
  ui.renderInitialMessages();
  const errors = [];
  const presentations = () => manager.getEntries().filter(isNote).map((entry) => ({
    customType: entry.customType,
    content: typeof entry.content === "string" ? entry.content : undefined,
    display: entry.display,
    hasDetails: entry.details !== undefined,
    deliveryId: entry.data && typeof entry.data === "object" ? entry.data.deliveryId : undefined,
    seq: entry.data && typeof entry.data === "object" ? entry.data.seq : undefined,
  }));
  const snapshot = () => ({ pid: process.pid, sessionFile,
    memoryRecords: manager.getEntries().filter(isNote).length,
    renderedCopies: ui.chatContainer.render(240).join("\n").split(SUMMARY).length - 1,
    presentations: presentations(), errors: [...errors], ioErrors: [...ioErrors] });
  let chain = Promise.resolve();
  process.on("message", ({ id, command }) => {
    chain = chain.then(async () => {
      if (command === "start") await session.bindExtensions({ onError: (error) => errors.push(String(error.error)) });
      // Deterministic retry trigger, through the real ExtensionRunner. No model
      // turn or live terminal is claimed by emitting this lifecycle event.
      else if (command === "retry") await session.extensionRunner.emit({ type: "turn_end", turnIndex: 0,
        message: { role: "assistant", content: [] }, toolResults: [] });
      else if (command === "pause-before-write") pauseBeforeWrite = true;
      else if (command === "pause-after-write") pauseAfterWrite = true;
      else if (command === "converse") manager.appendMessage({ role: "user", content: "Local fixture conversation", timestamp: Date.now() });
      else assert.equal(command, "snapshot");
      process.send({ id, snapshot: snapshot() });
    }).catch((error) => { process.send({ id, error: error.stack }); });
  });
  process.send({ ready: snapshot() });
}

// ---------------------------------------------------------------------------
// Anchor: a live ancestor named by state/.lock, relaying IPC to its worker.
// ---------------------------------------------------------------------------
async function anchor() {
  const child = fork(self, ["--worker"], { execArgv: [], cwd: process.cwd(), silent: true, env: process.env });
  const forward = (message) => { try { process.send(message); } catch { /* controller may be gone */ } };
  child.on("message", forward);
  child.on("exit", (code, signal) => forward({ anchorEvent: "worker-exit", code, signal }));
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  process.on("message", (message) => {
    if (message && message.command === "anchor-exit") {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      process.exit(0);
    }
    try { child.send(message); } catch { /* worker may be gone */ }
  });
  process.send({ anchor: true, workerPid: child.pid });
}

// ---------------------------------------------------------------------------
// Controller: one isolated home per scenario.
// ---------------------------------------------------------------------------
async function controller() {
  const lab = resolve(process.env.FM_PHASE1_LAB);
  fs.mkdirSync(lab, { recursive: true });
  const active = new Set();
  const observations = [];
  const plugin = resolve(process.env.FM_PHASE1_PLUGIN);
  const hash = (path) => sha(fs.readFileSync(path));
  const report = { schemaVersion: 1,
    sourceCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    extensionSha256: hash(plugin), probeSha256: hash(self),
    baselineExtensionSha256: process.env.FM_PHASE1_BASELINE_PLUGIN && fs.existsSync(process.env.FM_PHASE1_BASELINE_PLUGIN)
      ? hash(process.env.FM_PHASE1_BASELINE_PLUGIN) : null,
    piVersion: JSON.parse(fs.readFileSync(join(pkg, "package.json"), "utf8")).version,
    nodeVersion: process.version, platform: process.platform, timestamp: new Date().toISOString(),
    verdict: "INCOMPLETE",
    scope: "Real SDK + real extension + real renderer + real lock ancestry walk; synthetic lifecycle triggers, no model or terminal",
    schedulesReached: [], schedulesNotReached: [], residuals: [], observations };
  const save = () => {
    if (process.env.FM_PHASE1_OUTPUT) fs.writeFileSync(process.env.FM_PHASE1_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  };
  const bash = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  // One-shot mark-read fault on the real outcome script, injected through a
  // PATH shim exactly as the F09 probe does: the extension, the script, and the
  // cursor write all run for real; only the armed call fails once.
  const fakebin = join(lab, "fakebin");
  fs.mkdirSync(fakebin, { recursive: true });
  fs.writeFileSync(join(fakebin, "bash"), `#!/bin/sh
if [ "$1" = "$FM_PHASE1_ROOT/bin/fm-branch-outcome.sh" ] && [ "$2" = mark-read ] && [ -f "$FM_HOME/fail-ack" ]; then
  rm "$FM_HOME/fail-ack"
  echo cursor-write-failed >> "$FM_HOME/faults.log"
  exit 9
fi
exec "$FM_PHASE1_BASH" "$@"
`, { mode: 0o755 });
  const outcome = (home, args) => execFileSync(bash, [join(root, "bin/fm-branch-outcome.sh"), ...args], {
    encoding: "utf8", env: { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: root,
      FM_STATE_OVERRIDE: join(home, "state"), FM_CONFIG_OVERRIDE: join(home, "config") },
  }).trim();
  function setup(name) {
    const home = join(lab, name);
    for (const dir of ["state", "config", "sessions"]) fs.mkdirSync(join(home, dir), { recursive: true });
    const seq = outcome(home, ["append", "--task", TASK, "--verdict", "routine", "--summary", SUMMARY,
      "--operation-key", `fm:phase1:${name}:1`]);
    assert.equal(seq, "1");
    assert.equal(outcome(home, ["append", "--task", TASK, "--verdict", "routine", "--summary", SUMMARY,
      "--operation-key", `fm:phase1:${name}:1`]), "1");
    return home;
  }
  const homeEntries = (home) => {
    const dir = join(home, "sessions");
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl")).flatMap((file) => readJsonl(join(dir, file))) : [];
  };
  const homeDurableIdentities = (home) => new Set(homeEntries(home).filter(isDurableNote)
    .map((entry) => `${entry.data.seq}:${entry.data.deliveryId}`));
  const homePlainBodies = (home) => homeEntries(home).filter(isPlainNote)
    .map((entry) => (typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)));
  function marker(home) {
    const dir = join(home, "state/.branch-outcomes-delivered");
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((file) => /^[0-9]+$/.test(file));
    if (files.length === 0) return null;
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(join(dir, files[0]), "utf8")); } catch { parsed = null; }
    return { count: fs.readdirSync(dir).length, parsed };
  }
  function lockPid(home) {
    const file = join(home, "state/.lock");
    return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) : null;
  }
  function observe(home, stage, snapshot, extra = {}) {
    const markerState = marker(home);
    const record = { scenario: home.split("/").at(-1), stage, durable: extra.durable !== false, ...snapshot,
      anchorPid: extra.anchorPid,
      lockPid: lockPid(home),
      lockNamesAnchor: extra.anchorPid !== undefined && lockPid(home) === extra.anchorPid,
      cursor: fs.existsSync(join(home, "state/.branch-outcomes-cursor"))
        ? Number(fs.readFileSync(join(home, "state/.branch-outcomes-cursor"), "utf8")) : 0,
      unread: outcome(home, ["unread"]).split("\n").filter(Boolean).length,
      outcomeRows: readJsonl(join(home, "state/branch-outcomes.jsonl")).length,
      homeRecords: extra.durable === false ? homePlainBodies(home).length : homeDurableIdentities(home).size,
      homeDeliveryEntries: extra.durable === false ? homePlainBodies(home).length : homeEntries(home).filter(isDurableNote).length,
      destinationRecords: readJsonl(snapshot.sessionFile).filter(isNote).length,
      markerCount: markerState ? markerState.count : 0,
      markerStatus: markerState?.parsed?.status ?? null,
      markerOwner: markerState?.parsed?.owner ?? null,
      markerDeliveryId: markerState?.parsed?.deliveryId ?? null };
    assert.equal(record.outcomeRows, 1, "delivery must never alter outcome cardinality");
    assert.deepEqual(record.errors, [], "unexpected SDK error invalidates the probe");
    observations.push(record);
    save();
    return record;
  }
  async function launch(home, options = {}) {
    const durable = options.durable !== false;
    const destination = options.destination ?? "main";
    const initialize = options.initialize !== false;
    const pluginPath = options.pluginPath ?? plugin;
    const child = fork(self, ["--anchor"], { execArgv: [], cwd: home, silent: true, env: {
      ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: root, FM_STATE_OVERRIDE: join(home, "state"),
      FM_CONFIG_OVERRIDE: join(home, "config"), FM_PI_DURABLE_DELIVERY: durable ? "1" : "0",
      PI_CODING_AGENT_DIR: join(home, "agent-dir"), FM_PHASE1_SESSION: join(home, "sessions", `${destination}.jsonl`),
      FM_PHASE1_PLUGIN: pluginPath, FM_PHASE1_INITIALIZE: initialize ? "1" : "0",
      FM_PHASE1_ROOT: root, FM_PHASE1_BASH: bash, PATH: `${fakebin}:${process.env.PATH}`,
    } });
    active.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const pending = new Map();
    let serial = 0;
    let readyResolve; let readyReject;
    const readyPromise = new Promise((ready, reject) => { readyResolve = ready; readyReject = reject; });
    let workerResolve; let workerReject;
    const workerPromise = new Promise((worker, reject) => { workerResolve = worker; workerReject = reject; });
    const failAll = (error) => {
      readyReject(error); workerReject(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    let closedResolve; let closed = false;
    const closedPromise = new Promise((done) => { closedResolve = done; });
    function wait(id) {
      return new Promise((resolveWait, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`consumer ${id} timeout: ${output}`)); }, 30000);
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveWait(value); },
          reject: (error) => { clearTimeout(timer); reject(error); } });
      });
    }
    child.on("message", (message) => {
      if (message.anchor) { workerResolve(message.workerPid); return; }
      if (message.anchorEvent === "worker-exit") {
        failAll(new Error(`worker exited ${message.code}/${message.signal}: ${output}`));
        return;
      }
      if (message.ready) { readyResolve(message.ready); return; }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.snapshot);
    });
    child.on("exit", (code, signal) => {
      active.delete(child);
      if (!closed) { closed = true; closedResolve(); }
      failAll(new Error(`anchor exited ${code}/${signal}: ${output}`));
    });
    child.on("error", (error) => { failAll(error); });
    child.fmClosed = () => (closed ? Promise.resolve() : closedPromise);
    const ready = await readyPromise;
    const workerPid = await workerPromise;
    return { child, anchorPid: child.pid, workerPid, ready, home, closed: () => (closed ? Promise.resolve() : closedPromise),
      async request(command) {
        const id = ++serial;
        const result = wait(id);
        child.send({ id, command });
        return result;
      } };
  }
  const grant = (home, consumer) => fs.writeFileSync(join(home, "state/.lock"), `${consumer.anchorPid}\n`);
  const failAck = (home) => fs.writeFileSync(join(home, "fail-ack"), "1");
  async function end(consumer) {
    const exited = consumer.closed();
    try { consumer.child.send({ command: "anchor-exit" }); } catch { /* already gone */ }
    try { consumer.child.kill("SIGKILL"); } catch { /* already gone */ }
    await exited.catch(() => undefined);
  }
  async function endChild(child) {
    const exited = child.fmClosed ? child.fmClosed() : Promise.resolve();
    try { child.send({ command: "anchor-exit" }); } catch { /* already gone */ }
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await exited.catch(() => undefined);
  }
  async function waitForStop(consumer, markerName) {
    for (let i = 0; i < 300; i += 1) {
      let status = "";
      try { status = execFileSync("ps", ["-o", "stat=", "-p", String(consumer.workerPid)], { encoding: "utf8" }); } catch { status = ""; }
      if (fs.existsSync(join(consumer.home, markerName)) && status.trim().startsWith("T")) return true;
      await sleep(50);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Validation 1a: real lock ownership is decided by the ancestry walk.
  // -------------------------------------------------------------------------
  async function scheduleRealLockOwnership() {
    const home = setup("real-lock-ownership");
    const a = await launch(home, { destination: "main" });
    failAck(home);
    // Lock names A's anchor: A owns through the real ancestry walk, delivers
    // once, and its mark-read is denied so the row stays unread.
    grant(home, a);
    const owned = observe(home, "owner-delivers", await a.request("start"), { anchorPid: a.anchorPid });
    assert.equal(owned.homeRecords, 1, "the lock owner must deliver exactly once");
    assert.equal(owned.renderedCopies, 1);
    assert.equal(owned.unread, 1, "the failed acknowledgement keeps the row unread");
    assert.equal(owned.cursor, 0);
    assert.equal(owned.markerStatus, "committed");
    assert.equal(owned.lockNamesAnchor, true);
    // A fresh session whose anchor is NOT the lock must be inert even with the
    // row unread and a durable record on disk.
    const b = await launch(home, { destination: "main" });
    const inert = observe(home, "secondary-is-inert-under-a-lock", await b.request("start"), { anchorPid: b.anchorPid });
    assert.equal(inert.homeRecords, 1, "a session whose anchor is not the lock must not deliver");
    assert.equal(inert.unread, 1);
    assert.equal(inert.cursor, 0, "a non-owner must not advance the shared cursor");
    assert.equal(inert.lockNamesAnchor, false);
    // Hand the lock to B's anchor. A - whose anchor is no longer named - can no
    // longer act, and B now owns and adopts the committed record.
    grant(home, b);
    const stale = observe(home, "previous-owner-is-inert", await a.request("retry"), { anchorPid: a.anchorPid });
    assert.equal(stale.homeRecords, 1, "a session whose anchor lost the lock must not deliver again");
    assert.equal(stale.cursor, 0);
    assert.equal(stale.lockNamesAnchor, false);
    const adopted = observe(home, "new-owner-adopts-and-completes", await b.request("retry"), { anchorPid: b.anchorPid });
    assert.equal(adopted.homeRecords, 1);
    assert.equal(adopted.unread, 0, "the new lock owner must adopt the committed record");
    assert.equal(adopted.cursor, 1);
    assert.equal(adopted.markerCount, 0);
    assert.equal(adopted.lockNamesAnchor, true);
    await end(a); await end(b);
    report.schedulesReached.push("real-lock-ownership: ancestry-based ownership and lock handover both directions");
  }

  // -------------------------------------------------------------------------
  // Validation 1b: a live owner is replaced while its delivery is in flight.
  // -------------------------------------------------------------------------
  async function scheduleHandoverInFlight() {
    const home = setup("handover-in-flight");
    const a = await launch(home, { destination: "main" });
    const b = await launch(home, { destination: "replacement" });
    grant(home, a);
    await a.request("pause-after-write");
    const blocked = a.request("start");
    blocked.catch(() => {});
    assert.ok(await waitForStop(a, "after-write"), "the owner must stop with its durable append on disk");
    const inFlight = observe(home, "owner-stopped-after-durable-append", {
      pid: a.workerPid, sessionFile: a.ready.sessionFile, memoryRecords: 1, renderedCopies: 1,
      presentations: [], errors: [], ioErrors: [],
    }, { anchorPid: a.anchorPid });
    assert.equal(inFlight.homeRecords, 1, "the in-flight owner's durable record is on disk");
    assert.equal(inFlight.markerStatus, "reserved", "the delivery is not yet committed");
    assert.equal(inFlight.unread, 1);
    // Takeover: the lock now names B's live anchor, so A has lost the fence.
    grant(home, b);
    const successor = observe(home, "successor-defers-to-in-flight-reservation", await b.request("start"), { anchorPid: b.anchorPid });
    assert.equal(successor.homeRecords, 1, "the successor must not append a competing record");
    assert.equal(successor.renderedCopies, 0, "the successor must not render a second delivery");
    assert.equal(successor.unread, 1);
    assert.equal(successor.markerStatus, "committed", "the successor commits the in-flight owner's delivery");
    // Resume the replaced owner: its already-authorized delivery is allowed to
    // finish and is adopted (option 2), and it must never delete its record.
    process.kill(a.workerPid, "SIGCONT");
    const resumed = observe(home, "replaced-owner-finishes-delivery", await blocked, { anchorPid: a.anchorPid });
    assert.equal(resumed.homeRecords, 1, "the replaced owner must keep exactly one durable record");
    assert.equal(resumed.renderedCopies, 1, "the authorized in-flight delivery remains the one visible copy");
    assert.equal(resumed.unread, 1, "the replaced owner must not advance the shared cursor after losing the fence");
    assert.equal(resumed.markerStatus, "committed");
    assert.equal(marker(home).parsed.deliveryId, resumed.presentations[0].deliveryId,
      "the committed marker must name the surviving record");
    await end(a); await end(b);
    // A later session on the winner's destination adopts the one committed
    // record and completes the cursor: no loss, no duplicate.
    const adopt = await launch(home, { destination: "main" });
    grant(home, adopt);
    const settled = observe(home, "adoption-completes-cursor", await adopt.request("start"), { anchorPid: adopt.anchorPid });
    assert.equal(settled.homeRecords, 1, "adoption must leave exactly one durable record");
    assert.equal(settled.unread, 0, "the committed delivery must be adopted, never lost");
    assert.equal(settled.cursor, 1);
    assert.equal(settled.markerCount, 0, "adoption clears the marker");
    await end(adopt);
    report.schedulesReached.push("handover-in-flight: live owner replaced after durable append, delivery finished and adopted (option 2)");
  }

  // -------------------------------------------------------------------------
  // Validation 2: normal session lifecycle and the flag-off default path.
  // -------------------------------------------------------------------------
  async function scheduleLifecycleDurable() {
    const home = setup("lifecycle-durable");
    const first = await launch(home, { destination: "main", durable: true });
    grant(home, first);
    const delivered = observe(home, "start-and-deliver", await first.request("start"), { anchorPid: first.anchorPid, durable: true });
    assert.equal(delivered.homeRecords, 1);
    assert.equal(delivered.renderedCopies, 1);
    assert.equal(delivered.unread, 0);
    assert.equal(delivered.cursor, 1);
    assert.equal(delivered.markerCount, 0, "a read row clears its marker");
    assert.equal(delivered.presentations.length, 1);
    assert.equal(delivered.presentations[0].customType, DURABLE_TYPE);
    assert.equal(delivered.presentations[0].hasDetails, false);
    assert.ok(delivered.presentations[0].deliveryId, "the durable record carries its delivery identity");
    assert.equal(readJsonl(first.ready.sessionFile).filter(isPlainNote).length, 0,
      "the opt-in path must not fall back to the plain merge note");
    const firstLines = readJsonl(first.ready.sessionFile).length;
    await end(first);
    // Session end -> fresh session restart on the same destination.
    const second = await launch(home, { destination: "main", durable: true });
    grant(home, second);
    const reopened = observe(home, "fresh-session-no-redelivery", await second.request("start"), { anchorPid: second.anchorPid, durable: true });
    assert.equal(reopened.homeRecords, 1, "a fresh session must not append a second durable record");
    assert.equal(reopened.renderedCopies, 1, "the durable record is adopted and rendered once");
    assert.equal(reopened.unread, 0);
    assert.equal(reopened.cursor, 1);
    assert.equal(readJsonl(second.ready.sessionFile).length, firstLines, "a fresh session must append nothing");
    await end(second);
    const third = await launch(home, { destination: "main", durable: true });
    grant(home, third);
    const again = observe(home, "second-restart-no-redelivery", await third.request("start"), { anchorPid: third.anchorPid, durable: true });
    assert.equal(again.homeRecords, 1);
    assert.equal(again.unread, 0);
    assert.equal(readJsonl(third.ready.sessionFile).length, firstLines, "a second restart must also append nothing");
    await end(third);
    report.schedulesReached.push("lifecycle-durable: start -> delivered -> session end -> fresh session -> no re-delivery, twice");
  }

  async function captureDefaultPresentation(pluginPath, name) {
    const home = setup(name);
    const first = await launch(home, { destination: "main", durable: false, pluginPath });
    grant(home, first);
    observe(home, "default-start-and-deliver", await first.request("start"), { anchorPid: first.anchorPid, durable: false });
    const bodies = homePlainBodies(home);
    assert.equal(bodies.length, 1, "the default path must deliver exactly one plain merge note");
    const lines = readJsonl(first.ready.sessionFile).length;
    await end(first);
    const second = await launch(home, { destination: "main", durable: false, pluginPath });
    grant(home, second);
    observe(home, "default-fresh-session", await second.request("start"), { anchorPid: second.anchorPid, durable: false });
    assert.equal(homePlainBodies(home).length, 1, "the default fresh session must not re-deliver");
    assert.equal(readJsonl(second.ready.sessionFile).length, lines, "the default fresh session must append nothing");
    await end(second);
    return bodies[0];
  }

  async function scheduleLifecycleDefault() {
    const body = await captureDefaultPresentation(plugin, "lifecycle-default");
    assert.equal(Buffer.from(body, "utf8").equals(Buffer.from(EXPECTED_PLAIN_BODY, "utf8")), true,
      `the flag-off presentation body changed: ${JSON.stringify(body)}`);
    const home = join(lab, "lifecycle-default");
    assert.equal(fs.existsSync(join(home, "state/.branch-outcomes-delivered")), false,
      "the flag-off path must not create the durable ledger");
    report.defaultPresentation = { body, sha256: sha(body) };
    if (process.env.FM_PHASE1_BASELINE_PLUGIN && fs.existsSync(process.env.FM_PHASE1_BASELINE_PLUGIN)) {
      try {
        const baseline = await captureDefaultPresentation(resolve(process.env.FM_PHASE1_BASELINE_PLUGIN), "lifecycle-default-baseline");
        assert.equal(Buffer.from(baseline, "utf8").equals(Buffer.from(body, "utf8")), true,
          "the flag-off body must be byte-identical to the pre-Phase-1 baseline extension");
        report.baselineCompare = "identical";
        report.baselinePresentation = { body: baseline, sha256: sha(baseline) };
      } catch (error) {
        report.baselineCompare = `unavailable: ${String(error.message).slice(0, 2000)}`;
        report.residuals.push("baseline-extension-compare: could not load the pre-Phase-1 extension in this lab");
      }
    } else {
      report.baselineCompare = "not-provided";
    }
    report.schedulesReached.push("lifecycle-default: flag-off body byte-identical to the legacy merge note");
  }

  // -------------------------------------------------------------------------
  // Validation 3: bounded concurrent soak.
  // -------------------------------------------------------------------------
  async function scheduleSoak() {
    const cycles = Number(process.env.FM_PHASE1_CYCLES ?? "20");
    const wallMs = Number(process.env.FM_PHASE1_SOAK_SECONDS ?? "480") * 1000;
    const started = Date.now();
    const soak = { cyclesRequested: cycles, wallLimitMs: wallMs, cyclesCompleted: 0, totalRecords: 0,
      totalDeliveries: 0, duplicates: 0, losses: 0, maxCycleMs: 0, failures: [] };
    for (let i = 0; i < cycles && Date.now() - started < wallMs; i += 1) {
      const cycleStart = Date.now();
      const home = setup(`soak-${i}`);
      const destinations = ["main", "replacement", "third"];
      const consumers = [];
      for (const destination of destinations) consumers.push(await launch(home, { destination }));
      try {
        const first = i % 3;
        const second = (first + 1) % 3;
        const third = (first + 2) % 3;
        // Alternate the in-flight window and the handover order so the soak
        // covers both a committed reservation with its durable record on disk
        // and one whose record is not yet written.
        const pausePoint = i % 2 === 0 ? "pause-after-write" : "pause-before-write";
        const stopMarker = pausePoint === "pause-after-write" ? "after-write" : "before-write";
        const handoverOrder = i % 2 === 0 ? [second, third] : [third, second];
        grant(home, consumers[first]);
        await consumers[first].request(pausePoint);
        const blocked = consumers[first].request("start");
        blocked.catch(() => {});
        if (!(await waitForStop(consumers[first], stopMarker))) throw new Error(`cycle ${i}: owner did not stop at ${pausePoint}`);
        // Concurrent consumers: both other destinations open against the in-flight
        // reservation while the lock changes hands, then it returns to the owner
        // before it resumes.
        const raced = [];
        for (const index of handoverOrder) {
          grant(home, consumers[index]);
          raced.push(consumers[index].request("start"));
        }
        await Promise.all(raced);
        grant(home, consumers[first]);
        process.kill(consumers[first].workerPid, "SIGCONT");
        await blocked;
        const observed = observe(home, `soak-cycle-${i}`, await consumers[first].request("snapshot"),
          { anchorPid: consumers[first].anchorPid });
        if (observed.homeRecords > 1) { soak.duplicates += 1; soak.failures.push(`cycle ${i}: ${observed.homeRecords} durable records`); }
        if (observed.homeRecords < 1) { soak.losses += 1; soak.failures.push(`cycle ${i}: no durable record`); }
        soak.totalRecords += observed.homeRecords;
        soak.totalDeliveries += observed.homeDeliveryEntries;
      } finally {
        await Promise.all(consumers.map((consumer) => end(consumer).catch(() => undefined)));
      }
      // Adoption on the owner's destination must complete the cursor.
      const winner = destinations[i % 3];
      const adopt = await launch(home, { destination: winner });
      grant(home, adopt);
      const settled = observe(home, `soak-${i}-adoption`, await adopt.request("start"), { anchorPid: adopt.anchorPid });
      await end(adopt);
      if (settled.homeRecords !== 1 || settled.unread !== 0 || settled.cursor !== 1 || settled.markerCount !== 0) {
        soak.losses += 1;
        soak.failures.push(`cycle ${i}: adoption settled at records=${settled.homeRecords} unread=${settled.unread} cursor=${settled.cursor} markers=${settled.markerCount}`);
      }
      soak.cyclesCompleted += 1;
      soak.maxCycleMs = Math.max(soak.maxCycleMs, Date.now() - cycleStart);
    }
    soak.elapsedMs = Date.now() - started;
    report.soak = soak;
    assert.equal(soak.failures.length, 0, `soak found a duplicate or loss: ${soak.failures.join("; ")}`);
    assert.ok(soak.cyclesCompleted > 0, "the soak must complete at least one cycle");
    report.schedulesReached.push(`soak-concurrent: ${soak.cyclesCompleted} bounded cycles, ${soak.totalRecords} records vs ${soak.totalDeliveries} deliveries`);
  }

  try {
    await scheduleRealLockOwnership();
    await scheduleHandoverInFlight();
    await scheduleLifecycleDurable();
    await scheduleLifecycleDefault();
    await scheduleSoak();
    report.schedulesNotReached = [
      "free-running multi-process reclaim with no lock change (doc 27's own scoped limit)",
      "same-generation concurrent reclaim where two processes both resolve the lock as owned",
      "filesystem without hard-link/atomic-rename support, cross-device marker directories, PID reuse, and non-Linux platforms",
    ];
    report.residuals.push(
      "a live-but-replaced owner that never exits still stalls its row until it does (liveness, not loss)",
      "a committed reservation whose record lives only in a different destination defers there",
      "an externally corrupted .claim stalls its sequence (liveness only; unreachable through the extension's own writes)",
      "the no-loss/no-duplicate claim stays scoped to the schedules exercised here, not free-running multi-process reclaim",
    );
    report.verdict = "PASS";
    save();
    for (const row of observations.filter((candidate) => candidate.scenario)) console.log(JSON.stringify(row));
    console.log("PHASE1_PROBE_COMPLETE verdict=PASS; real lock handover, normal session lifecycle, and a bounded concurrent soak hold one home-wide delivery with no loss");
  } catch (error) {
    report.verdict = "PROBE_FAILED";
    report.error = error.stack;
    save();
    throw error;
  } finally {
    await Promise.all([...active].map((child) => endChild(child)));
  }
}

if (process.argv.includes("--worker")) await worker();
else if (process.argv.includes("--anchor")) await anchor();
else await controller();
