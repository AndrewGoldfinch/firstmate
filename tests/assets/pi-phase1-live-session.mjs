// Phase 1 LIVE-SESSION pilot probe. Called by fm-pi-phase1-live-session.test.sh.
//
// Unlike the bounded Phase 1 pilot (tests/assets/pi-phase1-probe.mjs), which
// drives the real extension through synthetic lifecycle triggers inside a
// bare Node worker, this probe drives the GENUINELY LIVE product path: the real
// installed `pi` binary, the real supervision extension, a real model turn, and
// the real on-disk session/outcome state, all inside a disposable FM_HOME under
// $TMPDIR. `FM_PI_DURABLE_DELIVERY=1` is scoped to each spawned `pi` process
// only; the flag-off path is exercised in the rollback lane.
//
// It observes three stages of option 2 on the opt-in durable path:
//   1. routine delivery        - one unread row -> one durable record, one
//                                visible delivery, cursor advanced, no marker;
//   2. restart/resume          - an acknowledged note is not re-delivered, an
//                                unread note is re-presented once;
//   3. lock handover           - a live owner paused mid-delivery (its real
//                                mark-read subprocess blocked by a PATH shim,
//                                so the durable record is on disk and the cursor
//                                is not advanced) is replaced by a live
//                                successor on the same destination; the
//                                successor adopts the record, advances the
//                                cursor, and the replaced owner finishes without
//                                a duplicate or a loss.
//
// It then exercises the rollback contract: a pending durable delivery must be
// reconciled (delivered and cursor-advanced) BEFORE the presentation mode is
// switched to flag-off. A second lane demonstrates the hazard directly: with an
// unreconciled pending durable delivery, switching to flag-off re-presents the
// row as a plain note (a duplicate), which is why reconciliation is mandatory.
//
// Any duplicate or loss on the pilot path is a HOLD: the probe reports the
// failing stage and the exact raw state instead of a passing verdict. The
// rollback-negative duplicate is an intentional, separately labelled control.
//
// Env: FM_LIVE_LAB, FM_LIVE_ROOT (required); FM_LIVE_MODEL,
// FM_LIVE_AGENT_DIR, FM_LIVE_PROMPT, FM_LIVE_OUTPUT, PI_BIN (optional).
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = resolve(process.env.FM_LIVE_ROOT ?? process.cwd());
const lab = resolve(process.env.FM_LIVE_LAB ?? join(process.cwd(), "fm-pi-phase1-live-lab"));
const model = process.env.FM_LIVE_MODEL ?? "opencode-go/muse-spark-1.3-contributor";
const agentSource = resolve(process.env.FM_LIVE_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"));
const prompt = process.env.FM_LIVE_PROMPT ?? "reply with exactly: OK";
const piBin = process.env.PI_BIN ?? "pi";
const outPath = process.env.FM_LIVE_OUTPUT ?? "";
const extPath = join(root, ".pi/extensions/fm-branch-supervision.ts");
const outcomeScript = join(root, "bin/fm-branch-outcome.sh");
const realBash = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
const DURABLE_TYPE = "fm-branch-visible-routine";
const PLAIN_TYPE = "fm-branch-merge";

const sha256 = (path) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const readJsonl = (path) => {
  if (!fs.existsSync(path)) return [];
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

const report = {
  schemaVersion: 1,
  kind: "pi-phase1-live-session",
  sourceCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  piVersion: execFileSync(piBin, ["--version"], { encoding: "utf8" }).trim(),
  sdkVersion: JSON.parse(
    fs.readFileSync(join(process.env.PI_PACKAGE_DIR ?? join(dirname(piBin), ".."), "package.json"), "utf8"),
  ).version,
  extensionSha256: sha256(extPath),
  probeSha256: sha256(self),
  nodeVersion: process.version,
  platform: process.platform,
  model,
  timestamp: new Date().toISOString(),
  verdict: "INCOMPLETE",
  scope:
    "Real pi binary + real supervision extension + real model turn + real on-disk session/outcome state in a disposable home; synthetic unread rows and one deterministic in-flight pause",
  startingState: null,
  observations: [],
  holds: [],
  rollback: {},
};
const save = () => {
  if (outPath) fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
};

function outcome(home, args) {
  return execFileSync(realBash, [outcomeScript, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      FM_HOME: home,
      FM_ROOT_OVERRIDE: root,
      FM_STATE_OVERRIDE: join(home, "state"),
      FM_CONFIG_OVERRIDE: join(home, "config"),
    },
  }).trim();
}

function appendOutcome(home, summary, key) {
  const seq = outcome(home, ["append", "--task", "fixture", "--verdict", "routine", "--summary", summary, "--operation-key", key]);
  assert.ok(/^[0-9]+$/.test(seq), `append did not return a sequence: ${seq}`);
  return Number(seq);
}

function readMarkers(home) {
  const dir = join(home, "state", ".branch-outcomes-delivered");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => /^[0-9]+$/.test(file))
    .map((file) => {
      let parsed = {};
      try {
        parsed = JSON.parse(fs.readFileSync(join(dir, file), "utf8"));
      } catch {
        parsed = { status: "unparsable" };
      }
      return { seq: Number(file), ...parsed };
    })
    .sort((a, b) => a.seq - b.seq);
}

function observe(ctx, home, sessionFile) {
  const storeRows = readJsonl(join(home, "state", "branch-outcomes.jsonl"));
  const cursorFile = join(home, "state", ".branch-outcomes-cursor");
  const cursor = fs.existsSync(cursorFile) ? Number(fs.readFileSync(cursorFile, "utf8").trim()) : 0;
  const unreadRows = outcome(home, ["unread"])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const entries = readJsonl(sessionFile);
  const durable = entries.filter((entry) => entry.customType === DURABLE_TYPE);
  const plain = entries.filter((entry) => entry.customType === PLAIN_TYPE);
  const bySeq = new Map();
  for (const entry of durable) bySeq.set(entry.data?.seq, (bySeq.get(entry.data?.seq) ?? 0) + 1);
  return {
    home,
    sessionFile,
    outcomeRows: storeRows.length,
    maxSeq: storeRows.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0),
    cursor,
    unreadCount: unreadRows.length,
    unreadSeqs: unreadRows.map((row) => row.seq),
    durableEntries: durable.length,
    plainEntries: plain.length,
    durableSeqs: durable.map((entry) => entry.data?.seq),
    durableDeliveryIds: durable.map((entry) => entry.data?.deliveryId),
    rawDuplicateSeqs: [...bySeq.entries()].filter(([, count]) => count > 1).map(([seq]) => seq),
    identityDuplicate: durable.length !== new Set(durable.map((entry) => `${entry.data?.seq}:${entry.data?.deliveryId}`)).size,
    markers: readMarkers(home),
  };
}

function createLab(base) {
  fs.mkdirSync(base, { recursive: true });
  const home = join(base, "home");
  for (const dir of ["state", "data", "config", "sessions"]) fs.mkdirSync(join(home, dir), { recursive: true });
  const agent = join(base, "agent");
  fs.mkdirSync(agent, { recursive: true });
  for (const file of ["auth.json", "models-store.json"]) {
    const source = join(agentSource, file);
    if (fs.existsSync(source)) {
      try {
        fs.symlinkSync(source, join(agent, file));
      } catch {
        /* already linked */
      }
    }
  }
  const fakebin = join(base, "fakebin");
  fs.mkdirSync(fakebin, { recursive: true });
  fs.writeFileSync(
    join(fakebin, "bash"),
    `#!/bin/sh
if [ "$1" = "$FM_ROOT_OVERRIDE/bin/fm-branch-outcome.sh" ] && [ "$2" = "mark-read" ] && [ -f "$FM_HOME/pause-mark-read" ]; then
  rm "$FM_HOME/pause-mark-read"
  : > "$FM_HOME/mark-read-paused"
  while [ ! -f "$FM_HOME/release-mark-read" ]; do sleep 0.1; done
  rm "$FM_HOME/release-mark-read"
fi
exec ${JSON.stringify(realBash)} "$@"
`,
    { mode: 0o755 },
  );
  const anchor = join(base, "anchor.sh");
  fs.writeFileSync(anchor, '#!/usr/bin/env bash\necho $$ > "$FM_HOME/state/.lock"\n"$@"\n', { mode: 0o755 });
  const sessionFile = join(home, "sessions", "main.jsonl");
  return { base, home, agent, fakebin, anchor, sessionFile, running: new Set() };
}

function startPi(ctx, { durable, label }) {
  const args = [
    "--print",
    "--approve",
    "--no-extensions",
    "-e",
    extPath,
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "--no-tools",
    "--session",
    ctx.sessionFile,
    "--model",
    model,
    "--thinking",
    "off",
    prompt,
  ];
  const child = spawn(realBash, [ctx.anchor, piBin, ...args], {
    cwd: ctx.base,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FM_HOME: ctx.home,
      FM_ROOT_OVERRIDE: root,
      FM_STATE_OVERRIDE: join(ctx.home, "state"),
      FM_CONFIG_OVERRIDE: join(ctx.home, "config"),
      FM_PI_DURABLE_DELIVERY: durable ? "1" : "0",
      PI_CODING_AGENT_DIR: ctx.agent,
      PATH: `${ctx.fakebin}:${process.env.PATH}`,
      DISABLE_AUTOUPDATER: "1",
    },
  });
  ctx.running.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const done = new Promise((settle) => {
    child.on("exit", (code, signal) => {
      ctx.running.delete(child);
      settle({ code, signal, output });
    });
  });
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };
  return { label, durable, child, anchorPid: child.pid, done, kill, text: () => output };
}

async function waitForFile(path, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(path)) return true;
    await new Promise((settle) => setTimeout(settle, 200));
  }
  return false;
}

// Arm one deterministic in-flight window. The mark-read shim consumes
// pause-mark-read, records mark-read-paused, and blocks until release-mark-read.
// Clear any marker left by an earlier window so a stale file can never be
// mistaken for this window's pause.
function armPause(ctx) {
  for (const leftover of ["pause-mark-read", "mark-read-paused", "release-mark-read"]) {
    try {
      fs.rmSync(join(ctx.home, leftover));
    } catch {
      /* absent */
    }
  }
  fs.writeFileSync(join(ctx.home, "pause-mark-read"), "1");
}

function releasePause(ctx) {
  fs.writeFileSync(join(ctx.home, "release-mark-read"), "1");
}

async function runToExit(handle, timeoutMs = 180000) {
  const result = await Promise.race([
    handle.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${handle.label} did not exit within ${timeoutMs}ms`)), timeoutMs)),
  ]);
  return result;
}

function record(report, stage, obs, extra = {}) {
  const entry = { stage, ...extra, ...obs };
  report.observations.push(entry);
  report.rollback = report.rollback ?? {};
  save();
  return entry;
}

function hold(stage, reason, obs) {
  report.holds.push({ stage, reason, state: obs });
  report.verdict = "HOLD";
  save();
  console.error(`PHASE1_LIVE_SESSION_HOLD stage=${stage} reason=${reason} ${JSON.stringify(obs)}`);
  throw new Error(`HOLD: ${stage}: ${reason}`);
}

function checkSettled(stage, obs, expectedSeqs) {
  const corrupt = [];
  if (obs.identityDuplicate) corrupt.push("raw durable records exceed distinct seq:deliveryId identities");
  if (obs.rawDuplicateSeqs.length > 0) corrupt.push(`duplicate durable records for seq ${obs.rawDuplicateSeqs.join(",")}`);
  if (obs.markers.some((marker) => marker.status !== "committed" && marker.status !== "cleared")) {
    corrupt.push("unexpected marker status");
  }
  if (obs.cursor < obs.maxSeq) corrupt.push(`cursor ${obs.cursor} behind max seq ${obs.maxSeq}`);
  if (obs.unreadCount > 0) corrupt.push(`unread rows remain: ${obs.unreadSeqs.join(",")}`);
  for (const seq of expectedSeqs) {
    if (!obs.durableSeqs.includes(seq)) corrupt.push(`no durable delivery for seq ${seq}`);
  }
  if (corrupt.length > 0) hold(stage, corrupt.join("; "), obs);
}

async function pilotLane(base) {
  const ctx = createLab(base);
  report.startingState = {
    home: ctx.home,
    sessionFile: ctx.sessionFile,
    outcomeRows: 0,
    cursor: 0,
    unread: 0,
    sessionDurableEntries: 0,
    note: "fresh disposable home; store and session created by the first append/run",
  };

  // Stage 1: routine delivery of one unread row by a live owner.
  const seq1 = appendOutcome(ctx.home, "LIVE_PILOT_ONE", `fm:live:${base}:1`);
  const owner1 = startPi(ctx, { durable: true, label: "owner-1" });
  const run1 = await runToExit(owner1);
  assert.equal(run1.code, 0, `owner-1 failed: ${run1.output}`);
  const obs1 = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "stage1-routine-delivery", obs1, { seq: seq1, piExit: run1.code });
  checkSettled("stage1", obs1, [seq1]);
  if (obs1.durableEntries !== 1) hold("stage1", "expected exactly one durable delivery", obs1);
  if (obs1.plainEntries !== 0) hold("stage1", "flag-on path produced a plain note", obs1);

  // Stage 2a: restart/resume; the acknowledged note is not re-delivered.
  const owner2a = startPi(ctx, { durable: true, label: "owner-2a" });
  const run2a = await runToExit(owner2a);
  assert.equal(run2a.code, 0, `owner-2a failed: ${run2a.output}`);
  const obs2a = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "stage2-restart-acknowledged", obs2a, { piExit: run2a.code });
  checkSettled("stage2a", obs2a, [seq1]);
  if (obs2a.durableEntries !== 1) hold("stage2a", "acknowledged note was re-delivered on resume", obs2a);

  // Stage 2b: an unread row appended while no owner runs is re-presented once.
  const seq2 = appendOutcome(ctx.home, "LIVE_PILOT_TWO", `fm:live:${base}:2`);
  const owner2b = startPi(ctx, { durable: true, label: "owner-2b" });
  const run2b = await runToExit(owner2b);
  assert.equal(run2b.code, 0, `owner-2b failed: ${run2b.output}`);
  const obs2b = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "stage2-unread-represented", obs2b, { seq: seq2, piExit: run2b.code });
  checkSettled("stage2b", obs2b, [seq1, seq2]);
  if (obs2b.durableEntries !== 2) hold("stage2b", "unread note was not presented exactly once", obs2b);

  // Stage 3: lock handover. Owner 3 is paused mid-delivery (durable record on
  // disk, cursor not advanced); a live successor adopts and completes it.
  const seq3 = appendOutcome(ctx.home, "LIVE_PILOT_THREE", `fm:live:${base}:3`);
  armPause(ctx);
  const owner3 = startPi(ctx, { durable: true, label: "owner-3" });
  const paused = await waitForFile(join(ctx.home, "mark-read-paused"));
  if (!paused) {
    owner3.kill();
    hold("stage3", "owner-3 never reached the in-flight mark-read window", observe(ctx, ctx.home, ctx.sessionFile));
  }
  const obs3mid = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "stage3-handover-in-flight", obs3mid, { seq: seq3, inFlight: true });
  if (!obs3mid.durableSeqs.includes(seq3)) hold("stage3", "in-flight owner had no durable record", obs3mid);
  if (obs3mid.cursor >= seq3) hold("stage3", "in-flight cursor already advanced; the pause was not real", obs3mid);

  const successor = startPi(ctx, { durable: true, label: "successor" });
  const runSuccessor = await runToExit(successor);
  assert.equal(runSuccessor.code, 0, `successor failed: ${runSuccessor.output}`);
  const obs3succ = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "stage3-handover-successor-adopts", obs3succ, { seq: seq3, piExit: runSuccessor.code });
  checkSettled("stage3-successor", obs3succ, [seq1, seq2, seq3]);
  if (obs3succ.durableEntries !== 3) hold("stage3", "successor appended a competing durable record", obs3succ);

  fs.writeFileSync(join(ctx.home, "release-mark-read"), "1");
  const run3 = await runToExit(owner3);  const obs3final = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "stage3-replaced-owner-finishes", obs3final, { seq: seq3, piExit: run3.code });
  checkSettled("stage3-final", obs3final, [seq1, seq2, seq3]);
  if (obs3final.durableEntries !== 3) hold("stage3", "replaced owner appended a duplicate", obs3final);

  // Rollback positive: reconcile a pending durable delivery first, then switch
  // to flag-off. The flag-off session must not deliver or lose anything.
  const seq4 = appendOutcome(ctx.home, "LIVE_PILOT_FOUR", `fm:live:${base}:4`);
  armPause(ctx);
  const owner4 = startPi(ctx, { durable: true, label: "owner-4" });
  const paused4 = await waitForFile(join(ctx.home, "mark-read-paused"));
  if (!paused4) {
    owner4.kill();
    hold("rollback", "owner-4 never reached the in-flight mark-read window", observe(ctx, ctx.home, ctx.sessionFile));
  }
  const rollbackPending = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "rollback-pending-before-switch", rollbackPending, { seq: seq4, inFlight: true });
  if (!rollbackPending.durableSeqs.includes(seq4) || rollbackPending.cursor >= seq4) {
    hold("rollback", "pending durable delivery was not observed", rollbackPending);
  }
  releasePause(ctx);
  const run4 = await runToExit(owner4);
  assert.equal(run4.code, 0, `owner-4 failed: ${run4.output}`);
  const rollbackReconciled = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "rollback-reconciled", rollbackReconciled, { seq: seq4, piExit: run4.code });
  checkSettled("rollback-reconciled", rollbackReconciled, [seq1, seq2, seq3, seq4]);
  report.rollback.positive = {
    pendingBeforeSwitch: { cursor: rollbackPending.cursor, unread: rollbackPending.unreadCount, durableEntries: rollbackPending.durableEntries, markers: rollbackPending.markers },
    reconciledBeforeSwitch: { cursor: rollbackReconciled.cursor, unread: rollbackReconciled.unreadCount, durableEntries: rollbackReconciled.durableEntries, markers: rollbackReconciled.markers },
  };

  const flagOwner = startPi(ctx, { durable: false, label: "flag-off" });
  const runFlag = await runToExit(flagOwner);
  assert.equal(runFlag.code, 0, `flag-off owner failed: ${runFlag.output}`);
  const afterSwitch = observe(ctx, ctx.home, ctx.sessionFile);
  record(report, "rollback-flag-off-after-switch", afterSwitch, { piExit: runFlag.code });
  report.rollback.afterSwitch = {
    cursor: afterSwitch.cursor,
    unread: afterSwitch.unreadCount,
    durableEntries: afterSwitch.durableEntries,
    plainEntries: afterSwitch.plainEntries,
  };
  if (afterSwitch.durableEntries !== 4) hold("rollback", "flag-off session changed the durable record count", afterSwitch);
  if (afterSwitch.plainEntries !== 0) hold("rollback", "flag-off session duplicated a reconciled delivery as a plain note", afterSwitch);
  if (afterSwitch.cursor !== 4 || afterSwitch.unreadCount !== 0) hold("rollback", "flag-off session lost or re-opened a row", afterSwitch);
  return ctx;
}

async function rollbackNegativeLane(base) {
  const ctx = createLab(base);
  const seq1 = appendOutcome(ctx.home, "LIVE_PILOT_ROLLBACK_DUP", `fm:live:${base}:neg`);
  armPause(ctx);
  const owner = startPi(ctx, { durable: true, label: "negative-owner" });
  const paused = await waitForFile(join(ctx.home, "mark-read-paused"));
  if (!paused) {
    owner.kill();
    hold("rollback-negative", "negative owner never reached the in-flight window", observe(ctx, ctx.home, ctx.sessionFile));
  }
  const pending = observe(ctx, ctx.home, ctx.sessionFile);
  // Kill the paused live owner so its pending durable delivery is left
  // unreconciled, then switch straight to flag-off without reconciling.
  owner.kill();
  await owner.done.catch(() => {});
  const orphaned = observe(ctx, ctx.home, ctx.sessionFile);
  const flagOwner = startPi(ctx, { durable: false, label: "negative-flag-off" });
  await runToExit(flagOwner);
  const after = observe(ctx, ctx.home, ctx.sessionFile);
  const duplicateObserved = after.durableEntries >= 1 && after.plainEntries >= 1 && !after.unreadSeqs.includes(seq1);
  report.rollback.negativeControl = {
    note: "intentional hazard demonstration: no reconciliation before the mode switch",
    pendingBeforeKill: { cursor: pending.cursor, unread: pending.unreadCount, durableEntries: pending.durableEntries },
    orphaned: { cursor: orphaned.cursor, unread: orphaned.unreadCount, durableEntries: orphaned.durableEntries, markers: orphaned.markers },
    afterSwitch: { cursor: after.cursor, unread: after.unreadCount, durableEntries: after.durableEntries, plainEntries: after.plainEntries },
    duplicateObserved,
  };
  if (!duplicateObserved) hold("rollback-negative", "the negative control did not reproduce a duplicate as expected", after);
  return ctx;
}

async function main() {
  const labs = [];
  try {
    labs.push(await pilotLane(join(lab, "pilot")));
    labs.push(await rollbackNegativeLane(join(lab, "rollback-negative")));
    report.verdict = "PASS";
    save();
    console.log("PHASE1_LIVE_SESSION_COMPLETE verdict=PASS");
    for (const obs of report.observations) {
      console.log(
        `live-session stage=${obs.stage} durable=${obs.durableEntries} plain=${obs.plainEntries} cursor=${obs.cursor} unread=${obs.unreadCount} markers=${obs.markers.length}`,
      );
    }
    console.log(
      `live-session rollback after-switch cursor=${report.rollback.afterSwitch.cursor} durable=${report.rollback.afterSwitch.durableEntries} plain=${report.rollback.afterSwitch.plainEntries}`,
    );
    console.log(
      `live-session rollback-negative duplicateObserved=${report.rollback.negativeControl.duplicateObserved} plain=${report.rollback.negativeControl.afterSwitch.plainEntries}`,
    );
  } catch (error) {
    report.verdict = report.holds.length > 0 ? "HOLD" : "ERROR";
    save();
    console.error(`PHASE1_LIVE_SESSION_FAILED ${error.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    for (const lane of labs) {
      for (const child of lane.running) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
}

await main();
