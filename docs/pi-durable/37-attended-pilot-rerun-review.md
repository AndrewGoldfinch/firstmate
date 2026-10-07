# Independent verification — attended-fleet pilot rerun (docs/pi-durable/36)

Reviewer: `pi-durable-attended-pilot-rerun-review` (scout). Date: 2026-10-07.
Subject: `docs/pi-durable/36-attended-pilot-rerun.md` (commit `7e809834`, merged `79c82618`), verdict reported as **FAIL — restart / startup-replay gate**.
Method: re-derived from the raw artifacts captured before teardown under `/tmp/rerun-evidence/` and the lab still standing at `/tmp/fmlab.uesXll`, plus the code that actually ran at the pinned pilot revision `77c2bb0989454f5265d9d9a688716609f9920822`. Not from the report summary. Repository code was not modified.

The pilot ran the durable-delivery feature line, which is **not** on this review worktree's default branch (`docs/pi-durable/` and `FM_PI_DURABLE_DELIVERY` are absent at HEAD `1f3e7696`). All code citations below are therefore taken from the pinned revision:
- `.pi/extensions/fm-branch-supervision.ts` sha256 `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09` (matches doc 36 §1)
- `.pi/extensions/fm-primary-pi-watch.ts` sha256 `2a598446fc876c53b9ffe84cf761a5d0c510b31254532c734fd8eec71c3425e6` (matches)
- `bin/fm-branch-outcome.sh` startup-replay logic is byte-identical between HEAD and the pinned revision (the HEAD↔pinned diff touches only the unused `--operation-key` argument).

## Verdict summary

The rerun's central findings are **confirmed from the raw evidence**: seq 4 was a non-silent routine row that startup replay marked read with no qualifying user-visible presentation, and the cursor advance is attributable to `bin/fm-session-start.sh` → `fm-branch-outcome.sh startup-replay`. Normal operation produced no watcher failure alarm; the restart produced a measured coverage gap, not a refusal; recovery of the queued downtime wake was clean. The helper change is default-off. Stop discipline held.

The report is **not materially overclaiming**. Two wording imprecisions and one measurement caveat are noted below.

**The durable presentation path is not defective in isolation.** The defect is the interaction: `startup-replay` advances the same durable read cursor that the extension's durable present path owns, for leading non-silent routine rows, without producing the rendered entry the cursor is documented to track. That preempts the only path that would have presented seq 4.

## Findings table

| Question | Finding | Evidence | Impact |
| --- | --- | --- | --- |
| Q1 presentation — seq 1-2 | Confirmed: two rendered `fm-branch-visible-routine` custom entries **and** two captured `⛵` pane lines | session lines 14-15 (`seq:1` task `…worker`, `seq:2` task `…mate`, `silent:false`, deliveryIds `1b61d27c…`, `83c6c4f1…`); `pane-stage0.txt:29,30` `⛵ lab86d57c52f68c-worker…` / `⛵ lab86d57c52f68c-mate…` | Durable visible delivery works when it runs |
| Q1 presentation — seq 3 | Confirmed silent/suppressed: stored row is `silent:true`, a custom entry exists, but the routine renderer returns `undefined` and no `⛵` text appears | session line 16 (`seq:3`, `silent:true`, deliveryId `3736e235…`); renderer `.pi/extensions/fm-branch-supervision.ts:3059-3066` (`if (… record.silent) return undefined;`); `pane-stage0.txt` has no seq-3 summary and only 2 `⛵` lines | Silent rows correctly suppressed; not a delivery miss |
| Q1 presentation — seq 4 | Confirmed: **no** custom entry for seq 4; the row text appears only inside tool results, which the frozen criterion excludes | `grep -c fm-branch-visible` session = 3 (seq 1-3 only); `grep -o '"seq":[0-9]+'` session = 14/15/16 only; seq-4 text at session line 23 (`toolResult`, toolName `caveman_retrieve`) and inside the compressed `bash` tool result at line 21 (recovery handle, source `bin/fm-session-start.sh`); `pane-restart.txt:8` shows it only inside collapsed tool output; `pane-*.txt` `⛵` counts: stage0=2, all others=0 | **No qualifying user-visible delivery for seq 4** — gate failure is real |
| Q1 wording | Minor imprecision: seq 4 also occurs inside the line-21 `bash` tool result (compressed) and the collapsed `pane-restart.txt:8` output, not *only* line 23 | session line 21 is a `caveman_retrieve`/`bin/fm-session-start.sh` recovery handle; `pane-restart.txt:7-8` is a collapsed tool block | Conclusion unchanged: both occurrences are tool results, neither qualifies |
| Q2 cursor attribution | Confirmed: the cursor was advanced 3→4 by `startup-replay`, and the extension's durable present only ran after the cursor had already moved | `bin/fm-session-start.sh:789` runs `fm-branch-outcome.sh startup-replay`; `bin/fm-branch-outcome.sh:752-772` prints `BRANCH OUTCOMES`, computes `LAST`, and calls `advance_cursor "$LAST"`; `.branch-outcomes-cursor` content `4` with mtime `12:48:12.016`, while `.pi-branch-extension-loaded` (written by `markLoaded()` inside `actingAsOwner`) has mtime `12:48:13.516` | Startup replay won by ~1.5 s; the durable present found nothing unread |
| Q2 "always wins?" | **Not supported as an absolute.** It is a race, not a certainty. Startup replay wins for any leading non-silent routine row whenever it runs before the extension activates; it does **not** win for a leading captain row (barrier: `. [0:($captain // length)]` at `bin/fm-branch-outcome.sh:757-761` yields an empty replay set and no advance), and it would not win if the extension's `reconcileUnreadOutcomes` ran first | `bin/fm-branch-outcome.sh:752-772`; barrier test `tests/fm-branch-supervision.test.sh:320-334`; extension session-start handler `fm-branch-supervision.ts:2442-2467` calls `reconcileUnreadOutcomes(startedGeneration)` behind `actingAsOwner(startedGeneration)` | The report correctly labels this as the remaining unproven item rather than asserting it; the mechanism is an ordering race plus a by-design routine-row consume |
| Q3 watcher — normal operation | Confirmed: no `watcher: FAILED` and no non-owner refusal | `grep -ci 'FAILED\|cannot restore\|refus'` over `.watch-extension.log`, `.watch-cycle-exits.log`, `.watch-deliveries.log` = 0; `.watch-extension.log` contains only 4 restore/confirm lines; session contains 0 `watcher: FAILED` | Normal-operation continuity holds for the pre-restart window |
| Q3 watcher — restart | Confirmed: a measured **coverage gap**, not a refusal | last `.watch-cycle-exits.log` record `arm_pid=342446 watcher_pid=342462 … exit_code=143 signal=TERM reason=arm-interrupted … successor=none`, `ended_at=1791402196` = `19:43:16Z`; max sampler `beat_age=323` at `19:48:28Z`; re-arm after the first resumed turn, gap ≈ 315 s | The gap is the resumed session sitting idle, not a failure alarm |
| Q3 wake recovery | Confirmed clean | `.watcher-down` = `acked:handling:342462.1791402196.X2Ahdz`; `pane-restart.txt:13` prints `WAKE_ACK_REQUIRED: … bin/fm-wake-drain.sh --ack-through 0 --recovery-generation 342462.1791402196.X2Ahdz`; `pane-restart.txt:16-17` shows that exact ack command running with `(no output)` | No wake lost across the gap |
| Q3 measurement gap | The paper "planned restart downtime 19:43:16 → 19:43:34 (≈18 s)" is only partly corroborated: the resume is visible as `model_change` at `19:43:34.838Z` (session line 17), but the resumed session did not take its first turn until `19:48:07.734Z` (user message + session-start nudge, lines 18-19) and only acquired the branch lock at `19:48:10.266` | session lines 17-21 timestamps; `.lock` mtime `12:48:10.266` | The ~4.5 min idle between resume and first turn is measured, not instrumented; cause recorded as "harness did not start a turn", consistent but not independently proven |
| Q4 helper change | Confirmed default-off, no change to the default launch environment | `bin/fm-live-lab.sh:13-14` documents the env passthrough; `bin/fm-live-lab.sh:567-568` `[ -z "${FM_WATCH_EXTENSION_LOG_KEEP_LINES:-}" ] \|\| primary_env+=(…)`; parent revision has 0 occurrences; only the durable-delivery flag is unconditional (`[ "$durable_delivery" != yes ] \|\| primary_env=(FM_PI_DURABLE_DELIVERY=1)`) | Default lab launch is byte-unchanged; diagnostics are opt-in |
| Q5 stop discipline | Confirmed | doc 36 has an explicit `**Not exercised.**` section (handover/overlap/rollback) and a `## 8. Diagnostic material (outside the scored trial)` section stating the post-stop material "was collected afterward as diagnostic only and is not scored" | Scored trial stopped at the first gate failure; later material is correctly labelled |
| Report overclaim? | No material overclaim. Minor issues only: (a) "display:true" is loose — durable routine entries carry no literal `display` field; visibility comes from the registered entry renderer + captured `⛵`; (b) "seq 4 … only inside a caveman_retrieve tool result" omits the line-21 compressed bash tool result; (c) the 18 s downtime figure understates the idle window (see Q3 measurement gap) | Findings above | Conclusions stand; see "Is the report overclaiming" |

## Detailed findings

### 1. Presentation per sequence

Raw store `/tmp/rerun-evidence/branch-outcomes.jsonl` (4 rows, `seq 1..4`):

- seq 1 `…worker routine silent:false`
- seq 2 `…mate routine silent:false`
- seq 3 `…worker routine silent:true`
- seq 4 `…worker routine silent:false`, summary `RERUN restart probe: startup-replay visibility check; non-silent row appended with no owner running.` (epoch `1791402207` = `19:43:27Z`)

Session `/tmp/rerun-evidence/2026-10-07T19-39-24-844Z_01a117e0-…jsonl`:
- line 14, 15, 16: `"type":"custom","customType":"fm-branch-visible-routine"` for `seq` 1, 2, 3. No line for `seq` 4.
- line 21: `toolResult` from `bash`, whose content is a Caveman recovery handle whose source is `bin/fm-session-start.sh` (i.e. the startup digest was itself compressed to a tool artifact).
- line 23: `toolResult` from `caveman_retrieve`, the only literal occurrence of the seq-4 row, starting `SESSION START - /tmp/fmlab.uesXll/home`.

Panes: `pane-stage0.txt:29-30` carry the two `⛵` lines for seq 1/2; the other three panes carry zero `⛵` lines. The seq-4 summary in `pane-restart.txt:8` sits inside a collapsed tool block (`pane-restart.txt:10` `... (135 more lines, ctrl+o to expand)`).

Frozen criterion (doc 36 §2): "Hidden nudges (`display:false`) and tool results do not count as visible delivery." Under that rule seq 4 has no qualifying delivery. Confirmed.

### 2. Cursor attribution

`bin/fm-session-start.sh:789` invokes `fm-branch-outcome.sh startup-replay`; its implementation (`bin/fm-branch-outcome.sh:752-772`) reads unread rows, filters to rows before the first `captain` verdict, prints non-silent ones under `BRANCH OUTCOMES`, then unconditionally `advance_cursor "$LAST"`. The cursor sidecar therefore moved to `4` from a printed digest (a tool result), not from a durable entry.

Timing (from the live lab, not the copy timestamps):
- `.lock` mtime `12:48:10.266` (resumed pid `358228`)
- `.branch-outcomes-cursor` mtime `12:48:12.016` (value `4`)
- `.pi-branch-extension-loaded` mtime `12:48:13.516` (value `358228`)

`.pi-branch-extension-loaded` is written by `markLoaded()` (`fm-branch-supervision.ts:964-968`), which is called only inside `actingAsOwner` after owner activation (`fm-branch-supervision.ts:989-1005`). The `session_start` handler that performs the durable present (`fm-branch-supervision.ts:2442-2467`) is gated on `actingAsOwner`, so it could not have completed before `12:48:13.5` — i.e. not before the cursor was consumed at `12:48:12.0`.

The "always wins" claim as an absolute is **not** supported. It is an ordering race: the first turn's `fm-session-start.sh` beat the extension's activation in this run. The durable path would present first if it ran before startup replay, and startup replay does not touch a leading captain row (barrier behavior proven by `tests/fm-branch-supervision.test.sh:320-334`). Startup replay does by design consume leading **routine** rows (`bin/fm-branch-outcome.sh:123-132` header: "…skip rows whose `silent` field is true, and mark those leading routine rows read"), and the unit test asserts exactly that for a visible routine row (`tests/fm-branch-supervision.test.sh:290-296`: `[ -z "$(… unread)" ]` after replay).

Note the durable path still runs at `turn_end` with `present=false` (`fm-branch-supervision.ts:2414`), but `present` only skips the final `presentUnprocessedOutcomes` call (`:1785`); the routine present + `mark-read` loop (`:1769-1783`) runs regardless. So the extension would have presented seq 4 at session start or turn end had the cursor not already moved.

### 3. Watcher continuity

- No failure alarm: zero `watcher: FAILED` / `cannot restore continuity` / `refus` matches in `.watch-extension.log` (4 lines, all `restore`/`confirm`), `.watch-cycle-exits.log` (3 lines), `.watch-deliveries.log` (2 lines), or the session.
- Restart is a gap, not a refusal: `.watch-cycle-exits.log` last record ends `exit_code=143 signal=TERM reason=arm-interrupted … successor=none` at `ended_at=1791402196` (`19:43:16Z`). The sampler's max `beat_age` is `323` at `19:48:28Z`; the watcher is re-armed only from the resumed turn, giving a gap of ≈315 s (`19:43:16Z` → `19:48:31Z`).
- Recovery clean: `.watcher-down` = `acked:handling:342462.1791402196.X2Ahdz`; the resumed turn ran `bin/fm-wake-drain.sh --ack-through 0 --recovery-generation 342462.1791402196.X2Ahdz` (`pane-restart.txt:13,16-17`), i.e. no queued wakes remained.
- Two `TURN WOULD END BLIND` warnings (session lines 10 and 29) match the report's count, each followed by a successful `fm_watch_arm_pi`.
- Measurement gap: the report's "planned restart downtime 19:43:16 → 19:43:34 (≈18 s)" is not directly captured in the raw evidence. The resume is only visible as the `model_change` at `19:43:34.838Z`; the first turn did not begin until `19:48:07.734Z`. So the primary was effectively idle ~4.5 min before the lock was taken. The report states the ≈315 s watcher gap separately, so the 18 s figure does not change the conclusion.

### 4. Helper change

`bin/fm-live-lab.sh:567-568` appends `FM_WATCH_EXTENSION_LOG_KEEP_LINES` to `primary_env` only when the variable is already exported; the parent revision has zero occurrences. Documentation is at `:13-14`. The default launch environment is unchanged.

### 5. Stop discipline

doc 36 carries a `**Not exercised.**` section for the handover/overlap/rollback stages and a `## 8. Diagnostic material (outside the scored trial)` section: "The following was collected afterward as diagnostic only and is not scored". The scored trial ended at the restart/startup-replay gate. Confirmed.

## Is the report overclaiming?

No material overclaim. The four claims the task asked to check all survive raw re-derivation. Three minor corrections:

1. "rendered `display:true` entry" — the durable routine entry (`fm-branch-visible-routine`) has no literal `display` field; its visibility comes from `pi.registerEntryRenderer?.(VISIBLE_ROUTINE_ENTRY_TYPE, …)` (`fm-branch-supervision.ts:3059-3066`) plus the captured `⛵` pane line. The claim is true; the name is loose.
2. "seq 4 … occurs only inside a `caveman_retrieve` tool result (session line 23)" — it also occurs inside the `bash` result at line 21 (as a compression recovery handle) and in the collapsed `pane-restart.txt:8` tool block. All three are tool results, so the delivery conclusion is unchanged.
3. The "~18 s planned restart downtime" understates the observed idle window (~4.5 min resume→first turn). The report's separately stated ~315 s watcher gap is the correct measured outage; the discrepancy is a labelling gap, not a wrong conclusion.

## Diagnosis

- **Gate failure correctly diagnosed? Yes.** seq 4 was non-silent and was marked read by `startup-replay` with no qualifying visible presentation.
- **Is the durable presentation path itself defective? No — not in isolation.** It produced rendered entries for seq 1-2 and correctly suppressed seq 3. The sequence that matters failed because the durable path never got to read the row.
- **Is the defect the interaction with `startup-replay`? Yes.** There is a contract conflict. `bin/fm-branch-outcome.sh:20-23` documents the cursor as "the highest seq presented by Pi as a routine merge note or sequence-keyed visible captain entry", but `startup-replay` advances it for leading routine rows on the strength of the printed digest alone. Under durable delivery, the printed digest is a tool result and does not constitute the rendered entry. Two writers own one cursor with different notions of "presented".

## What a fix must address

Because the task is a scout report, no code was changed. The fix options, in order of architectural fit:

1. **Make `startup-replay` durable-delivery-aware (preferred).** When the durable path is in use, `startup-replay` must not `advance_cursor` past leading non-silent routine rows; it may still print them for the digest, but leaves them unread for `reconcileUnreadOutcomes` to render and mark read. Silent rows stay consumed here. This preserves the fallback digest for non-Pi/no-extension sessions while restoring the cursor's documented meaning.
2. **Only run `startup-replay` when no branch-extension owner is active.** `bin/fm-session-start.sh` could skip the replay (or defer it) when the Pi branch extension holds the lock, letting `reconcileUnreadOutcomes` present first. Weaker: it depends on load ordering, which is exactly the race that lost here.
3. **Have `startup-replay` create the durable entry itself.** Rejected as a first move: the shell script has no Pi session API; duplicating the append/persist logic would create a second writer of session entries.

A regression test belongs in `tests/fm-branch-supervision.test.sh` alongside the existing startup-replay tests: append a leading non-silent routine row with durable delivery on, run `startup-replay`, and assert the row is still `unread` (or has a rendered entry) instead of silently consumed. The current test at line 290 asserts the opposite behavior for the non-durable path, so the two modes need to be distinguished explicitly.

Whether the frozen criterion (doc 36 §2) or the startup-replay contract is the authoritative definition of "presented" is a product call that belongs with whoever owns the durable-delivery goal; either way the two paths must stop sharing the cursor advance.

HOLD - IMPLEMENTATION
