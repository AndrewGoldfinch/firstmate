# Dedicated Pi primary adoption home: `pi-durable-adoption` created, durable delivery enabled, observed

Status: **complete. The captain-approved adoption home exists, durable delivery is enabled in it, and readiness, enablement, restart and per-sequence delivery were observed on the live home.**

This task created exactly one home, `/home/andy/pi-durable-adoption`, per the captain's approval; `/home/andy/firstmate` and every personal Pi session were untouched.
It implements the staged configuration in `data/pi-durable-adoption-home-setup/report.md` with the captain's corrections (model `opencode-go/muse-spark-1.3-contributor`, thinking `medium`) against the pinned code root `15cbe64a`.
The earlier HOLD reports stand untouched; broader adoption and default-on behavior are not started here.
Delivery is a local branch only: no push, no PR, no merge.

## 1. Home created

| Role | Path |
| --- | --- |
| Home (`FM_HOME`) | `/home/andy/pi-durable-adoption` |
| Code root (primary checkout) | `/home/andy/pi-durable-adoption`, detached at `15cbe64a309cfcdebcbc988ecff15ba2f0479f5c` |
| `origin` | `git@github.com:AndrewGoldfinch/firstmate.git` (the fork, matching the main home's clone) |
| Operational dirs | `state/`, `data/`, `config/`, `projects/`, `state/pi-sessions/` |
| Project clone | `projects/firstmate-pi-durable`, branch `experiment/pi-durable-supervision` |
| Pi sessions | `state/pi-sessions/` (dedicated; the personal Pi session store is not used) |

The home is a Pi **primary**: no `.fm-secondmate-home` and no `.fm-secondmate-parent` were written, `data/secondmates.md` is absent, and neither `bin/fm-home-seed.sh` nor `bin/fm-lab-home.sh` was run.
`state/`, `data/`, `config/` and `projects/` are gitignored, so the root checkout stays clean at the pin.

One project is in scope, registered in `data/projects.md` byte-for-byte from the main home's line for the same project:

```
- firstmate-pi-durable [local-only branch=experiment/] - Personal experiment: the FirstMate Pi Durable supervision prototype, developed on the fork branch experiment/pi-durable-supervision; design and P0 notes under docs/pi-durable/. (added 2026-10-03)
```

That entry carries `local-only` and no `+yolo`, so merge authority stays **off**; `branch=experiment/` matches the registered ship-branch prefix.
There is no `data/secondmates.md`, so the home has no second mate of its own.

Recorded code identity at the pin (all four files come from the pinned tree):

| Artifact | Value |
| --- | --- |
| `HEAD` | `15cbe64a309cfcdebcbc988ecff15ba2f0479f5c` (`docs(pi-durable): archive the corrected-report re-verification; record ADVANCE`) |
| `.pi/extensions/fm-branch-supervision.ts` sha256 | `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09` (identical to the digest recorded in the staged report) |
| `.pi/extensions/fm-primary-pi-watch.ts` sha256 | `2a598446fc876c53b9ffe84cf761a5d0c510b31254532c734fd8eec71c3425e6` |
| `.pi/extensions/fm-primary-turnend-guard.ts` sha256 | `514050e21576e446b262fcd458cb137a0a3be8770453b0d3966ed30a1e3828d6` |
| Project clone `HEAD` at clone time | `3420e666a2c22c65cf86c58cdba0dc7b7293a6f7` on `experiment/pi-durable-supervision` |

## 2. Launch environment and isolation

Every launch of this home's Pi primary used the same shape; only `FM_PI_DURABLE_DELIVERY` changed.
Inherited overrides that could have redirected operations were removed rather than relied on: `FM_HOME`, `FM_ROOT`, any `FM_*_OVERRIDE` (`FM_STATE_OVERRIDE`, `FM_ROOT_OVERRIDE`, `FM_DATA_OVERRIDE`, `FM_CONFIG_OVERRIDE`, and any other), the worker-role variables (`FM_PI_HARNESS`, `FM_TASK_ID`, `FM_TASK_INBOX`), and this session's `PI_*` variables.

```
cd /home/andy/pi-durable-adoption
env -u FM_HOME -u FM_ROOT -u FM_PI_HARNESS -u FM_TASK_ID -u FM_TASK_INBOX \
    -u PI_CODING_AGENT -u PI_MODEL -u PI_PROVIDER -u PI_REASONING_LEVEL -u PI_SESSION_FILE -u PI_SESSION_ID \
    $(for v in $(env | sed -n 's/^\(FM_[A-Za-z0-9_]*_OVERRIDE\)=.*/\1/p'); do printf -- '-u %s ' "$v"; done) \
    FM_HOME=/home/andy/pi-durable-adoption \
    FM_PI_DURABLE_DELIVERY=0 \
    FM_WATCH_EXTENSION_LOG_KEEP_LINES=400 \
    pi --approve \
       --session-dir /home/andy/pi-durable-adoption/state/pi-sessions \
       --model opencode-go/muse-spark-1.3-contributor \
       --thinking medium
```

Enablement is the same command with `FM_PI_DURABLE_DELIVERY=1`; the flag is read by `.pi/extensions/fm-branch-supervision.ts` at module load and by `bin/fm-branch-outcome.sh` at each read, so there is no config-file switch.
`--approve` keeps the shared Pi trust store untouched and `--session-dir` keeps the home's dialog out of the personal session store.
The primary was run under a private tmux server (`tmux -L pi-durable-adoption -f /dev/null`) so the user's tmux configuration never applies and no other session is disturbed.

The live primary's environment was read directly from `/proc/<lockpid>/environ` and contained exactly the intended entries — no redirect and no inherited worker variable:

```
FM_HOME=/home/andy/pi-durable-adoption
FM_PI_DURABLE_DELIVERY=1
FM_WATCH_EXTENSION_LOG_KEEP_LINES=400
```

## 3. Readiness launch (flag OFF) — passed

The flag-off launch was verified before anything was enabled.

| Check | Evidence |
| --- | --- |
| Session-start digest names this home | digest header `SESSION START - /home/andy/pi-durable-adoption`, `lock acquired: harness pid 2350515`, `BOOTSTRAP (silent - all good)`, `WAKE QUEUE (no queued wakes)` |
| `state/.lock` names the lock holder | `2350515`, live `pi` process |
| Branch extension loaded by the same pid | `state/.pi-branch-extension-loaded` line 1 = `2350515` = `state/.lock` line 1 |
| Watch and turn-end extensions loaded at their build by the lock holder | `state/.pi-watch-extension-loaded` and `state/.pi-turnend-extension-loaded` each carry the on-disk sha256 and pid `2350515` |
| Per-process environment | `/proc/2350515/environ`: `FM_PI_DURABLE_DELIVERY=0`, `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400`, `FM_HOME=/home/andy/pi-durable-adoption`; no `FM_TASK_ID`, `FM_TASK_INBOX` or `PI_SESSION_ID` |
| Watcher health green | `fm_watcher_healthy` true for pid `2369655`; model-aware `fm_watcher_supervision_verdict` `ok=true` with a fresh beacon |

The document-and-inspectable session entry is the reason the digest is quoted from the session JSONL rather than the pane: Pi renders the digest as a tool result, not as a conversation entry, and the TUI's alternate screen does not retain it in tmux history.
The branch marker is written lazily on first ownership activation, so it appears only after session start has completed; an absent marker before that point is not a failure.

The first watcher cycle is a model action, not a launch side effect: the emitted supervision block instructs the primary to make one `fm_watch_arm_pi` call at initial process start, and a freshly launched primary arms no watcher until it does.
The primary was therefore steered with one narrow message to make that single documented call; the tool replied `watcher: started Pi extension arm child 1; future ordinary re-arms are automatic`.

## 4. Enablement (flag ON) — passed, on enablement and after a restart

| Process | Window | lock pid | `.lock` == `.pi-branch-extension-loaded` | `/proc/<pid>/environ` | Watcher |
| --- | --- | --- | --- | --- | --- |
| Enablement launch | `en1` | `2394124` | yes | `FM_PI_DURABLE_DELIVERY=1`, `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400`, `FM_HOME=…` | healthy, pid `2397171` |
| Restart after enablement | `en2` | `2400913` | yes | `FM_PI_DURABLE_DELIVERY=1`, `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400`, `FM_HOME=…` | healthy, pid `2403990` |
| Resume for the unread-note observation | `en5` | `2455116` | yes | `FM_PI_DURABLE_DELIVERY=1` | healthy |
| Restart after the note was acknowledged | `en6` | `2464141` | yes | `FM_PI_DURABLE_DELIVERY=1`, `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400`, `FM_HOME=…` | healthy, pid `2467879` |

Every process also passed the two extension checks against the on-disk sha256 digests in §1.
No check failed at any point, so the run proceeded past each gate.

## 5. Per-sequence observation

Routine rows were produced by the home's own store command, exactly as the durable design intends (`bin/fm-branch-outcome.sh append --task adoption-observe --verdict routine --silent false --summary …`), and never by steering the model.

| Seq | Path | Persisted record | Rendered presentation (pane) | Read cursor |
| --- | --- | --- | --- | --- |
| 1 | normal operation while the owner was live (`en2`, pid `2400913`) | `custom` / `fm-branch-visible-routine`, `seq 1`, `deliveryId 57ad6b86-e2ec-4766-9693-17d435aabfb6`, session timestamp `2026-10-08T06:09:24.344Z` | `⛵ adoption-observe: Durable routine probe one`, exactly once | absent → `1` at `06:09:26Z`, by the turn's reconcile |
| 4 | unread while the owner was **down**, then presented on resume (`en5`, pid `2455116`) | `custom` / `fm-branch-visible-routine`, `seq 4`, `deliveryId 3374794c-51ba-4fe1-b31d-ebb3bb8a135e`, session timestamp `2026-10-08T06:16:49.727Z` | `⛵ adoption-observe: Durable routine probe four`, exactly once | `3` → `4` at `06:16:51Z` |

Normal operation (seq 1): the row was appended while the owner was live and read.
The next turn's reconciliation persisted one durable entry and advanced the cursor `absent → 1`; the JSONL contained exactly one `fm-branch-visible-routine` entry and the pane exactly one `⛵` line.
Cursor attribution is unambiguous: the delivery entry is timestamped `06:09:24.3Z`, the cursor moved at `06:09:26Z`, and no session start occurred between the append and the delivery, so the advance came from the live owner's reconcile rather than from a startup replay.

Restart/resume (seq 4): the row was appended at `06:16:13Z` while the previous owner was stopped, and a fresh primary was started.
At session start the digest printed the row under `BRANCH OUTCOMES (handled by the supervision branch, not yet seen by this session)` **without consuming it** — the cursor stayed at `3` and `unread` still listed seq 4, which is the flag-on contract in `bin/fm-branch-outcome.sh`'s `startup-replay` header: with `FM_PI_DURABLE_DELIVERY` truthy the printed digest is only a tool result, so the cursor advances only through leading silent rows and every non-silent row stays unread for the extension's `reconcileUnreadOutcomes`.
The first turn after resume then produced exactly one durable entry and one `⛵` line, and the cursor moved `3 → 4`.

An acknowledged note is not re-delivered: after seq 4 was read, the primary was restarted (`en6`, pid `2464141`).
The cursor stayed `4`, `unread` was empty, the new session's digest had no `BRANCH OUTCOMES` section, its JSONL contained no `fm-branch-visible-routine` entry, and its pane contained no `⛵` line.
Across the whole run the store held four rows and the session files held exactly two routine entries — one for seq 1 and one for seq 4 — so no row was presented twice.

### Method note (recorded because it changed an intermediate reading)

An operator-invoked `bin/fm-branch-outcome.sh startup-replay` run from a shell **without** `FM_PI_DURABLE_DELIVERY` takes the flag-off path and consumes leading non-silent rows, because the consuming decision is the same environment signal the extension gates on.
One observation row (`seq 3`) was consumed that way during this run before that was understood; the cursor's mtime for that advance (`06:09Z`) confirms it happened at the manual replay, not at any session start.
That is an operator artifact of this run, not a product defect: the home's own session-start replay, running with the flag set, demonstrably printed seq 4 and left it unread for the branch to render.

## 6. Rollback procedure preserved (reconcile before switching back to flag-off)

The flag-off path recognizes no durable record, so a pending durable delivery must be reconciled before the flag is switched off, or flag-off re-presents a still-unread row as a plain note and duplicates it (`32`, "Rollback"; `40`, Stage C).
The procedure is unchanged and is what the verified runs used: keep a live flag-on owner running or bring one back until `reconcileUnreadOutcomes` completes; confirm `bin/fm-branch-outcome.sh unread` prints nothing, the cursor equals the store tail, and no leftover reservation marker exists for an already-read row; only then stop the flag-on primary and relaunch without the flag (`FM_PI_DURABLE_DELIVERY=0`); then confirm no replay by an unchanged record count, an unchanged cursor, and a new routine row taking the ordinary plain-note path.

The home was left **enabled**, and its reconciled steady state was confirmed as the precondition for any later rollback:

```
unread:            (empty)
cursor:            4
store tail seq:    4
delivered markers: (none)
```

Watcher diagnostics remain enabled on the home through `FM_WATCH_EXTENSION_LOG_KEEP_LINES=400` on the live primary; the opt-in `state/.watch-extension.log` records restore attempts and did not appear in this run because no restore was needed, so the durable watcher evidence here is the watcher lock, the fresh beacon, the strict health check, and `state/.watch-cycle-exits.log`.

## 7. What was not exercised

- No `silent=true` routine row and no `captain` row were forced, so the silent-suppression and captain processing-request halves of the delivery path were not re-run here.
- The flag-off relaunch after reconciliation was not performed; only its precondition was confirmed, because the captain's approval is to enable this home.
- No two-owner handover, no crash mid-delivery, and no soak or multi-hour stability run; the observations are bounded single transitions.
- No worker or second mate was spawned in the home, and no backlog item was created, moved or migrated.
- `data/captain.md`, `data/captain-shared.md` and `data/learnings.md` do not exist in this new home, so the primary started from built-in defaults.

## 8. State left behind

The home is live on `en6` (lock pid `2464141`, watcher `2467879`) with durable delivery enabled, one registered project, and an empty backlog; attach with `tmux -L pi-durable-adoption attach -t firstmate`, and stop it with `tmux -L pi-durable-adoption kill-server` before relaunching it with the launch command in §2.

## 9. Outcome

The home was created at the pinned revision, its scope and registry are correct with merge authority off, it is a Pi primary rather than a second mate, readiness passed with the flag off, enablement passed with the flag on both at the enablement launch and after a restart, and per-sequence observation showed a live routine delivery presented once and an unread routine delivery surviving a restart and presented exactly once, with an acknowledged delivery not re-delivered.
Nothing failed that stopped the run.
