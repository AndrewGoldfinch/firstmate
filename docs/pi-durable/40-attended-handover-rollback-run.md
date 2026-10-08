# Attended-fleet handover and rollback run

Status: **returned for independent review. All three gates passed on the scored path.**
This is the run the staged setup (`data/pi-durable-attended-pilot-handover-setup/report.md`) asked for: one bounded, isolated attended-fleet run of the overlapping option-2 handover and the reconciled rollback, on the fix for the startup-replay interaction (`38`, verified in `39`).
The earlier HOLD reports (`34`, `35`, `36`, `37`) stand untouched; this run supplies new evidence and replaces none of them.
Broader adoption stays pending this run's independent review.

Run author: crewmate `pi-durable-attended-pilot-handover-run`. Date: 2026-10-08.
Worktree branch `experiment/pi-durable-attended-pilot-handover-run`; no push, no PR, no merge.

## 1. Identity and pins

| Property | Value |
| --- | --- |
| Worktree HEAD (helper revision) | `79477b92ea2c08cf6b30c77d8e82b3874efa70bb` (ff-only from `origin/experiment/pi-durable-supervision`) |
| Pilot / lab source ref | `548fe33794dbcfc639fcd3dee2416c540c321b45` |
| Lab source clone | `/home/andy/firstmate/projects/firstmate-pi-durable` |
| Lab root (default `mktemp -d`, no harness token in the path) | `/tmp/fmlab.ZE9kAg` |
| Lab home (`FM_HOME`, lab primary checkout) | `/tmp/fmlab.ZE9kAg/home` |
| Main destination session | `/tmp/fmlab.ZE9kAg/pi-sessions/2026-10-08T01-32-18-516Z_01a11923-cad4-7548-b350-731ea6171a37.jsonl` |
| `fm-branch-supervision.ts` sha256 | `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09` (identical at both revisions) |
| `fm-primary-pi-watch.ts` sha256 | `2a598446fc876c53b9ffe84cf761a5d0c510b31254532c734fd8eec71c3425e6` |
| Pi CLI / SDK | `1.0.4` |
| Node / platform | `v22.21.1` / `linux` |
| Model / effort | `opencode-go/muse-spark-1.3-contributor` / `medium` |
| Watcher diagnostics | enabled: `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400` |
| Activation time | `up` 01:32:09 -> 01:32:51 UTC; every gate finished well inside the 120-minute wall clock |

The activation command was the staged one, run from this worktree with `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400` exported and the in-flight pause shim directory first on `PATH`:

```sh
FM_WATCH_EXTENSION_LOG_KEEP_LINES=400 bin/fm-live-lab.sh up --harness pi --durable-delivery --mate --worker \
  --source /home/andy/firstmate/projects/firstmate-pi-durable \
  --ref 548fe33794dbcfc639fcd3dee2416c540c321b45 \
  --model opencode-go/muse-spark-1.3-contributor --effort medium --timeout 900
```

The `up` readiness lines were all green: `ok primary`, `ok probe` (`LABREADY-3b89f4e55665`), `ok trust`, `ok extensions` (`fm-primary-pi-watch fm-primary-turnend-guard fm-branch-supervision`), `ok watcher`, `ok mate`, `ok worker`, `ok treehouse`, `ready: /tmp/fmlab.ZE9kAg`.

### The in-flight pause shim

The handover window is created deterministically with a `shim` directory that precedes the real `bash` on the owner's `PATH` (the doc-32 technique).
When the extension's `mark-read` subprocess is invoked and `$FM_HOME/pause-mark-read` exists, the shim consumes that file, records `mark-read-paused`, blocks until `$FM_HOME/release-mark-read`, and then execs the real `bash`:

```sh
#!/bin/sh
if [ -n "$FM_HOME" ] && [ "$2" = "mark-read" ]; then
  case "$1" in
    */bin/fm-branch-outcome.sh)
      if [ -f "$FM_HOME/pause-mark-read" ]; then
        rm -f "$FM_HOME/pause-mark-read"
        : > "$FM_HOME/mark-read-paused"
        while [ ! -f "$FM_HOME/release-mark-read" ]; do sleep 0.1; done
        rm -f "$FM_HOME/release-mark-read"
      fi
      ;;
  esac
fi
exec /bin/bash "$@"
```

The shim was only ever present on the owner's `PATH`; the successor and the flag-off lane ran with a clean `PATH`.

## 2. Per-process readiness (every resumed or successor process)

Every primary on the durable path was checked with `/proc/<pid>/environ` and the lock/extension markers, not only the first launch.

| Process | Role | pid | `FM_PI_DURABLE_DELIVERY` | `FM_WATCH_EXTENSION_LOG_KEEP_LINES` | `.pi-branch-extension-loaded` == `.lock` |
| --- | --- | --- | --- | --- | --- |
| Initial primary | `up` window `main` | `1416513` | `1` | `400` | yes (`1416513`) |
| Resumed primary | Stage A window `mainA` | `1450559` | `1` | `400` | yes (`1450559`) |
| Fresh owner | Stage B window `ownerB` | `1502996` | launched `1`; shim present on `PATH`; lock/marker match `1502996` (functional proof: it produced the durable seq6 record) | launched `400` | yes (`1502996`) |
| Successor primary | Stage B window `succB` | `1515119` | `1` | `400` | yes (`1515119`) |
| Flag-off primary | Stage C window `flagC` | `1537616` | `0` (intentional) | `400` | yes (`1537616`) |

The extension activated on every process that required it; the readiness gate did not fire.
The initial primary's `PATH` carried the shim because the lab tmux server was created from the shimmed environment.
`ownerB` was then launched with an explicit `PATH="$SHIM:$PATH"` after the first Stage-B attempt showed that a plain `tmux new-window` reset `PATH` from the client (see §4).

## 3. Stage A - short live restart / startup check (PASS)

A non-silent routine row (`seq 3`) was appended with **no owner running** (the owner had exited via Ctrl-D at 01:35:21), then a genuinely live Pi session was resumed on the recorded destination session (`--session <main session file>`).

```sh
FM_HOME=/tmp/fmlab.ZE9kAg/home bin/fm-branch-outcome.sh append \
  --task lab3b89f4e55665-worker --verdict routine --silent false \
  --summary "STAGE A restart probe: ..."
```

- At append: cursor `2`, `unread = {3}`.
- The resumed primary (`1450559`) acquired the lock and its extension loaded (`1450559`); the resume happened at 01:35:50.
- The first turn ran `bin/fm-session-start.sh`; its digest printed `seq 3` in a `BRANCH OUTCOMES` section (startup-replay), but the cursor was still `2` after that digest.
- The extension's `reconcileUnreadOutcomes` then persisted the delivery and advanced the cursor.

Per-sequence evidence:

| Field | Value |
| --- | --- |
| Persisted record | `custom` entry `fm-branch-visible-routine`, `seq 3`, `silent=false`, `deliveryId 842105e1-a6aa-4a10-9944-7124f77dae9f`, session timestamp `2026-10-08T01:36:43.216Z` |
| Rendered entry | the same custom entry, rendered on the pane |
| Captured pane line | `⛵ lab3b89f4e55665-worker: STAGE A restart probe: ...` |
| Cursor advance | `2 -> 3`, sampled `2` at 01:36:38 and `3` at 01:36:43 |
| Attribution | **extension `reconcileUnreadOutcomes`**, not `startup-replay` |

The cursor-advance attribution is timestamped: the session-start digest (a tool result, not a rendered entry) landed at ~01:36:38 with the cursor still `2`, and the durable entry that carries the cursor to `3` was written at 01:36:43.
This is the fix from `38` in the live product path: durable startup-replay prints the non-silent row but does not consume it.

## 4. Stage B - overlapping option-2 handover (PASS)

### 4a. First attempt (recorded, window not created)

A first arm at 01:41:25 appended `seq 5` and nudged the then-current owner.
That owner had been resumed with a plain `env ... pi ...`; tmux's client-environment update had **reset its `PATH`**, so its `PATH` did not contain the shim and its `mark-read` completed normally: `seq 5` was delivered as an ordinary durable entry and the cursor advanced `4 -> 5`.
No in-flight window existed; this attempt is recorded as a failed window, not a scored handover.

### 4b. Second attempt (scored handover)

The owner was relaunched (`1502996`) with `PATH="$SHIM:$PATH"` so the shim was first, and the marker/lock/extension all set to that pid.

1. `touch $HOME/state/pause-mark-read`; append `seq 6`; nudge the owner.
2. The owner's extension reserved the delivery, wrote the durable record, hit the shim on `mark-read`, and blocked. `mark-read-paused` appeared at 01:44:43.
3. In-flight window confirmed, cursor **unadvanced** at `5`, row **unread**, marker **committed**:

```text
durable=True  cursor=5  unread={6}
$HOME/state/.branch-outcomes-delivered/6 =
  {"version":2,"status":"committed","owner":"1502996","generation":1,
   "destination":"/tmp/fmlab.ZE9kAg/pi-sessions/2026-10-08T01-32-18-516Z_01a11923-cad4-7548-b350-731ea6171a37.jsonl",
   "deliveryId":"ff5a2a57-85a7-4f44-9788-6c6bd46c67a7"}
```

4. A second, genuinely live Pi primary (`1515119`, window `succB`) reopened the **recorded destination session**, took `state/.lock`, and reconciled.

| Field | Value |
| --- | --- |
| Store row count | `6` before and `6` after (unchanged: no competing durable record) |
| Session entries for `seq 6` | exactly **one** `fm-branch-visible-routine`, `deliveryId ff5a2a57-85a7-4f44-9788-6c6bd46c67a7`, owner's timestamp `2026-10-08T01:44:41.431Z` |
| Cursor advance | `5 -> 6` at 01:45:28, attributed to the successor's `adoptDurableDelivery` |
| Marker ledger | cleared after the cursor advanced |
| Home-wide deliveries | exactly one for `seq 6` |

5. The replaced owner was released (`release-mark-read`). It finished its already-authorized in-flight delivery and **started no new delivery**: the `seq 6` entry count stayed `1`, the store stayed `6`, and the cursor stayed `6`.

No non-owner refusal occurred; the successor adopted and completed the delivery.
Successor watcher coverage is nevertheless demonstrated independently in §7 (restore `1515119 -> watcher 1516033`, `result=confirmed`).

## 5. Stage C - reconciled rollback (PASS)

### Positive lane (real lab home)

- Reconciled steady state before the switch: cursor `6`, `unread` empty, marker ledger empty.
- A flag-off Pi primary (`1537616`, `FM_PI_DURABLE_DELIVERY=0`) ran on the same home and session with a clean `PATH`.
- No previously delivered row was replayed: durable entries stayed `6`, plain merge notes stayed `0`, cursor stayed `6`, `unread` stayed empty.
- A **new** routine row (`seq 7`) appended while the flag-off session was live used the ordinary flag-off path: a plain `custom_message` `fm-branch-merge` carrying `⛵ lab3b89f4e55665-worker: STAGE C flag-off new-row probe (seq7): ...` (session timestamp `2026-10-08T01:49:38.634Z`), the `⛵` line rendered on the pane, **no durable identity**, and the cursor advanced `6 -> 7`.

### Negative control (own disposable lane)

A separate disposable lane (`/tmp/fmneg.1zwG4v`) was built with the same extension and outcome script loaded by project auto-discovery, a clean home the owner never reconciled, and the same shim.

1. Append one non-silent routine row; `touch pause-mark-read`.
2. Durable owner reaches the in-flight point; **kill it** (process group, no release, no reconciliation).
3. Run flag-off on the same lane.

| Observation | Value |
| --- | --- |
| In-flight / orphaned | `durable=1`, `plain=0`, `cursor=0`, `unread=1`, `markers=[1]` |
| After flag-off | `durable=1`, `plain=1`, `cursor=1`, `unread=0` |
| Session | one `fm-branch-visible-routine` (ts `02:07:14.522Z`) **and** one `fm-branch-merge` plain note (ts `02:07:16.137Z`) for the same row |
| Verdict | `duplicateObserved=true` |

The duplicate reproduces exactly as designed, so reconciliation is load-bearing.

## 6. Per-sequence summary

| Seq | Task | Silent | Path / stage | Persisted record | Visible presentation | Cursor path |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | worker | false | normal operation | `fm-branch-visible-routine`, `deliveryId 159b5fef…`, 01:33:44 | `⛵` pane line | extension reconcile, `0 -> 1` |
| 2 | worker | true | normal operation | `fm-branch-visible-routine`, `deliveryId 5ac9602e…`, 01:33:59 | none (intentionally suppressed) | extension reconcile, `1 -> 2` |
| 3 | worker | false | **Stage A** | `fm-branch-visible-routine`, `deliveryId 842105e1…`, 01:36:43 | `⛵` pane line | **extension reconcile**, `2 -> 3` (startup-replay printed but did not consume) |
| 4 | mate | false | normal operation (incidental) | `fm-branch-visible-routine`, `deliveryId 68bae8fb…`, 01:37:56 | `⛵` pane line | extension reconcile, `3 -> 4` |
| 5 | worker | false | Stage B window attempt (not scored) | `fm-branch-visible-routine`, `deliveryId 65145406…`, 01:41:27 | `⛵` pane line | extension reconcile, `4 -> 5` |
| 6 | worker | false | **Stage B scored handover** | `fm-branch-visible-routine`, `deliveryId ff5a2a57…`, 01:44:41 | `⛵` pane line | successor adoption, `5 -> 6`; owner started no new delivery |
| 7 | worker | false | **Stage C flag-off** | none (no durable identity) | plain `fm-branch-merge` note, 01:49:38 | ordinary flag-off path, `6 -> 7` |

## 7. Watcher timeline and continuity

Diagnostics were on for the whole run; `.watch-extension.log` was copied at each stage transition so the 400-line retention limit could not erase handover evidence.

| Time (UTC) | Primary pid | Watcher pid | Event |
| --- | --- | --- | --- |
| 01:33:20 | `1416513` | `1429594` | restore `start=ok`, `confirm result=confirmed` |
| 01:33:53 | `1416513` | `1436239` | restore `start=ok`, `confirm result=confirmed` |
| 01:37:42 | `1450559` | `1466909` | resumed primary restores a watcher, `confirmed` |
| 01:45:21 | `1515119` | `1516033` | **successor** restores a watcher, `confirmed` |
| 01:47:59 | `1537616` | `1538358` | flag-off primary restores a watcher, `confirmed` |

Every restore logged `start=ok`; every confirm logged `result=confirmed`.
`.watch-cycle-exits.log` shows the ordinary `TERM` / `arm-interrupted` and `actionable-*` defaults at each owner exit and re-arm; no `watcher: FAILED` alarm was recorded.
A `.watcher-down` marker announced `handling:1516033.1791424061.7oRHWZ` during the Stage B handover gap, i.e. the gap was observed and handled, not silent.
The planned restart downtime (Stage A) was the owner down `01:35:21 -> 01:35:50`; the successor watcher came up with the resumed primary.

## 8. What was not exercised

- No `reserved`-with-no-committed-record sub-state and no non-holding-destination refusal were driven; §4a's plain, un-shimmed owner was a window attempt, not that sub-state.
- A **fresh** destination session (a destination that defers rather than adopts) was not run; only the recorded-destination adoption required by Stage B was.
- No `captain`-verdict row was forced in this run; every row was `routine`, so the captain processing/acknowledgement half was not re-exercised here (it is covered by `36`).
- No soak, multi-hour stability, or second-handover repeat was run; this is the single bounded trial.
- The negative control ran in a disposable synthetic lane, not the attended mate/worker fleet; its purpose is to prove reconciliation is load-bearing, not to re-run the fleet path.

## 9. Evidence

Raw evidence was captured before any teardown under `/tmp/fm-handover-evidence/`:

- `up.log`, `timeline.log`, `check1.log`; per-stage state snapshots (`00-up/`, `A-reconciled/`, `B-pre/`, `B-inflight-state/`, `B-complete/`, `final/`) with `branch-outcomes.jsonl`, `.branch-outcomes-cursor`, `.branch-outcomes-delivered/`, `.watch-extension.log`.
- Main session `pi-sessions/2026-10-08T01-32-18-516Z_01a11923-cad4-7548-b350-731ea6171a37.jsonl`.
- Per-stage pane captures (`A-pane-full.txt`, `B-complete/pane-*.txt`, `C-pane-flagC2.txt`).
- Watcher logs under `watcher/` (`.watch-cycle-exits.log`, `.watch-deliveries.log`, `.watch-triage.log`, `.watcher-down`, `.watch.lock.owner`).
- Negative lane under `/tmp/fmneg.1zwG4v/` plus `C-negative-run.log`, `C-negative-durable-owner.log`, `C-negative-flagoff-pane.txt`, and the lane script `run-negative-lane.sh`.

## 10. Outcome

Stage A, Stage B, and Stage C all met their gates on the scored path.
The overlapping option-2 handover produced exactly one home-wide delivery with adoption and no duplicate, the reconciled rollback did not replay delivered rows and kept the ordinary flag-off path for a new row, and the unreconciled negative control reproduced the duplicate.
The result is presented for independent review; broader adoption remains pending that review.
