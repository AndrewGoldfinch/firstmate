# Scout report: `seq 2` in the enabled home `/home/andy/pi-durable-adoption`

Task: `pi-durable-adoption-seq2` (scout, repo `firstmate-pi-durable`).
Question: store row `seq 2` (`{"summary":"Durable routine probe two","silent":false}`) has an advanced read cursor but no persisted delivery entry. Is this a real silent loss (implementation follow-up) or simply unavailable evidence?

Result headline: **`seq 2` was non-silent, and the read cursor crossed it with no durable/rendered presentation. The only process that can do that is a flag-off `bin/fm-branch-outcome.sh startup-replay` run outside the durable-delivery environment (an operator shell). Reproduced in an isolated lab. Verdict: HOLD - IMPLEMENTATION.**

The live home was read read-only; no file in `/home/andy/pi-durable-adoption` was modified. All analysis worked from a copy under `scratch/seq2/`.
The original artifacts, including the reconciled steady state (`cursor == store tail == 4`, empty delivered dir, empty `unread`) are preserved; the home was not disabled or disturbed.

## 1. What I did

1. Read `docs/pi-durable/43-adoption-home-run.md` (`/home/andy/firstmate/projects/firstmate-pi-durable`) and `docs/pi-durable/44-adoption-verify.md` (`/home/andy/dev/firstmate`) — the prior run report and the prior HOLD - EVIDENCE verification.
2. Copied the raw state to a scratch dir: `state/branch-outcomes.jsonl`, `.branch-outcomes-cursor`, `.branch-outcomes-delivered/`, `.branch-outcomes-tail.jsonl`, `.adoption-observe.branch-outcome-index`, `.branch-outcome-index-ready`, `.branch-eligible-owner`, `.watch-cycle-exits.log`, `.watch-triage.log`, `.watcher-down`, `.last-watcher-beat`, `home-summary.json`, and all 7 `state/pi-sessions/*.jsonl`.
3. Read the pinned code at `15cbe64a309cfcdebcbc988ecff15ba2f0479f5c`: `.pi/extensions/fm-branch-supervision.ts` (reconcile/delivery path) and `bin/fm-branch-outcome.sh` (cursor owners).
4. Reproduced the consuming path in a disposable lab (`scratch/lab`, `scratch/lab2`) using a copy of the home's `bin/` and `FM_STATE_OVERRIDE`, never touching the home's `state/`.

## 2. Findings table

| Question | Finding | Evidence |
| --- | --- | --- |
| 1. Silent or presentable? | **Non-silent (`silent:false`).** It required a visible presentation; it is not an intentionally suppressed row. | `state/branch-outcomes.jsonl:2` = `{"seq":2,"epoch":1791439793,"task":"adoption-observe","wake":"","verdict":"routine","summary":"Durable routine probe two","silent":false,"statusEndpoint":0,"statusIdent":"-"}` (`epoch` = 2026-10-08T06:09:53Z). |
| 2. Who advanced the cursor? | **A flag-off `bin/fm-branch-outcome.sh startup-replay`, run from a shell without `FM_PI_DURABLE_DELIVERY` — i.e. outside any Pi session and outside the durable-delivery environment.** The extension's `mark-read` path cannot have done it (no durable record exists to adopt), and a flag-on session-start replay cannot advance past a non-silent row by design. | Only `mark-read` (extension) and `startup-replay` write the cursor (`bin/fm-branch-outcome.sh:419 advance_cursor`, callers `:647`/`:834`). Extension `reconcileUnreadOutcomes` calls `mark-read` only after `ensureRoutineOutcome` returns true, which requires a durable record/reservation (`...:1778`, `:1560`, `:1476`); no `fm-branch-visible-routine` entry for seq 2 exists in any of the 7 sessions. Under flag-on, `startup-replay` advances only leading **silent** rows (`bin/fm-branch-outcome.sh:821-838`); seq 2 is non-silent, so it stays unread. |
| 2a. Timing proof it was outside a session | **`seq 2` was consumed between its append (`06:09:53Z`) and the next session's start (`06:10:02Z`) — no Pi session was running in that window.** | Session `2026-10-08T06-05-14...jsonl` (owner `en2`) ends `06:09:24Z`; the next session `2026-10-08T06-10-02...jsonl` starts `06:10:02Z`. Its `firstmate-sessionstart-nudge` entry (line 8) contains **no `BRANCH OUTCOMES` section** (0 matches for `BRANCH`, 13684 bytes), so at that session-start `print_unread` returned empty → cursor was already ≥ 2. The next render session's digest (`2026-10-08T06-16-13...jsonl` line 8) lists only `seq 4`. |
| 3. Where did it go? | **Nowhere durable or captured.** The summary reached no session, appears in no captured `BRANCH OUTCOMES` digest, and produced no rendered entry. The only place it can have appeared is the transient stdout of the operator's flag-off replay (not persisted). | `rg 'probe two'` over all 7 `state/pi-sessions/*.jsonl` = 0 matches; `rg 'fm-branch-visible-routine'` = exactly two entries (`seq 1` at `2026-10-08T06-05-14...:14`, `seq 4` at `2026-10-08T06-16-13...:11`); `state/.branch-outcomes-delivered/` is empty; no `⛵` line exists anywhere under the home (`rg '⛵'` hits only source/docs); `state/terminal-outcomes/` is empty; `state/branch-outcomes.jsonl` has 4 rows, `cursor = 4`, `unread` empty. |
| 4. Shutdown effect | **Independent.** The `~06:21:12Z` stop postdates `seq 2`'s consumption (`~06:09:54Z`) and the cursor reaching 4 (`06:16:49Z`); it could not have changed `seq 2`'s disposition. | `.watch-cycle-exits.log` line 6: `started_at=1791440289` (06:18:09Z) `ended_at=1791440472` (06:21:12Z) `exit_code=143 signal=TERM reason=arm-interrupted successor=none`; file mtime `2026-10-07 23:21:12 -0700` = `06:21:12Z`. No session after `06:18:11Z` until the later restart `2026-10-08T14-57-44...jsonl`. |
| Current readiness | The later relaunch (`14:57Z`) is **current readiness only**; it re-showed nothing and re-delivered nothing. | Session `2026-10-08T14-57-44-810Z_...jsonl`: 0 `fm-branch-visible-routine`, 0 `BRANCH OUTCOMES`. `.lock` mtime `14:57:46Z`; `.session-start-complete` `14:57:47Z`. Cursor stayed 4; `unread` empty. |

### What is and is not recoverable

Recoverable:
- The row text and its `silent:false` flag (`branch-outcomes.jsonl:2`).
- The final cursor value `4\n` (`xxd .branch-outcomes-cursor` = `34 0a`, mtime `2026-10-07 23:16:49.756596790 -0700` = `06:16:49.756Z`), and that it equals the store tail.
- The complete list of persisted rendered entries (only `seq 1`, `seq 4`) and the absence of any `seq 2`/`seq 3` entry.
- The session-start digests: `seq 4` only.
- The watcher cycle boundaries, including the `06:21:12Z` stop.

Not recoverable (overwritten/absent):
- The intermediate cursor mtimes for `seq 2`'s advance. `doc 43` claimed `06:09Z`; the current cursor mtime (`06:16:49Z`) is the `seq 4` advance and overwrote it. `doc 43` most likely conflated the `seq 2` advance (`~06:09:5x`, matching a `06:09Z` mtime) with the `seq 3` row it reported.
- The operator's shell stdout/log for the flag-off replay; no shell history exists under the home.
- The live process environment and pane captures (tmux server gone; `.pi-watch-extension-loaded` removed on shutdown by design).

## 3. Reconstruction (evidence-backed)

Store appends (from the `epoch` fields):

| seq | epoch | UTC | persisted rendered entry |
| --- | --- | --- | --- |
| 1 | 1791439552 | 06:05:52Z | yes, `06:09:24.344Z` (session `06-05-14`, line 14) |
| 2 | 1791439793 | 06:09:53Z | **no** |
| 3 | 1791439975 | 06:12:55Z | **no** (report-attributed to the manual flag-off replay) |
| 4 | 1791440173 | 06:16:13Z | yes, `06:16:49.727Z` (session `06-16-13`, line 11) |

Session windows: `05:53:05–05:57:41`, `06:04:17–06:04:45`, `06:05:14–06:09:24` (`seq 1` rendered at the end), `06:10:02–06:10:40` (arm only; digest had no `BRANCH OUTCOMES`), `06:16:13–06:16:51` (digest listed `seq 4` only; `seq 4` rendered), `06:17:36–06:18:11`, then `06:21:12` stop, then `14:57:44–15:02:06` (later restart).

Chain of custody for the `seq 2` cursor advance:

1. At session `06:05:14` start, unread was empty (before `seq 1`). The extension delivered `seq 1` at `06:09:24.344Z` and `mark-read` moved the cursor `0 → 1` (`~06:09:26Z`); no session start lies between.
2. `seq 2` appended `06:09:53Z`; the owner session had already ended (`06:09:24Z`), so no Pi process existed to run the extension.
3. Before the next session start (`06:10:02Z`), the cursor moved past `seq 2`: that session's startup digest was empty of `BRANCH OUTCOMES`, which is only possible if `print_unread` was empty, i.e. the cursor already read `seq 2`.
4. The only non-Pi writer of the cursor is `bin/fm-branch-outcome.sh startup-replay` (append does not touch it; `mark-read` here was only reachable through the extension, which had no process and no record). A `startup-replay` run from an operator shell without `FM_PI_DURABLE_DELIVERY` takes the flag-off branch: it prints the `BRANCH OUTCOMES` digest to that shell and sets the cursor to the last leading non-captain row (`bin/fm-branch-outcome.sh:806-838`). That is the observed outcome.
5. The same happened for `seq 3` (`06:12:55Z`) before `06:16:13Z`; `doc 43` documented exactly one flag-off manual replay consuming a row, which explains `seq 3` but omitted `seq 2`. The cursor read 3 at the `06:16:13Z` session start (its digest listed only `seq 4`), which requires both `seq 2` and `seq 3` to have been consumed in the same flag-off manner — `startup-replay` cannot stop between them (no captain row exists), so it cannot have consumed only one.

## 4. Reproduction in an isolated lab

Lab: a copy of the home's pinned `bin/` under `scratch/`, with `FM_STATE_OVERRIDE` pointing at a throwaway state dir; the real home was never addressed.

Case A — durable home, flag-off `startup-replay` (the `seq 2` path):

```
cd scratch/lab
export FM_HOME="$PWD/home" FM_STATE_OVERRIDE="$PWD/state"
unset FM_PI_DURABLE_DELIVERY
./bin/fm-branch-outcome.sh append --task adoption-observe --verdict routine --silent false --summary "Durable routine probe two"
./bin/fm-branch-outcome.sh startup-replay
cat state/.branch-outcomes-cursor      # -> 1
./bin/fm-branch-outcome.sh unread      # -> (empty)
```

Observed stdout:

```
BRANCH OUTCOMES (handled by the supervision branch, not yet seen by this session):
{"seq":1,...,"summary":"Durable routine probe two","silent":false,...}
```

Result: the leading **non-silent** routine row was consumed (cursor advanced, `unread` empty) and produced **no rendered entry** — exactly the `seq 2` disposition.

Case B — same row, flag-on `startup-replay`:

```
cd scratch/lab2
export FM_HOME="$PWD/home" FM_STATE_OVERRIDE="$PWD/state" FM_PI_DURABLE_DELIVERY=1
./bin/fm-branch-outcome.sh append --task adoption-observe --verdict routine --silent false --summary "Durable routine probe two"
./bin/fm-branch-outcome.sh startup-replay
cat state/.branch-outcomes-cursor      # -> No such file (cursor not advanced)
./bin/fm-branch-outcome.sh unread      # -> the row is still unread
```

Result: flag-on prints the digest but leaves the non-silent row unread for the extension's `reconcileUnreadOutcomes` to render. This is the contract the enabled home was supposed to be under, and the contrast isolates the defect to the flag-off branch.

Reproduction conclusion: **a leading non-silent routine row is consumed without a rendered entry whenever `startup-replay` runs in a durable-delivery home from an environment that lacks `FM_PI_DURABLE_DELIVERY`.** The enablement exists only as a process environment variable; there is no on-disk durable-delivery marker, so any operator shell, stray tool, or session whose environment lost the variable silently bypasses the durable contract. (`bin/fm-branch-outcome.sh:186 durable_delivery_in_use` reads `${FM_PI_DURABLE_DELIVERY:-}`.)

## 5. Recommendation

- Treat `seq 2` as **not delivered**: it was a non-silent routine outcome consumed with no durable record. Do not count it in "successful deliveries" (that count stays 2 of 4: `seq 1`, `seq 4`).
- Fix/harden the environment-only enablement so a durable home cannot be silently consumed by a flag-off `startup-replay`: persist the durable-delivery selection on disk (or have `startup-replay` refuse to consume leading non-silent rows when a durable-delivery marker/store mode is present). That is the implementation follow-up the verdict below calls for.
- Keep the reconcile-before-disable rollback precondition: the home is currently consistent (`cursor == tail == 4`, delivered dir empty, `unread` empty), so it is safe to bring back a flag-on owner or to reconcile before any flag-off launch, but it should not be disabled abruptly.
- `doc 43` should be corrected: two rows (`seq 2`, `seq 3`), not one, were consumed by the flag-off manual replay; its `06:09Z` cursor-mtime attribution actually fits the `seq 2` advance.

## Verdict

**HOLD - IMPLEMENTATION.** `seq 2` was non-silent (`silent:false`) and was consumed (cursor advanced, `unread` emptied) with no persisted/rendered presentation; the consuming path is a flag-off `bin/fm-branch-outcome.sh startup-replay` run outside the durable-delivery environment, and it is reproduced in isolation above. Evidence is not "simply unavailable": the row, its flag, the final read state, all seven session transcripts, and the cursor owners are preserved.
