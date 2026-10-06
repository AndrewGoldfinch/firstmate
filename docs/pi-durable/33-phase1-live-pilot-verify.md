# Adversarial verification: Phase 1 single live-session pilot

Task: `pi-durable-phase1-live-pilot-verify` (scout). Repository: `firstmate-pi-durable`.
Commit under test: `6d845dcc` (`test(pi-durable): add Phase 1 live-session pilot harness and record`), parent `d4ee2ad9`, merged into `experiment/pi-durable-supervision` as `88b995c0`. The three pilot files are byte-identical between `6d845dcc` and `88b995c0` (`git diff --stat 88b995c0 6d845dcc -- <files>` is empty).

Disposition: the pilot's claims hold. No duplicate and no loss was produced on the pilot path; the rollback reconciliation is load-bearing and the negative control genuinely reproduces a duplicate; the "not driven" fidelity limits are accurate. Recommendation: **ADVANCE**.

## Method and environment

- Scratch worktree checked out at `6d845dcc`; no tracked file was modified (`git status` shows only an untracked scratch split dir).
- Real toolchain: `pi --version` = `1.0.4`, `jq .version $(npm root -g)/@earendil-works/pi-coding-agent/package.json` = `1.0.4`, `node --version` = `v22.21.1`, platform `linux`, `$HOME/.pi/agent/auth.json` present.
- Live reports were read from the probe's `report.json` and the guard stdout. The standard live run's report fields: `piVersion=1.0.4`, `sdkVersion=1.0.4`, `extensionSha256=cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09`, `probeSha256=0bba224a44b027c72afad05edc8f8187f83fbf2e68ff906422a3449ef435dc76`, `model=opencode-go/muse-spark-1.3-contributor`.
- Both hashes match the doc's recorded values and the committed files exactly (`sha256sum tests/assets/pi-phase1-live-session.mjs .pi/extensions/fm-branch-supervision.ts`).

## Challenge table

| Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- |
| Is the live path actually live (real `pi`, real model, real extension)? | HOLDS (live) | `FM_PI_PHASE1_LIVE_SESSION=1 bin/fm-test-run.sh tests/fm-pi-phase1-live-session.test.sh` exit 0, `PHASE1_LIVE_SESSION_COMPLETE verdict=PASS`, `duration_ms=193529`; guard prints `real Pi SDK 1.0.4`. Probe spawns the real `pi` via `spawn(realBash, [anchor, piBin, ...])` with `--print ... -e .pi/extensions/fm-branch-supervision.ts` (`tests/assets/pi-phase1-live-session.mjs:199-215`). A direct call `pi --print --no-tools --model opencode-go/muse-spark-1.3-contributor "reply with exactly: OK"` returned `OK`, exit 0. | No gate impact |
| Does it fall back to a synthetic trigger or fixture? | NO | Live probe has no `bindExtensions`/emitted `turn_end`; that is the separate bounded probe `tests/assets/pi-phase1-probe.mjs`. Extension reads only `FM_HOME`, `FM_ROOT_OVERRIDE`, `FM_STATE_OVERRIDE`, `FM_CONFIG_OVERRIDE`, `FM_SUPERVISION_BRIDGE_CLI`, `FM_PI_DURABLE_DELIVERY` (no test/fixture env branch). Durable records are `customType=fm-branch-visible-routine`, written only by the extension. | No gate impact |
| Is lock ownership the real `ps`-walked ancestry? | HOLDS | `.pi/extensions/fm-branch-supervision.ts:376-394` (`parentPid` = `ps -o ppid= -p <pid>`, `parentPidSync`, `pidAlive`); `readLockPid` reads `state/.lock` (line 416); `lockOwnership`/`lockOwnershipSync` walk up to `LOCK_ANCESTRY_DEPTH=8` (lines 414, 432-466). The anchor writes its own `$$` and runs `pi` as its child (`pi-phase1-live-session.mjs:193`), so the lock pid is a real ancestor. | No gate impact |
| Is handover a real change of resolved process, not a depth-0 pid? | HOLDS | Successor is a new `pi` under a new anchor that overwrites `state/.lock` with its own pid; the extension re-walks ancestry at every boundary. Stage 3 observes `stage3-handover-in-flight durable=3 cursor=2 unread=1 markers=1` then `stage3-handover-successor-adopts durable=3 cursor=3 unread=0`. | No gate impact |
| Can two concurrent owners on the same destination duplicate? | NO | Scratch patch spawned a second live durable owner concurrently with the successor. Both exited 0 (`ATTACK two-successors exitA=0 exitB=0`); `stage3-handover-successor-adopts durable=3 cursor=3 unread=0`, verdict PASS, 0 holds. The O_EXCL reservation fence serialized them. | No gate impact |
| Successor that does not adopt (different destination)? | NO DUPLICATE, no loss observed; inconclusive as an adoption test | Scratch alt-destination successor run raised `HOLD stage3-successor :: cursor 2 behind max seq 3; unread rows remain: 3`. Cause is lock semantics, not a product defect: the extra owner's anchor overwrote the shared lock, so the intended successor was no longer the lock holder and refused to deliver; the row stayed unread for the actual holder. Static review (`ensureRoutineOutcome`/`recordedDelivery`/`adoptDurableDelivery`, ext lines 1476-1600) shows a non-holding destination returns `false` and delivers nothing. | No gate impact; residual coverage limit noted below |
| Is the rollback reconciliation load-bearing? | YES | Positive lane: `rollback-pending-before-switch durable=4 cursor=3 unread=1 markers=1` -> `rollback-reconciled durable=4 cursor=4 unread=0 markers=0` -> `rollback-flag-off-after-switch durable=4 plain=0 cursor=4`. Flag-off changed nothing only after reconciliation. | No gate impact |
| Is the unreconciled negative control non-vacuous? | YES, reproduces a duplicate | `rollback-negative duplicateObserved=true plain=1`; report `negativeControl`: `orphaned {cursor:0, durable:1, unread:1, marker seq1 committed}`, `afterSwitch {cursor:1, durable:1, plainEntries:1}`. | No gate impact |
| Is the flag-off path unchanged and `runtime/pi-durable/src` / `bin/fm-branch-outcome.sh` untouched? | YES | `git show --stat 6d845dcc` = 4 files, +715: `docs/documentation-audiences.json`, `docs/pi-durable/32-phase1-live-session-pilot.md`, `tests/assets/pi-phase1-live-session.mjs`, `tests/fm-pi-phase1-live-session.test.sh`. No `runtime/pi-durable/src` or `bin/fm-branch-outcome.sh` change. Flag-off branch is `deliverRoutineOutcome` (ext ~1462). | No gate impact |
| Are the "not driven" limits accurate / not understated? | YES | See finding 5. | No gate impact |
| Required re-runs | ALL PASS | See finding 7. | No gate impact |

## Per-question findings

### 1. Is it actually live?

Yes. `tests/fm-pi-phase1-live-session.test.sh` runs `tests/assets/pi-phase1-live-session.mjs`, which `spawn`s the real `pi` binary (`spawn(realBash, [ctx.anchor, piBin, ...args])`, `pi-phase1-live-session.mjs:199`). Args include `--print`, `--approve`, `--no-extensions`, `-e .pi/extensions/fm-branch-supervision.ts`, `--session`, `--model`, `--thinking off`, `--no-tools` (lines 199-215). So the real extension is the only extension loaded, and the model is called for a real turn.

The probe report records `piVersion=1.0.4`, `sdkVersion=1.0.4`, `model=opencode-go/muse-spark-1.3-contributor`, matching the doc's environment table. An independent `pi --print` against that model returned `OK` (exit 0), so the provider/model is genuinely reachable. The extension is provably loaded because the observed session entries are the extension's own `customType` values (`fm-branch-visible-routine` / `fm-branch-merge`, ext lines 194/198/204); nothing else in the lab writes those.

The synthetic bounded probe (`tests/assets/pi-phase1-probe.mjs`, `FM_PI_PHASE1_PILOT=1`) is a different lane and is not what the live guard runs. No fixture/mirror path is taken.

### 2. Real lock walk

Confirmed. The extension resolves ownership by walking real process ancestry with `ps` (`parentPid`/`parentPidSync`, ext 376-394), comparing each ancestor against the pid stored in `state/.lock` (`readLockPid`, ext 416-425), up to `LOCK_ANCESTRY_DEPTH = 8` (ext 414), and it re-reads the lock at each ownership boundary rather than caching (`lockOwnership`, ext 432-445; `lockOwnershipSync`, ext 459-466). The pilot's `anchor.sh` writes its own `$$` and then runs `pi` as a child (`pi-phase1-live-session.mjs:193`), which is exactly the real firstmate shape: lock pid = wrapper, extension pid = `pi` child, matched at a real ancestry hop. The successor is a fresh `pi` under a fresh anchor that overwrites the lock, so handover is a change of the resolved ancestor, not a depth-0 write.

### 3. Attack the pilot path

- **Two owners, both appending (concurrent).** A scratch copy of the probe started a second live durable owner at the same time as the successor. Both exited 0 and the settled state was `durable=3 cursor=3 unread=0`, verdict PASS, 0 holds. The reserve-before-append fence is `createMarkerAtomic` -> `linkSync` (`commitDelivery`, ext 1208-1223; `createMarkerAtomic` ext ~1120), so exactly one owner creates the marker; the loser sees `deliveryCommitted` and either adopts or returns `false` without appending (`ensureRoutineOutcome`, ext 1560-1600).
- **A successor that does not adopt.** Static path: `adoptDurableDelivery` (ext 1476-1494) returns true only when this session holds the flushed record; `recordedDelivery` (ext 1495-1520) returns `defer`/`defer`-to-`false` when the reservation targets another destination whose durable record this session does not hold, so a non-holding destination delivers nothing and does not advance the cursor. A live alt-destination attempt was inconclusive because the extra owner's anchor overwrote the shared lock and the intended successor then correctly refused to deliver (`HOLD stage3-successor :: cursor 2 behind max seq 3; unread rows remain: 3`). That is single-owner lock semantics, not a duplicate or loss: the row remained unread for the real holder.
- **In-flight window.** The pause shim blocks the extension's real `mark-read` subprocess after append + marker commit (`pi-phase1-live-session.mjs:183-190`, `armPause`/`releasePause` lines 272-285). The observed mid-flight state `durable=3 cursor=2 unread=1 markers=1` proves the record and committed marker are on disk while the cursor is unadvanced. Release of the replaced owner left `durable=3 cursor=3 unread=0` with no duplicate (`stage3-replaced-owner-finishes`).

No duplicate or loss was produced on the pilot path by any attack.

### 4. Rollback

The reconciliation step is load-bearing and the negative control is non-vacuous:

- Positive lane: pending `cursor=3 unread=1 markers=1` -> reconciled `cursor=4 unread=0 markers=0` -> flag-off `cursor=4 durable=4 plain=0`. With reconciliation, flag-off neither duplicates nor loses.
- Negative lane: the owner is SIGKILLed at the same in-flight point with no reconciliation (`rollbackNegativeLane`, mjs ~437-472), leaving `cursor=0 durable=1 unread=1` and a `committed` marker; the flag-off session then delivered the same row as a plain note (`plain=1`, `cursor=1`, `duplicateObserved=true`). The only difference from the positive lane is the reconciliation, so the reconciliation, not the harness, is what prevents the duplicate. The claim "switching modes before reconciling duplicates" is reproduced.

### 5. Fidelity honesty

The doc's "Not driven" list is accurate and not understated:

- Non-interactive `--print`: true, all live turns use `--print` (`pi-phase1-live-session.mjs:201`).
- No watcher extension / branch session / wake dispatch: true. Only `-e .pi/extensions/fm-branch-supervision.ts` is loaded under `--no-extensions` (lines 203-205); unread rows are seeded by the real store append (`appendOutcome`, mjs 106-135) rather than by a branch report.
- Reserved-before-commit not reached live: true. The live pause is at `mark-read`, after `markDeliveryCommitted` (ext 1239-1250) has rewritten the marker to `committed`. The `reserved`-with-no-record sub-state is asserted by the bounded probe (`tests/assets/pi-phase1-probe.mjs:407`, `markerStatus === "reserved"`).
- No full fleet: true; the lab is a synthetic single-session `FM_HOME` under `$TMPDIR`.

The doc does not overclaim. One honest limitation it does not emphasise: the live guard asserts a successful turn only through the `pi` exit code and never asserts response content, so a model that returned an empty-but-successful answer would pass. That weakens the guard, not the doc's stated claims.

### 6. Flag-off unchanged / untouched surfaces

`git show --stat 6d845dcc` confirms the commit adds only the four pilot files. `runtime/pi-durable/src/` and `bin/fm-branch-outcome.sh` are unchanged. The extension's flag-off presentation path is the unchanged `deliverRoutineOutcome` branch; the new behaviour lives behind `durableDeliveryEnabled` (`process.env.FM_PI_DURABLE_DELIVERY`, ext 173). Running the live guard without its opt-in gate skips (`gate_skip=true`, 34 ms), as does the bounded pilot gate (33 ms).

### 7. Required re-runs

| Command | Result |
| --- | --- |
| `FM_PI_PHASE1_LIVE_SESSION=1 bin/fm-test-run.sh tests/fm-pi-phase1-live-session.test.sh` | PASS, exit 0, `duration_ms=193529`, `PHASE1_LIVE_SESSION_COMPLETE verdict=PASS` |
| `FM_PI_PHASE1_PILOT=1 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh` | PASS, exit 0, `duration_ms=74757` |
| `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` | PASS, exit 0, `duration_ms=69952` |
| `(cd runtime/pi-durable && npm ci && npm test)` | `npm ci` exit 0; `npm test` exit 0, `# tests 81 # pass 81 # fail 0` (`duration_ms=21635.8`) |

## New issues / observations

1. **Branch status.** The pilot is merged into `experiment/pi-durable-supervision` (`88b995c0`), not into `main`. Anyone reading "landed" as "on the default branch" would be misled; the doc itself says it is implemented on the experiment branch.
2. **Reproducibility of the recorded environment table.** The doc's table lists `Checkout (branch head) = d4ee2ad9`, but the harness that produces the report's `sourceCommit` exists only from `6d845dcc` onward. The recorded run therefore used the pilot files as uncommitted working-tree changes on top of `d4ee2ad9`. The recorded probe/extension hashes do match the committed files, so the artifact is reproducible from `6d845dcc`; checking out `d4ee2ad9` alone is not.
3. **Guard strength (not a doc defect).** The live guard never inspects the model response; it relies on `pi` exit code 0. An added content assertion would make "real model turn" stronger.

None of these block the pilot's claims.

## What remains uncovered

- The `reserved`-with-no-committed-record sub-state was not exercised live by the live guard; it is covered only by the bounded synthetic probe (`pi-phase1-probe.mjs:407`). This is disclosed.
- A non-holding successor on a different destination could not be isolated live without also contending for the shared lock; only static path review and the (lock-contended) live attempt support the "defers, never duplicates" conclusion.
- A genuine full-fleet wake dispatch and a branch model session were not run; the doc discloses this.
- The live guard does not assert model response content (see observation 3).

## Recommendation

The pilot is genuinely live, the lock walk is real, the option-2 adoption is real, the rollback reconciliation is load-bearing, and the negative control is non-vacuous. No duplicate or loss was produced on the pilot path; the fidelity limits are honest. Recommended next step is to advance the pilot to the next phase while keeping the disclosed coverage gaps (reserved-before-commit live, full-fleet wake dispatch, non-interactive-only sessions) explicit in the follow-on plan.

ADVANCE
