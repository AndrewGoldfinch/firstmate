# Pi Durable: single opt-in attended-fleet pilot - run record (HOLD)

Status: **run complete, trial held (HOLD) on watcher continuity.**
Author: crewmate `pi-durable-attended-pilot-run`. Date: 2026-10-06.
This is the execution record for the single isolated attended-fleet pilot planned in `data/pi-durable-attended-pilot-plan/report.md`.
It does not enable durable delivery in the running home, does not change the lock or delivery logic, and does not start broader adoption.
Durable delivery stayed scoped to the lab's own primary process through `FM_PI_DURABLE_DELIVERY=1`; no other process ever carried the flag.

## Verdict

The durable-delivery stages (0-4) ran and produced no duplicate, no loss, and no ownership ambiguity on the durable path.
The trial is nonetheless **HOLD** under execution rule 3: a `watcher: FAILED` alarm was recorded during the window.
The alarm coincided with the deliberate lock handover that the pilot itself drives, not with an ordinary-operation watcher outage.
The exact lines and their cause are in "Watcher continuity" below; the captain decides whether the alarm invalidates the run or is an accepted handover artifact.

## Identity

| Property | Value |
| --- | --- |
| Lab root (default `mktemp -d`, no harness token) | `/tmp/fmlab.3xWe1s` |
| Pilot home (`FM_HOME`) | `/tmp/fmlab.3xWe1s/home` |
| Main destination session | `/tmp/fmlab.3xWe1s/pi-sessions/2026-10-06T23-59-20-430Z_01a113a8-516e-765b-9637-74c248b864af.jsonl` |
| Branch session | `/tmp/fmlab.3xWe1s/home/state/branch-session/2026-10-07T00-00-09-153Z_01a113a9-0fc1-765b-9637-74c468f89126.jsonl` |
| Pilot revision (pinned commit) | `77c2bb0989454f5265d9d9a688716609f9920822` |
| Helper revision (recorded separately) | `3bb6ab3795fa869f61a337e3f3a2692ebb7896fc` |
| `bin/fm-live-lab.sh` code root used for activation | this task worktree at `ca010b88` (carries the `--durable-delivery` passthrough) |
| `fm-branch-supervision.ts` sha256 | `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09` |
| Pi CLI | `1.0.4` |
| `@earendil-works/pi-coding-agent` | `1.0.4` |
| Node / platform | `v22.21.1` / `linux` |
| Model / effort | `opencode-go/muse-spark-1.3-contributor` / `medium` |
| Negative-control lane home | `/tmp/fmlab-neg/home` (separate disposable home, shared code root) |

Activation command (run from this worktree):

```sh
bin/fm-live-lab.sh up --harness pi --durable-delivery --mate --worker \
  --source /home/andy/firstmate/projects/firstmate-pi-durable \
  --ref 77c2bb0989454f5265d9d9a688716609f9920822 \
  --model opencode-go/muse-spark-1.3-contributor --effort medium --timeout 900
```

The `up` readiness lines were:

```
ok primary: pi pid 3217114 in /tmp/fmlab.3xWe1s/home
ok probe: the primary answered LABREADY-43faa902b747
ok trust: Pi trust store unchanged (session-only --approve)
ok extensions: fm-primary-pi-watch fm-primary-turnend-guard fm-branch-supervision
ok watcher: live watcher with a fresh beacon
ok mate: lab43faa902b747-mate pid 3212416 in /tmp/fmlab.3xWe1s/mate
ok worker: lab43faa902b747-worker parked on /tmp/fmlab.3xWe1s/home/data/lab43faa902b747-worker/gate
ready: /tmp/fmlab.3xWe1s
```

Both `ok extensions` and `ok watcher` were green, so activation proceeded.

## Stage 0 - pre-flight and watcher health

Starting counters: store rows `0`, cursor `0`, `.branch-outcomes-delivered/` absent, `.branch-outcomes-processed` absent.
Recorded: revision `77c2bb09...`, extension sha `cc9cac0c...`, session path above, lock pid `3217114`, extension-loaded pid `3217114`.
The watcher held a fresh `state/.last-watcher-beat` at every sample through the run, and every stage's wakes were actually delivered, which is the operational proof that the cycle stayed live.

## Stage 1 - normal operation

Real wakes came from the seeded fleet (mate startup, then the gated worker unparked with `touch <gate>` and a resume message).
Five outcome rows traversed the full flow `watcher -> branch -> durable store -> visible delivery -> acknowledgement`:

| Seq | Task | Verdict | Silent | Note |
| --- | --- | --- | --- | --- |
| 1 | `lab43faa902b747-mate` | routine | false | mate startup check |
| 2 | `lab43faa902b747-worker` | routine | false | worker waiting for gate |
| 3 | `lab43faa902b747-worker` | routine | true | stale, no change |
| 4 | `lab43faa902b747-worker` | captain | false | worker finished `count_notes()`; branch ready to land |
| 5 | `lab43faa902b747-worker` | routine | false | stale, still awaiting landing |

Counts: store `5`, cursor `5`, unread `0`, `.branch-outcomes-delivered/` empty.
Visible deliveries: `4` `fm-branch-visible-routine` plus `1` `fm-branch-visible-outcome` = exactly one per sequence.
Plain `fm-branch-merge` notes in the flag-on session: `0`.
The `captain` row (seq 4) opened exactly one `fm-branch-process` turn on main (`fm-branch-process` occurred once in the session), and main acknowledged it with `fm_branch_processed through=4`, leaving `.branch-outcomes-processed = 4`.
No routine row had to be seeded for this stage; the branch model classified at least one row `routine` on its own.

Captured on-screen presentation in the lab main pane:

```
⛵ lab43faa902b747-mate: Lab second mate relayed its synthetic check result noting the config reread and startup memory budget.
⛵ lab43faa902b747-worker: Lab gated worker is waiting for its gate file and a resume message before implementing count_notes().
...
fm_branch_processed through=4
processed through seq 4; no captain outcome remains unprocessed
⛵ lab43faa902b747-worker: Lab gated worker finished count_notes() and its test; branch fm/lab43faa902b747-worker still awaits landing.
```

## Stage 2 - restart and resume

Restart: the main primary was exited cleanly (`ctrl+d`, pane status 0) and relaunched on the same session file with `FM_PI_DURABLE_DELIVERY=1`.

| Snapshot | Store | Cursor | Processed | Delivered dir | Visible routine | Visible outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Pre-restart | 5 | 5 | 4 | 0 | 4 | 1 |
| Post-restart (owner re-acquired) | 5 | 5 | 4 | 0 | 4 | 1 |

The acknowledged rows were not re-delivered: store count and cursor were unchanged, no new delivery marker appeared, and no new visible entry was added.
A resumed session does not re-acquire the fleet lock by itself; the durable owner only became active after the standard `bin/fm-session-start.sh` run, after which `.lock` and `.pi-branch-extension-loaded` both named the new primary pid.

Fresh unread row: seq 6 was appended with no owner running, then the session resumed and re-acquired the lock.
The row was re-presented **exactly once**: store `6`, cursor `5 -> 6`, unread empty, and the summary string occurred once in the session.
The presentation was the session-start digest's `BRANCH OUTCOMES` replay (`startup-replay`), not a fresh `fm-branch-visible-routine` custom entry; that is the resume path and is labelled as such, not counted as a durable-delivery entry.

## Stage 3 - controlled handover under option 2

The in-flight window was created deterministically with a `PATH` shim on `bash` that blocks the extension's `mark-read` subprocess (the doc-32 technique).
With `pause-mark-read` armed, a turn end delivered seq 7 and blocked at `mark-read`, giving the exact in-flight state:

| Property | Value |
| --- | --- |
| Store | `7` |
| Cursor | `6` (unadvanced) |
| Unread | `1` (seq 7) |
| Marker `.branch-outcomes-delivered/7` | `status=committed`, owner `3379030`, generation `1`, destination = main session, `deliveryId=66998510-b67b-422d-918c-559e156e2093` |
| Visible routine entries | `5` (seq 7 entry added) |
| Plain notes | `0` |

The successor reopened the **recorded destination session** (the same main session file) as a genuinely live Pi primary and took the lock.
It adopted the committed record and completed the delivery:

| Snapshot | Store | Cursor | Unread | Delivered dir | Visible routine | Plain |
| --- | --- | --- | --- | --- | --- | --- |
| Successor adopts | 7 | 7 | 0 | 0 | 5 | 0 |
| Replaced owner released | 7 | 7 | 0 | 0 | 5 | 0 |

The record count was unchanged (no competing append), the cursor advanced to `7`, and the seq-7 delivery id and summary each occurred exactly once in the session.
Releasing the replaced owner produced no new delivery; its already-authorized in-flight delivery finished without appending a second one.

Fresh-destination observation (execution rule 1, labelled separately): a **fresh** session file was started as the successor.
Its durable path **deferred** - no adoption, no competing record, no durable visible entry in the fresh session.
Its own `fm-session-start.sh` `startup-replay` did re-present the still-unread row and advance the cursor to `8`; per rule 2 that re-render is a separate observation, not a competing delivery.

## Stage 4 - rollback

Positive lane (reconciled first, then flag off):

| State | Store | Cursor | Unread | Delivered dir |
| --- | --- | --- | --- | --- |
| Reconciled before switch | 8 | 8 | 0 | 0 |
| Flag-off session after switch | 9 | 9 | 0 | 0 |

A new routine row (seq 9) was appended and presented through the ordinary flag-off path as exactly one plain note:

```
{"type":"custom_message","customType":"fm-branch-merge","content":"⛵ lab43faa902b747-mate: Stage 4 rollback probe: new routine row after switching durable delivery off.","display":true}
```

No previously delivered row was replayed: occurrences of the stage 1, 2, and 3 summaries in the flag-off session were `0`, and there were no `fm-branch-visible-*` entries there.

Negative control, separate disposable lane (`/tmp/fmlab-neg/home`):

| State | Store | Cursor | Unread | Marker |
| --- | --- | --- | --- | --- |
| Durable owner in flight | 1 | 0 | 1 | `1` committed |
| Owner killed, unreconciled | 1 | 0 | 1 | `1` committed |
| Flag-off session after switch | 1 | 1 | 0 | `1` committed (flag-off does not clear it) |

The durable owner delivered one `fm-branch-visible-routine` entry before it was killed.
The flag-off owner then presented the same row as one plain `fm-branch-merge` note.
`duplicateObserved=true` (`durableEntries=1`, `plainEntries=1`), which proves the reconciliation step is load-bearing: skipping it reproduces the duplicate.

## Watcher continuity

The watcher held a fresh beacon and delivered every wake through stages 0-3 and the flag-off lane, and its cycle exits were the ordinary `arm-interrupted` / `signal-exit` / `actionable-check` re-arms.
One alarm was recorded, at recovery generation `3437741.1791333448`:

```
watcher: FAILED - Pi extension cannot restore continuity because this session no longer owns the lock
watcher: FAILED - watcher cycle exited 143 without an actionable reason
```

This fired when the lock moved away from the main session during the deliberate handover driving, so the extension correctly refused to re-arm continuity for a session that no longer owned the lock.
The watcher self-healed on the next cycle, and no wake was lost.
Under execution rule 3 a watcher failure ends the trial as HOLD, so the run is held here.
The opt-in `.watch-extension.log` was not enabled (`FM_WATCH_EXTENSION_LOG_KEEP_LINES` unset), so only the pane failure line, the beacon samples, and `.watch-cycle-exits.log` were captured.

## Not exercised

- The `reserved`-with-no-committed-record sub-state (the in-flight window is the committed-marker, unadvanced-cursor point).
- A genuinely non-holding destination.
- Host power loss, filesystem corruption, or a full production ownership-handover protocol.
- A real attended TUI keystroke-echo floor (the repo covers that separately with `FM_PI_BRANCH_RESPONSIVENESS_E2E`).
- The opt-in watcher extension log (not enabled).
- Any behaviour of the running home `/home/andy/firstmate`; it was never touched.

## Evidence

Raw files were captured before teardown under `/tmp/pilot-evidence/`: `raw-stage12/` and `raw-final/` hold the store, cursor, processed marker, lock, extension-loaded marker, main/branch/fresh/flag-off session JSONL, the full main pane scrollback, and the watcher logs.
The lab root `/tmp/fmlab.3xWe1s` was left standing for inspection on this HOLD; the separate negative-control tmux server was stopped.
