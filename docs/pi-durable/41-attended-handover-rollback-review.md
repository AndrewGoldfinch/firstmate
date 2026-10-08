# Independent review - attended handover + rollback run (`40`, commit `f21a668d`, merged `3420e666`)

Status: **independent review complete. Three delivery gates confirmed from raw artifacts; one stated watcher-continuity claim fails.**
Verdict: **HOLD - EVIDENCE** - the run's core result stands, but the report's section 7 contains a false claim and a mis-cited artifact, and section 2's per-process environment claims have no raw capture in the evidence bundle.

## Scope and method

Reviewed `docs/pi-durable/40-attended-handover-rollback-run.md` at commit `f21a668d` against the raw artifacts captured before teardown:

- `/tmp/fm-handover-evidence/` (per-stage state snapshots, pane captures, watcher logs, main session transcript)
- `/tmp/fmneg.1zwG4v/` (disposable negative-control lane)
- Code at the lab source ref `548fe33794dbcfc639fcd3dee2416c540c321b45` and the helper revision `79477b92ea2c08cf6b30c77d8e82b3874efa70bb` (`bin/fm-branch-outcome.sh`, `.pi/extensions/fm-branch-supervision.ts`, `bin/fm-session-start.sh`)

Everything below is re-derived from the raw files. The lab root `/tmp/fmlab.ZE9kAg` is already torn down, so session/env claims were checked against the snapshots and the copied session transcript.

## Findings table

| # | Question | Finding | Evidence | Impact |
| - | -------- | ------- | -------- | ------ |
| 1 | Stage A: restart/startup row presented, cursor 2->3 extension-attributed (not `startup-replay`) | **CONFIRMED** | `timeline.log` cursor=2 at 01:36:38, cursor=3 at 01:36:43; `branch-outcomes.jsonl` seq3 mtime 01:35:41 (owner down 01:35:21->01:35:50); session custom entry seq3 `deliveryId 842105e1...` at 01:36:43.216Z; digest output (recovered object) shows `BRANCH OUTCOMES` seq3 + `WAKE_ACK_REQUIRED --ack-through 0`; extension marker `.pi-branch-extension-loaded` mtime 01:36:43.118Z; code proof below | No gate impact. The `38` fix behaves as claimed in the live path |
| 2 | Stage B: in-flight window, successor adoption, exactly one home-wide delivery, no duplicate/loss | **CONFIRMED** | `B-inflight-state`: cursor=5, `branch-outcomes.jsonl`=6, `.branch-outcomes-delivered/6`=`{"status":"committed","owner":"1502996","deliveryId":"ff5a2a57..."}`; `B-complete`: cursor=6, jsonl=6, delivered dir empty; session has exactly one `fm-branch-visible-routine` for `ff5a2a57`; cursor mtime 01:45:20.803 with `.lock`=1515119; release logged 01:45:53 | No gate impact. Adoption is the correct attribution; no loss or duplicate |
| 3 | Stage C: reconciled flag-off did not replay, new row used flag-off path, negative control duplicated | **CONFIRMED** | `B-complete` steady cursor=6, delivered empty, jsonl=6; `final` cursor=7, jsonl seqs 1-7; exactly one `fm-branch-merge` plain note at 01:49:38.634Z, no durable marker/entry for seq7; negative lane session has `fm-branch-visible-routine` (`b712ed65...`, 02:07:14.522Z) **and** `fm-branch-merge` (02:07:16.137Z) for the same row; `C-negative-run.log:8` `duplicateObserved=true` | No gate impact |
| 4 | Per-process readiness (`FM_PI_DURABLE_DELIVERY`, `FM_WATCH_EXTENSION_LOG_KEEP_LINES`, marker==lock) on every process | **PARTIALLY CONFIRMED** | marker equality holds at every snapshot (00-up 1416513, A-reconciled/B-pre 1450559, B-inflight 1502996, B-complete 1515119, final 1537616); flag values are functionally demonstrated (durable entry vs plain note). No `/proc/<pid>/environ` capture exists anywhere in the bundle | Section 2's exact env-table claims cannot be independently reproduced; behavior corroborates the flag, nothing corroborates the literal `400` |
| 5 | Watcher continuity: no `watcher: FAILED` alarm; gap observed/handled | **FAILED (claim false)** | A `watcher: FAILED` wake was delivered to the released owner at 01:45:54.055Z (session transcript row; `B-complete/pane-ownerB.txt:12-13`): "cannot restore continuity because this session no longer owns the lock" / "exited 143 without an actionable reason". Section 7 states "no `watcher: FAILED` alarm was recorded". Also, section 7 cites `.watcher-down`=`announced:handling:1516033...` for the Stage B gap, but the gap snapshot is `pending:handling:1466909...` (`B-inflight-state/.watcher-down`) and `acked:handling:1466909...` (`B-complete/state/.watcher-down`); `1516033` appears only in `final/` | Report accuracy, not the delivery gate. Successor coverage itself is real (see below), but the blanket "no FAILED" claim is wrong |
| 6 | First Stage-B attempt correctly labelled "not scored"; log-preservation prevented retention loss | **CONFIRMED (label) / VACUOUS (retention)** | `B-pre` cursor=4, jsonl=4; cursor=5 mtime 01:41:27.295; seq5 durable entry `65145406...` delivered with no window (cursor advanced), matching the "not scored" label. `.watch-extension.log` snapshots have 4/6/6/6/8/10 lines - the 400-line cap never bound, so "prevented retention from erasing" is trivially true but undemonstrated | Label is correct; the retention claim proves nothing |

## Detailed evidence

### 1. Stage A attribution (the `38` fix in the live path) - confirmed

Code, at the lab source ref `548fe33794dbcfc639fcd3dee2416c540c321b45`:

- `bin/fm-branch-outcome.sh` `startup-replay` (lines 806-838) prints the leading non-silent routine rows, then, when `durable_delivery_in_use` is true, advances the cursor only through leading **silent** rows: `LAST=$(... [.[] | .silent == true] | index(false) ...)`.
- `durable_delivery_in_use()` (lines 186-192) returns true for `FM_PI_DURABLE_DELIVERY` in `1|true|yes`.
- Row 3 is non-silent and the only unread row, so `LAST` is empty and startup-replay cannot advance the cursor.
- `.pi/extensions/fm-branch-supervision.ts` defines `VISIBLE_ROUTINE_ENTRY_TYPE = "fm-branch-visible-routine"` (line 204), appends it via `pi.appendEntry(customType, ...)` (line 1418), and `reconcileUnreadOutcomes` (lines 1716-1781) reads `unread`, delivers `ensureRoutineOutcome`, then `mark-read --through <seq>` and `clearDelivery`.

Raw ordering:

- `timeline.log`: `01:36:38Z cursor=2`, `01:36:43Z cursor=3 ext=1450559 lock=1450559`.
- `A-reconciled/state/branch-outcomes.jsonl` mtime `2026-10-07 18:35:41.377 -0700` (= 01:35:41Z), during the planned downtime `01:35:21 -> 01:35:50`.
- Session transcript: assistant thinking 01:36:38.768Z -> session-start tool result 01:36:43.048Z -> `custom` entry `fm-branch-visible-routine` seq3 at 01:36:43.216Z.
- `.pi-branch-extension-loaded` mtime `18:36:43.118 -0700` (= 01:36:43.118Z) with value `1450559`.
- The digest itself (recovered from the live caveman handle embedded in the session transcript) prints `BRANCH OUTCOMES ... {"seq":3,...,"silent":false,...}`.

The extension marker was written 0.098s before the custom entry and after the digest tool result, and the startup-replay code cannot consume a leading non-silent row; the cursor advance is therefore the extension's `reconcileUnreadOutcomes`. Confirmed.

### 2. Stage B overlapping handover - confirmed

- In-flight window: `B-inflight-state/.branch-outcomes-cursor` = `5`; `B-inflight-state/branch-outcomes.jsonl` = 6 rows (seq 6 present); `B-inflight-state/.branch-outcomes-delivered/6` = `{"version":2,"status":"committed","owner":"1502996","generation":1,"destination":".../01a11923...jsonl","deliveryId":"ff5a2a57-85a7-4f44-9788-6c6bd46c67a7"}`.
- Successor: `B-complete/state/.lock` = `1515119`, `.pi-branch-extension-loaded` = `1515119`; `.watch-extension.log` line `01:45:21.460Z pid=1515119 ... start=ok` and `01:45:21.791Z ... result=confirmed watcherPid=1516033`.
- Adoption, not owner completion: `B-complete/state/.branch-outcomes-cursor` mtime `01:45:20.803Z` (cursor 5->6) while the owner release is logged at `01:45:53Z` in `timeline.log`.
- No duplicate: the session has exactly one `fm-branch-visible-routine` per `deliveryId` (six total: `159b5fef`, `5ac9602e`, `842105e1`, `68bae8fb`, `65145406`, `ff5a2a57`); store count stayed 6 (`B-inflight-state` 6 -> `B-complete` 6).
- Both `B-complete/pane-ownerB.txt` and `B-complete/pane-succB-full.txt` show the single seq6 sailboat line.

### 3. Stage C rollback - confirmed

- Positive lane: `B-complete` steady state cursor=6, delivered dir empty, jsonl=6 (no unread). `final` cursor=7, jsonl=7. The only plain note in the session is one `custom_message` `fm-branch-merge` at `2026-10-08T01:49:38.634Z`, matching `C-pane-flagC2.txt:16`. No `.branch-outcomes-delivered/7` and no durable seq7 entry, so the new row used `deliverRoutineOutcome` (`ext548.ts:1454-1465`) - the ordinary flag-off path.
- Negative control `/tmp/fmneg.1zwG4v`: `C-negative-run.log:1` `NEG=/tmp/fmneg.1zwG4v`; lines 4/6 `PENDING`/`ORPHANED: durable_entries=1 plain_entries=0 cursor=0 unread=1 markers=[1 ]`; line 7 `AFTER-FLAGOFF: durable_entries=1 plain_entries=1 cursor=1 unread=0 markers=[1 ]`; line 8 `duplicateObserved=true`. The lane session independently contains both `fm-branch-visible-routine` (`b712ed65-...`, `02:07:14.522Z`) and `fm-branch-merge` (`02:07:16.137Z`) for the same row, and `state/.branch-outcomes-delivered/1` is still `committed` (owner 1656188).

### 4. Per-process readiness - partially confirmed

Marker equality `.pi-branch-extension-loaded == .lock` holds in every snapshot: 00-up 1416513, A-reconciled/B-pre 1450559, B-inflight-state 1502996, B-complete 1515119, final 1537616. Functional flag evidence: 1450559 and 1502996 produced durable entries; 1537616 produced only a plain note. However, the evidence bundle contains no `/proc/<pid>/environ` capture for any process (the only env files are the negative-lane `C-negative.env`/`C-negative-path`), so the section 2 table's literal `FM_PI_DURABLE_DELIVERY` / `FM_WATCH_EXTENSION_LOG_KEEP_LINES` columns are assertions rather than reproducible artifacts.

### 5. Watcher continuity - claim fails

- Successor coverage is real: `.watch-extension.log` shows every `start=ok` / `result=confirmed` (10 lines, matching the section 7 table), and `.watch-cycle-exits.log` records `successor=started:1516033` for the successor generation.
- But a `watcher: FAILED` alarm **was** recorded and delivered. Session transcript at `01:45:54.055Z` (role user, the wake text) and `B-complete/pane-ownerB.txt:12-13`:
  - `watcher: FAILED - Pi extension cannot restore continuity because this session no longer owns the lock`
  - `watcher: FAILED - watcher cycle exited 143 without an actionable reason`
  This is the released ownerB (it lost the lock to successor 1515119), and it was drained (`fm-wake-drain.sh` tool result at 01:45:57.777Z). Section 7's sentence "no `watcher: FAILED` alarm was recorded" is therefore false as written.
- The `.watcher-down` citation is also wrong for the gap. The gap snapshot `B-inflight-state/.watcher-down` is `pending:handling:1466909.1791423845.FE13Yl`; `B-complete/state/.watcher-down` is `acked:handling:1466909.1791423845.FE13Yl`. `announced:handling:1516033.1791424061.7oRHWZ` appears only in `final/state/.watcher-down` and `watcher/.watcher-down` (the end-of-run episode), not at the Stage B gap.

### 6. Labels and log preservation

- `seq 5` is labelled "Stage B window attempt (not scored)" in section 6, and the raw state supports that: `B-pre` cursor=4/jsonl=4, then cursor=5 at `01:41:27.295Z` with the durable `65145406` entry - the cursor advanced, so no in-flight window existed. Correct label.
- The `.watch-extension.log` copies at stage transitions have only 4/6/6/6/8/10 lines. The 400-line retention cap never came close to binding, so the claim that the log-preservation step "prevented retention from erasing the handover window" is true only vacuously and is not demonstrated by anything in the bundle.

## Claims not confirmed / unexercised

- Section 2's per-process `/proc/<pid>/environ` values (`FM_PI_DURABLE_DELIVERY`, `FM_WATCH_EXTENSION_LOG_KEEP_LINES`) have no raw artifact; only the marker files and the resulting behavior are reproducible.
- The section 7 "no `watcher: FAILED` alarm" claim is falsified (see finding 5); the successor's own continuity is not in question, but the report overstates.
- The exact shim/`PATH`-reset mechanism for the first Stage-B attempt (`4a`) is described in prose only; no artifact in the bundle records the `PATH` reset or the `pause-mark-read`/`mark-read-paused` files for the scored run (the lab home is gone). The window for `seq 6` is still proven by `B-inflight-state`.
- Evidence-bundle hygiene: `C-negative.env` names `/tmp/fmneg.fXWCws` while `C-negative-run.log:1` names `/tmp/fmneg.1zwG4v` (four `fmneg.*` lanes exist: `fXWCws`, `3WrNFx`, `m2NGUl`, `1zwG4v`); `C-negative-flagoff.log` contains `bash: line 1: /negative.pid: Permission denied` plus `NEGOK` (the durable owner's expected reply) rather than flag-off output. The final lane's session/state files are internally consistent, so the negative result stands, but the bundle mixes attempts.
- Code-revision context: the verified behavior lives on branch `experiment/pi-durable-supervision` (`3420e666`). The current default-branch HEAD `1f3e7696` does not contain `3420e666` and has a different `fm-branch-supervision.ts` (`7321a53b...` vs the verified `cc9cac0c...`). This is expected for a pilot branch but means the verified revision is not the default branch.
- Not exercised (as the report itself notes): fresh-destination deferral, non-holding-destination refusal, `reserved`-with-no-committed-record sub-state, captain-verdict rows, soak/second handover. Unchanged by this review.

## Recommendation

The three delivery gates (A restart presentation, B overlapping handover exactly-once, C reconciled rollback + negative control) are confirmed from raw artifacts and the code path. No implementation defect was reproduced; no code change is required for the gates.

Before this run is used as the basis for broader adoption, section 7 must be corrected:

1. Replace "no `watcher: FAILED` alarm was recorded" with the accurate statement: a `watcher: FAILED` was surfaced by the released owner when it lost the lock (`01:45:54.055Z`), which is expected under the documented lost-lock contract, and the scored successor's continuity was separately confirmed.
2. Cite the Stage B gap marker actually present in the snapshot (`pending:handling:1466909...` at `B-inflight-state`, `acked:...` at `B-complete`), not the end-of-run `1516033` marker.
3. Either attach the per-process `/proc/<pid>/environ` captures for section 2 or soften those columns to what the marker/behavior evidence supports.
4. Optionally tidy the negative-lane bundle so the cited lane (`/tmp/fmneg.1zwG4v`) is the only one referenced.

These are report/evidence corrections, not a re-run of the pilot.

HOLD - EVIDENCE
