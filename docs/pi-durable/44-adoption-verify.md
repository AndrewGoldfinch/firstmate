# Enabled-home delivery and restart verification (read-only)

Subject of the verified run: **enabled-home delivery and restart verification** of the dedicated Pi primary home `/home/andy/pi-durable-adoption` (`docs/pi-durable/43-adoption-home-run.md`).

This report was produced by an independent, **read-only** re-derivation from the raw home state (state files, store, session JSONL, git), not from the report summary. No fault was injected, the home was not restarted, and no other home or personal session was touched. The deliverable is this report; no code was changed.

## 0. Critical context found at verification time

The home is **no longer running**. At verification time (2026-10-08 ~14:48Z, epoch 1791471219):

- No process matches `pi-durable-adoption` (`ps -eo pid,cmd | rg pi-durable-adoption` returns nothing).
- The private tmux server is gone: `tmux -L pi-durable-adoption list-sessions` -> `no server running on /tmp/tmux-1000/pi-durable-adoption`, although the stale socket `/tmp/tmux-1000/pi-durable-adoption` remains.
- The recorded lock pid `2464141` (`.lock`), and every other recorded pid (`2467879`, `2455116`, `2400913`, `2350515`), is dead (`/proc/<pid>` absent).
- `state/.last-watcher-beat` is `2026-10-07 23:21:11 -0700` = `2026-10-08T06:21:12Z`; `state/.watch-cycle-exits.log` last entry is watcher `2467879`, `ended_at=1791440472` = `2026-10-08T06:21:12Z`, `signal=TERM`, `reason=arm-interrupted`, `successor=none`.
- `state/.watcher-down` contains `pending:downtime:2369655.1791439130.CbQm8p`.

The report was written `2026-10-07 23:20:44 -0700` (`06:20:44Z`) and the home stopped ~28s later. The report itself says (section 8) the home *is* live on `en6`; that is now false. Consequences:

- `/proc/<pid>/environ` cannot be re-read (no live pid), so the environment claims are report-recorded only.
- No pane text survives, so the `⛵` *presentation* claims cannot be independently re-established from raw state (see item 11 in the findings table).

`tmux -L pi-durable-adoption kill-server` is **abrupt termination**. It is not the reconcile-before-disable rollback procedure (report section 6). It is only acceptable as the stop step immediately before a relaunch that keeps `FM_PI_DURABLE_DELIVERY=1`; it must not be used as the way to switch back to flag-off.

## 1. Pinned revision, isolation, environment, activation, watcher health

```
$ cd /home/andy/pi-durable-adoption
$ git rev-parse HEAD
15cbe64a309cfcdebcbc988ecff15ba2f0479f5c
$ git log --oneline -1
15cbe64a docs(pi-durable): archive the corrected-report re-verification; record ADVANCE
$ git status --porcelain          # (empty)
$ git rev-parse --show-toplevel
/home/andy/pi-durable-adoption
$ git worktree list
/home/andy/pi-durable-adoption  15cbe64a (detached HEAD)
$ sha256sum .pi/extensions/fm-branch-supervision.ts .pi/extensions/fm-primary-pi-watch.ts .pi/extensions/fm-primary-turnend-guard.ts
cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09  fm-branch-supervision.ts
2a598446fc876c53b9ffe84cf761a5d0c510b31254532c734fd8eec71c3425e6  fm-primary-pi-watch.ts
514050e21576e446b262fcd458cb137a0a3be8770453b0d3966ed30a1e3828d6  fm-primary-turnend-guard.ts
```

The two extension digests match report section 1 exactly. Isolation markers:

```
.fm-secondmate-home      -> does not exist
.fm-secondmate-parent    -> does not exist
data/secondmates.md      -> does not exist
data/                    -> projects.md only
config/                  -> startup-memory-budget only
data/projects.md         -> - firstmate-pi-durable [local-only branch=experiment/] ...
```

No `data/backlog.md`, no `state/*.status`, no `state/*.meta` -> no worker, second mate, or backlog activity in this home.

Activation markers:

```
state/.lock                      = 2464141
state/.pi-branch-extension-loaded = 2464141
state/.pi-turnend-extension-loaded = sha256:514050e2...828d6 \n 2464141
state/.pi-watch-extension-loaded -> does not exist
```

The `.pi-watch-extension-loaded` marker is **removed on non-replacement shutdown** by design: `.pi/extensions/fm-primary-pi-watch.ts` writes it in `publishGenerationOwner` (line ~280) and removes it in `retireGenerationOwner` via `unlinkSync(marker)` (line ~306) when `replacement` is false. Its present absence is therefore explained by the home having stopped, and is not itself a defect; but it means this half of the activation claim cannot be re-verified now.

## 2. Raw per-sequence evidence

Store `state/branch-outcomes.jsonl` (703 bytes, mtime `23:16:13 -0700`), four rows, all `verdict=routine`, all `silent:false`:

```
{"seq":1,...,"summary":"Durable routine probe one"}
{"seq":2,...,"summary":"Durable routine probe two"}
{"seq":3,...,"summary":"Durable routine probe three"}
{"seq":4,...,"summary":"Durable routine probe four"}
```

Cursor `state/.branch-outcomes-cursor` = `4`, mtime `2026-10-07 23:16:49.756596790 -0700` (`06:16:49.756Z`).
`state/.branch-outcomes-tail.jsonl` is byte-identical in size (703).
`state/.branch-outcomes-delivered/` is empty (no leftover reservation markers).
`state/.branch-outcome-index-ready` = `4`; `state/.adoption-observe.branch-outcome-index` = `fm-branch-outcome-index-v1	4	0	-`.

Six session files under `state/pi-sessions/`, each with its lock pid from its session-start digest:

| Session JSONL (start) | lock pid | `fm-branch-visible-routine` entries |
| --- | --- | --- |
| `2026-10-08T05-53-05...` | 2350515 | 0 |
| `2026-10-08T06-04-17...` | 2394124 | 0 |
| `2026-10-08T06-05-14...` | 2400913 | 1 (seq 1) |
| `2026-10-08T06-10-02...` | 2423889 | 0 |
| `2026-10-08T06-16-13...` | 2455116 | 1 (seq 4) |
| `2026-10-08T06-17-36...` | 2464141 | 0 |

- Persistence, seq 1: session `...06-05-14...jsonl:14` -> `{"type":"custom","customType":"fm-branch-visible-routine","data":{"version":1,"seq":1,"task":"adoption-observe","verdict":"routine","summary":"Durable routine probe one","silent":false,"deliveryId":"57ad6b86-e2ec-4766-9693-17d435aabfb6"},"id":"773f0b90","timestamp":"2026-10-08T06:09:24.344Z"}`. Matches report section 5 row 1.
- Persistence, seq 4: session `...06-16-13...jsonl:11` -> same shape, `seq:4`, `deliveryId":"3374794c-51ba-4fe1-b31d-ebb3bb8a135e"`, `timestamp":"2026-10-08T06:16:49.727Z"`. The same session's digest at line 8 contains `BRANCH OUTCOMES ... {"seq":4,..."Durable routine probe four"...}`. Matches report section 5 row 4.
- **No `fm-branch-visible-routine` entry exists anywhere for seq 2 or seq 3.** `rg 'probe two|probe three'` over all six sessions returns nothing.
- **Actual presentation** (`⛵` pane line): no pane capture was persisted anywhere in the home (`rg '⛵'` matches only source/docs and one occurrence per session of the supervision-instructions boilerplate, not a rendered note line; `state/terminal-outcomes/` is empty). With the tmux server gone, the `⛵ adoption-observe: ...` lines cannot be independently re-confirmed from raw state. The persisted `customType=fm-branch-visible-routine` entries are the durable records whose rendering produces those lines, and their `summary` values match the report's pane strings, but that is persistence, not captured presentation.
- **Cursor advancement writer**: `bin/fm-branch-outcome.sh` header (~line 109) states `mark-read` is the reader that advances the cursor after presentation; with durable delivery on, `startup-replay` advances the cursor only through leading `silent` rows and leaves non-silent rows for the extension (header ~lines 136-141). The extension's `reconcileUnreadOutcomes` calls `ensureRoutineOutcome(...)` then `runOutcomeScript(["mark-read","--through",String(row.seq)])` then `clearDelivery(...)` (`.pi/extensions/fm-branch-supervision.ts` ~lines 1777-1782). So the seq-1 and seq-4 advances were written by the extension's `mark-read`, matching the report ("the turn's reconcile" / cursor `3 -> 4`). The final cursor write mtime `06:16:49.756Z` is the seq-4 advance. Intermediate cursor values (e.g. `0 -> 1`) are not observable now.
- **Restart non-duplication**: the final session `...06-17-36...` (pid 2464141) contains **0** routine entries and no `BRANCH OUTCOMES` section; cursor stayed `4`; the delivered dir is empty. An acknowledged row was not re-delivered. Across the whole run the store held 4 rows and the sessions held exactly 2 routine entries.

## 3. Manual flagless `startup-replay` and corrected counts

The report's method note says an operator-invoked `bin/fm-branch-outcome.sh startup-replay` run from a shell **without** `FM_PI_DURABLE_DELIVERY` took the flag-off path and consumed one row (`seq 3`). The code path is exactly that: without the flag the printed digest is the presentation and the cursor advances through the leading non-silent routine rows (header ~lines 130-143).

Raw-state finding: **two** rows have no persisted delivery entry, `seq 2` and `seq 3`. The report attributes only `seq 3`; `seq 2` is not mentioned anywhere in the report and has no persisted `fm-branch-visible-routine` entry and no digest appearance. The report's cursor-mtime claim for the manual advance (`06:09Z`) cannot be checked now because that mtime was overwritten by the seq-4 advance (`06:16:49Z`).

Corrected counts (raw state, independently re-derived):

- Store rows: **4** (`seq 1..4`, all routine, non-silent).
- Rows with a persisted durable delivery entry: **2** (`seq 1`, `seq 4`).
- Rows with no persisted delivery entry: **2** (`seq 2` unattributed, `seq 3` report-attributed to the manual flagless replay).
- Suggested "successful delivery" count: **2 of 4** (`seq 1`, `seq 4`). `seq 3` is excluded as an operator artifact; that exclusion does not add or remove a success because `seq 3` never had a persisted entry. `seq 2` remains unexplained and must not be counted as a success.
- Independently re-established `⛵` presentations (captured pane): **0** (no pane survives).
- Restart non-duplication check (`seq 4` acknowledged, then restarted): **passes**.

## 4. Reconciled steady state and exact relaunch/rollback procedure

Raw steady state (all confirmed from files, not the report summary):

```
state/.branch-outcomes-cursor    = 4
store tail seq                   = 4
state/branch-outcomes.jsonl rows = 4
state/.branch-outcomes-delivered/ -> empty
unread                           -> empty by (cursor == store tail)
stage/.branch-outcome-index-ready = 4
```

The report's section 6 rollback statement is the correct procedure: keep a live flag-on owner (or bring one back) until `reconcileUnreadOutcomes` completes; confirm `bin/fm-branch-outcome.sh unread` prints nothing, the cursor equals the store tail, and no leftover reservation marker exists for an already-read row; only then stop the flag-on primary and relaunch with `FM_PI_DURABLE_DELIVERY=0`; then confirm no replay by an unchanged record count, an unchanged cursor, and a new routine row taking the ordinary plain-note path.

Exact relaunch shape (report section 2), with `FM_PI_DURABLE_DELIVERY=1` to stay enabled and `=0` only after reconciliation to disable:

```
cd /home/andy/pi-durable-adoption
env -u FM_HOME -u FM_ROOT -u FM_PI_HARNESS -u FM_TASK_ID -u FM_TASK_INBOX \
    -u PI_CODING_AGENT -u PI_MODEL -u PI_PROVIDER -u PI_REASONING_LEVEL -u PI_SESSION_FILE -u PI_SESSION_ID \
    $(for v in $(env | sed -n 's/^\(FM_[A-Za-z0-9_]*_OVERRIDE\)=.*/\1/p'); do printf -- '-u %s ' "$v"; done) \
    FM_HOME=/home/andy/pi-durable-adoption \
    FM_PI_DURABLE_DELIVERY=1 \
    FM_WATCH_EXTENSION_LOG_KEEP_LINES=400 \
    pi --approve \
       --session-dir /home/andy/pi-durable-adoption/state/pi-sessions \
       --model opencode-go/muse-spark-1.3-contributor \
       --thinking medium
```

`tmux -L pi-durable-adoption kill-server` alone is **not** the reconcile-before-disable rollback; it is an abrupt stop. If the flag is still set to `1`, a subsequent launch resumes durable delivery; if it was flipped to `0` without the reconcile above, a still-unread durable row is re-presented as a plain note and duplicated (the flag-off path recognizes no durable record).

## 5. Findings table

| Item | Confirmed? | Evidence | Impact |
| --- | --- | --- | --- |
| Code root pinned at `15cbe64a` | Yes | `git rev-parse HEAD` = `15cbe64a309cfcdebcbc988ecff15ba2f0479f5c`; clean tree; single- worktree list | Pinned, reproducible |
| Extension builds match the pin | Yes | sha256 of `fm-branch-supervision.ts` `cc9cac0c…`, `fm-primary-pi-watch.ts` `2a5984…` match report section 1 | Activation contract reproducible |
| Pi primary, not a second mate | Yes | no `.fm-secondmate-home`/`.fm-secondmate-parent`, no `data/secondmates.md` | Scope/isolation claim holds |
| Registry / delivery posture | Yes | `data/projects.md`: `local-only branch=experiment/`, no `+yolo` | Merge authority off |
| No worker/secondmate/backlog activity | Yes | no `data/backlog.md`, no `state/*.status`, no `state/*.meta` | Confirms "no ordinary supervised project work" |
| Live env `FM_PI_DURABLE_DELIVERY=1`, `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400`, no redirect | No (re-verifiable) | No live pid; `/proc/<pid>/environ` gone; state paths all resolve under the home | Environment claim is report-recorded only |
| `.pi-branch-extension-loaded` names lock holder | Yes | file = `2464141` = `state/.lock` | Activation evidence holds |
| `.pi-watch-extension-loaded` present | No (re-verifiable) | File absent; removed on shutdown by design (`fm-primary-pi-watch.ts` ~line 306 `unlinkSync`) | Marker cannot be re-checked; absence explained |
| Watcher healthy during the run | Partially (historical) | `state/.watch-cycle-exits.log` shows watcher pids/beacons through `06:21:12Z`; `.last-watcher-beat` `06:21:11Z` | Live health not re-verifiable; home now stopped, `.watcher-down` set |
| Seq 1 persistence | Yes | session `…06-05-14…jsonl:14`, `seq:1`, `deliveryId 57ad6b86…`, ts `06:09:24.344Z` | Exact-once persisted record |
| Seq 4 persistence | Yes | session `…06-16-13…jsonl:11`, `seq:4`, `deliveryId 3374794c…`, ts `06:16:49.727Z` | Restart-resume persisted record |
| Seq 1/4 actual `⛵` pane presentation | No | No pane capture persisted; tmux server gone; sessions hold only the durable entries | Presentation not independently established |
| Cursor advancement writer (seq 1, 4) | Yes | `bin/fm-branch-outcome.sh` header (~109, ~136-141); extension `…ts` ~1777-1782 `mark-read`; cursor mtime `06:16:49.756Z` | Writer is the extension reconcile, as reported |
| Restart non-duplication | Yes | final session (`2464141`) 0 routine entries, no `BRANCH OUTCOMES`; cursor 4; delivered dir empty | Exactly-once across restart holds |
| Manual flagless `startup-replay` affected row(s) | Partially | `seq 3` report-attributed, no persisted entry; **`seq 2` also has no entry and is unexplained** | One success count must not include seq 3; seq 2 remains a gap |
| Reconciled steady state | Yes | cursor 4 == store tail 4; delivered dir empty; tail file matches store | Steady state precondition for rollback holds |
| Rollback procedure (reconcile before flag-off) | Yes (in report section 6) | Report section 6 text; `kill-server` alone is abrupt stop, not this procedure | Procedure is correctly stated but the home is currently only stopped, not rolled back |
| Home live at verification time | No | No `pi-durable-adoption` process; tmux server gone; `.watcher-down` set | Report section 8 "live on en6" is stale |

## 6. What this verification establishes and what it does not

Establishes:

- The pinned, clean, correctly isolated Pi-primary code root with the expected extension binaries.
- A four-row durable store whose final read state is internally consistent (`cursor == tail == 4`, no leftover markers) and whose two persisted delivery entries (`seq 1`, `seq 4`) match the report exactly, including the restart-resume `seq 4` record and the non-re-delivery of an acknowledged row.
- That cursor advancement on those two rows is written by the branch extension's `mark-read` path, not by a tool result.

Does not establish:

- Any actual `⛵` pane presentation (no pane capture survives; no live pane).
- The live process environment at verification time (no live pid) or the watch-extension activation marker (removed on shutdown).
- The disposition of store row `seq 2`, which has no persisted delivery entry and is not mentioned in the report.
- That this run demonstrates ordinary supervised project work: there was no worker, second mate, or backlog activity, and durable delivery only covered the four synthetic routine probe rows.
- That a disable rollback was performed (it was not; only the reconcile precondition was confirmed, and the home is now merely stopped).

## 7. Scratch commands (read-only; run from this scout)

```
git rev-parse HEAD / git log / git status / git worktree list   (in /home/andy/pi-durable-adoption)
sha256sum .pi/extensions/*.ts
ls -la /home/andy/pi-durable-adoption/{data,config,state}
cat state/{.lock,.pi-branch-extension-loaded,.pi-turnend-extension-loaded,.watcher-down}
cat state/{branch-outcomes.jsonl,.branch-outcomes-cursor,.branch-outcome-index-ready,.adoption-observe.branch-outcome-index}
cat state/.watch-cycle-exits.log ; stat state/.last-watcher-beat
ls -la state/pi-sessions ; rg -n 'fm-branch-visible-routine|BRANCH OUTCOMES' state/pi-sessions/*.jsonl
for p in 2464141 2467879 2455116 2400913 2350515; do [ -d /proc/$p ] && echo alive || echo dead; done
tmux -L pi-durable-adoption list-sessions
```

No repository code and no live-home file was modified; no commit was created or pushed.

## Verdict

HOLD - EVIDENCE
