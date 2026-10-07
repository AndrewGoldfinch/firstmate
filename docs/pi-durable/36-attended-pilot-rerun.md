# Pi Durable: attended-fleet pilot rerun - run record (FAIL - restart gate)

Status: **stopped at the first gate failure.**
The restart / startup-replay case consumed a **non-silent** row without a qualifying visible presentation, so the scored trial ended there.
The overlapping handover and every later stage were **not** run.
This record is the rerun's own report; the original pilot stays `HOLD - EVIDENCE` (`docs/pi-durable/34`, `docs/pi-durable/35`).

Author: crewmate `pi-durable-attended-pilot-rerun`. Date: 2026-10-07.
It reads `docs/pi-durable/34`, `docs/pi-durable/35`, and `data/pi-durable-attended-pilot-plan/report.md` (including §4b) and applies the captain's frozen criteria below.
Durable delivery stayed scoped to the lab's own primary through `FM_PI_DURABLE_DELIVERY=1`; no other process ever carried the flag.

## 1. Identity

| Property | Value |
| --- | --- |
| Lab root (default `mktemp -d`, no harness token) | `/tmp/fmlab.uesXll` |
| Pilot home (`FM_HOME`) | `/tmp/fmlab.uesXll/home` |
| Main destination session | `/tmp/fmlab.uesXll/pi-sessions/2026-10-07T19-39-24-844Z_01a117e0-b52c-7383-992d-17ffe703ac58.jsonl` |
| Pilot revision (pinned commit) | `77c2bb0989454f5265d9d9a688716609f9920822` |
| Helper revision (base) | `3bb6ab3795fa869f61a337e3f3a2692ebb7896fc` |
| This worktree at activation | `experiment/pi-durable-attended-pilot-rerun` on `53c98f67` |
| `fm-branch-supervision.ts` sha256 | `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09` |
| `fm-primary-pi-watch.ts` sha256 | `2a598446fc876c53b9ffe84cf761a5d0c510b31254532c734fd8eec71c3425e6` |
| Pi CLI | `1.0.4` |
| Node / platform | `v22.21.1` / `linux` |
| Model / effort | `opencode-go/muse-spark-1.3-contributor` / `medium` |
| Primary pids | `322897` (initial), `358228` (resumed) |
| Watcher arm/watcher pids | `328797`/`328820`, `334859`/`334875`, `342446`/`342462`, `386114`/`386137` |
| Watcher diagnostics | enabled: `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400` |

Activation command (run from this worktree, with the diagnostic bound exported):

```sh
FM_WATCH_EXTENSION_LOG_KEEP_LINES=400 bin/fm-live-lab.sh up --harness pi --durable-delivery --mate --worker \
  --source /home/andy/firstmate/projects/firstmate-pi-durable \
  --ref 77c2bb0989454f5265d9d9a688716609f9920822 \
  --model opencode-go/muse-spark-1.3-contributor --effort medium --timeout 900
```

The `up` readiness lines were green:

```
ok primary: pi pid 322897 in /tmp/fmlab.uesXll/home
ok probe: the primary answered LABREADY-86d57c52f68c
ok trust: Pi trust store unchanged (session-only --approve)
ok extensions: fm-primary-pi-watch fm-primary-turnend-guard fm-branch-supervision
ok watcher: live watcher with a fresh beacon
ok mate: lab86d57c52f68c-mate pid 317929 in /tmp/fmlab.uesXll/mate
ok worker: lab86d57c52f68c-worker parked on /tmp/fmlab.uesXll/home/data/lab86d57c52f68c-worker/gate
ok treehouse: ~/.treehouse unchanged
ready: /tmp/fmlab.uesXll
```

The base helper has no way to pass an arbitrary environment into the lab's clean base environment, so this worktree adds a default-off passthrough: when `FM_WATCH_EXTENSION_LOG_KEEP_LINES` is exported it is added to the Pi primary's launch env only.
The default (flag-off) presentation path is unchanged.

## 2. Frozen criteria (applied verbatim)

1. **Watcher continuity.** Diagnostics enabled; a timestamped timeline of ownership (`.lock` and `.pi-branch-extension-loaded`), watcher exit/start, beacon age, and wake receipt/acknowledgement. A non-owner refusal is expected only if successor coverage is independently demonstrated; otherwise it is a coverage gap. Planned restart downtime is defined separately, and queued-wake recovery is measured across it.
2. **Presentation.** Each sequence is tracked through persisted record, actual on-screen presentation (captured pane text or a rendered custom entry with `display:true`), and acknowledgement. Silent rows (`silent:true`) count as intentionally suppressed. **Hidden nudges (`display:false`) and tool results do not count as visible delivery.**
3. **Cursor attribution.** Identify exactly which path advances the cursor - startup replay versus extension reconciliation - per sequence. An advance without the required presentation is a failure to investigate.
4. **Stop discipline.** Stop at the first gate failure; preserve evidence; label anything collected afterward as diagnostic, outside the scored trial.

## 3. Stage order and result

The **restart / startup-replay case ran first**, as required.
The durable-delivery extension had already delivered the fleet's own startup rows (seq 1-3) before the restart, so the restart case was driven with a fresh row appended while no owner ran.

| Seq | Task | Verdict | Silent | Persisted record | Actual on-screen presentation | Acknowledgement | Cursor path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `lab86d57c52f68c-worker` | routine | false | `fm-branch-visible-routine` custom entry, deliveryId `1b61d27c-1b73-4b68-a278-b00e9dbc53de`, 19:40:35 | `⛵` rendered line on the pane | cursor advanced to 1; routine, processed marker unchanged | extension reconciliation (wake dispatch) |
| 2 | `lab86d57c52f68c-mate` | routine | false | `fm-branch-visible-routine` custom entry, deliveryId `83c6c4f1-4c4e-4214-8076-8b29a92cb52d`, 19:40:36 | `⛵` rendered line on the pane | cursor advanced to 2 | extension reconciliation (wake dispatch) |
| 3 | `lab86d57c52f68c-worker` | routine | true | `fm-branch-visible-routine` custom entry, deliveryId `3736e235-38a6-4ca7-b1e4-4d8e9b73c8e7`, 19:41:11 | none (suppressed, `silent:true`) | cursor advanced to 3 | extension reconciliation (wake dispatch) |
| 4 | `lab86d57c52f68c-worker` | routine | false | store row only (epoch 1791402207); **no custom entry, no delivery marker** | **none qualifying** - the summary occurs only inside a `caveman_retrieve` tool result (session line 23, 19:48:15); no `⛵` line, no `display:true` entry | cursor advanced 3 -> 4 | **startup replay** (`bin/fm-session-start.sh` -> `fm-branch-outcome.sh startup-replay`) |

Store ended at 4 rows, cursor `4`, `.branch-outcomes-processed` absent, `.branch-outcomes-delivered/` empty (read markers are reclaimed once the cursor passes).
No `captain` verdict occurred, so no `fm-branch-process` turn opened and the processed marker correctly never moved.

### Gate failure at seq 4

The fresh non-silent row (seq 4) was appended with **no owner running**:

```sh
FM_HOME=/tmp/fmlab.uesXll/home bin/fm-branch-outcome.sh append \
  --task lab86d57c52f68c-worker --verdict routine --silent false \
  --summary "RERUN restart probe: startup-replay visibility check; non-silent row appended with no owner running."
```

The primary was then resumed on the **recorded destination session** (`pi --session <file>`).
On the first turn, the agent ran `bin/fm-session-start.sh`.
That run invoked `fm-branch-outcome.sh startup-replay`, which printed the `BRANCH OUTCOMES` section for seq 4 and advanced the cursor 3 -> 4 (timeline: lock `358228` re-acquired ~19:48:10, cursor still 3; by 19:48:13 cursor `4`).

The row's summary exists in exactly one place in the session: a `caveman_retrieve` **tool result** (session line 23), because the session-start digest was compressed to a handle and then retrieved.
There is **no** `fm-branch-visible-routine` custom entry and **no** `⛵` line for seq 4.
The digest's `BRANCH OUTCOMES` JSON is visible in the pane capture only as part of that tool-result display.
Under frozen criterion 2 (tool results do not count as visible delivery) and criterion 3 (an advance without the required presentation is a failure to investigate), **seq 4 fails the gate**.

### Investigation of the startup-replay path

- `bin/fm-session-start.sh` runs `fm-branch-outcome.sh startup-replay` unconditionally for `pi`/`pi-signed` primaries, independent of `FM_PI_DURABLE_DELIVERY` (the replay call is in the locked Pi recovery block).
- `startup-replay` acquires the outcome lock, reads the unread set, prints the non-silent rows to the digest, and calls `advance_cursor` to the last replayable row.
- The durable extension's **visible** presentation runs on wake dispatch (`enqueueDelivery` -> `reconcileUnreadOutcomes(..., present=true)`) and after `fm_branch_report` appends a row (`reconcileUnreadOutcomes(toolGeneration)`).
- On `turn_end` the extension calls `reconcileUnreadOutcomes(turnGeneration, false)` - `present=false` - so a resumed idle session reconciles but does not present.
- Therefore a row that is unread when a Pi session resumes is consumed by `startup-replay` before any wake dispatch can present it; the only "presentation" is the session-start digest tool result.
- This reproduces the class of the original `HOLD - EVIDENCE` finding (seq 6): the summary is a tool artifact, not a rendered firstmate entry.

## 4. Watcher continuity timeline

Ownership (`.lock` and `.pi-branch-extension-loaded`):

| Time (UTC) | `.lock` | extension-loaded | Event |
| --- | --- | --- | --- |
| 19:39:24 | `322897` | `322897` | activation; primary owns the lock |
| 19:43:16 | `322897` (stale) | `322897` (stale) | primary exited (`ctrl+d`); watcher `342462` exits 143/TERM `arm-interrupted` |
| ~19:48:10 | `358228` | `322897` | resumed primary re-acquires the lock; extension marker not yet updated |
| 19:48:13 | `358228` | `358228` | extension marker matches; cursor advances to 4 |

Watcher cycles and beacon age (from `.watch-cycle-exits.log`, `.watch-extension.log`, and the timeline sampler):

| Cycle | Started | Ended | Reason | Beacon age |
| --- | --- | --- | --- | --- |
| `328820` | 19:39:42 | 19:40:14 | actionable-signal | 32 s |
| `334875` | 19:40:14 | 19:41:01 | actionable-stale | 0 s |
| `342462` | 19:41:01 | 19:43:16 | arm-interrupted (TERM) | 11 s |
| `386137` | ~19:48:31 | still live at stop | - | - |

- Normal-operation beacon age stayed within 0-32 s; the sampler recorded a maximum of **323 s** during the restart gap.
- **No `watcher: FAILED` alarm and no non-owner refusal occurred.** The session contains 0 `watcher: FAILED` lines and 0 `cannot restore continuity` lines; the extension log records only successful restores/confirms.
- Two `TURN WOULD END BLIND` supervision-off warnings fired (19:39:40 at startup, 19:48:29 on the resumed turn) before the watcher was re-armed; each was followed by a successful `fm_watch_arm_pi` start.
- **Planned restart downtime**: primary down 19:43:16 -> 19:43:34 (about 18 s). The **watcher** gap was longer, 19:43:16 -> 19:48:31 (about 315 s), because the resumed primary did not re-arm the watcher until its first turn, which the harness did not start on resume.
- **Queued-wake recovery across the downtime**: the downtime record `pending:downtime:342462.1791402196.X2Ahdz` was acknowledged on the resumed turn by `bin/fm-wake-drain.sh --ack-through 0 --recovery-generation 342462.1791402196.X2Ahdz`; it is now `acked:handling:342462.1791402196.X2Ahdz`. No wake was lost.

Classification: the restart produced a **coverage gap**, not a non-owner refusal.
Successor coverage was re-established only when the resumed session took its first turn; while the resumed session sat idle the home had no live watcher.
This is the measured restart behavior under the harness's resume path, not a crash.

## 5. Handover result

**Not exercised.**
The scored trial stopped at the restart/startup-replay gate, so the controlled option-2 handover (committed-marker / unadvanced-cursor overlap), the overlapping handover of owner and successor, and the rollback stages were not run.
No in-flight marker, no successor adoption, and no flag-off rollback were observed in this run.

## 6. Not exercised (explicit)

- The controlled option-2 handover and its overlapping owner/successor window.
- Successor adoption of a committed in-flight record; release of a replaced owner.
- The rollback (flag-off) positive lane and the separate unreconciled negative control.
- A `captain` verdict and the `fm-branch-process` / `fm_branch_processed` acknowledgement path.
- The `reserved`-with-no-committed-record sub-state and a genuinely non-holding destination.
- Any host power loss, filesystem corruption, or full production ownership-handover protocol.
- A real attended TUI keystroke-echo floor (covered separately by `FM_PI_BRANCH_RESPONSIVENESS_E2E`).
- The running home `/home/andy/firstmate`; it was never touched.

## 7. Evidence

Raw evidence was captured before any teardown under `/tmp/rerun-evidence/`:

- `branch-outcomes.jsonl`, `.branch-outcomes-cursor`, `.branch-outcomes-tail.jsonl` (store and cursor; `.branch-outcomes-processed` is absent).
- `2026-10-07T19-39-24-844Z_01a117e0-b52c-7383-992d-17ffe703ac58.jsonl` (main session; custom entries and the `caveman_retrieve` tool result at line 23).
- `.lock`, `.pi-branch-extension-loaded`, `.branch-eligible-owner`, `.branch-mirror-cursor`, `.watcher-down`.
- `.watch-extension.log`, `.watch-cycle-exits.log`, `.watch-deliveries.log`.
- `pane-initial.txt`, `pane-stage0.txt` (the seq 1/2 `⛵` lines), `pane-restart.txt`, `pane-final.txt`.
- `rerun-timeline.tsv` (3 s samples: ownership, extension marker, beacon age, store/cursor, last cycle) and `timeline-transitions.txt`.

The lab root `/tmp/fmlab.uesXll` was left standing for inspection, as the original HOLD run was.

## 8. Diagnostic material (outside the scored trial)

After the gate failure the trial was stopped.
The following was collected afterward as diagnostic only and is not scored:

- The primary remained live and the watcher healthy (`ok watcher`, beacon age 8 s) at stop.
- A final pane capture shows the restart probe and `BRANCH OUTCOMES` text still on screen as tool output.

## 9. Outcome

The rerun **fails the restart/startup-replay gate**: a non-silent row was consumed by startup replay with no qualifying user-visible presentation.
The durable mechanism itself was not shown defective for the rows it did present (seq 1-2 visible, seq 3 correctly suppressed), and the watcher stayed continuous in normal operation with no failure alarm.
The unproven item that remains is the one the original review named: whether a resumed Pi session ever presents a still-unread row through the durable visible path, or whether `startup-replay` always wins.
