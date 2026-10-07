# Independent review — attended-fleet pilot run (doc 34)

Reviewer: `pi-durable-attended-pilot-review` (scout). Date: 2026-10-07.
Subject: `docs/pi-durable/34-attended-fleet-pilot-run.md` (commit `d756c073`, docs-classified `cc0ace52`), verdict HOLD on watcher continuity.
Method: conclusions re-derived from the raw artifacts captured before teardown under `/tmp/pilot-evidence/` (`raw-stage12/`, `raw-final/`, `stage*-main-pane*.txt`, `stage2-digest.txt`, watcher logs), not from the report summary. Repository code was not modified.

## Executive summary

The durable-store path is well evidenced: nine distinct rows (seq 1-9), cursor 9, one delivery record per row, correct option-2 adoption of the in-flight seq 7 record, and a negative control that reproduces the duplicate when reconciliation is skipped.

The presentation and watcher-continuity claims are **not** established by the captured raw evidence:

- The run produced **three** watcher-failure alarms, not one; all three are the non-owner refusal, but the opt-in extension log was off and the cycle-exit log shows measurable no-watcher gaps with `successor=none`, so uninterrupted coverage is unproven.
- Only stage-1 deliveries (seq 1, 2, 4, 5) were ever captured on a terminal pane. The only occurrence of seq 6 is inside a `caveman_retrieve` tool result (the session-start digest body), never a rendered entry.
- seq 8 has a persisted renderable entry written to the recorded destination session (`main-session.jsonl:122`), while the fresh session additionally advanced the cursor through a `display:false` session-start nudge (`fresh-session.jsonl:8`) — a dual path the report describes only as a fresh-session deferral.

Verdict: **HOLD - EVIDENCE**. The durable mechanism is not shown defective; the run does not carry evidence sufficient to certify user-visible presentation or uninterrupted watcher continuity.

## Findings table

| Question | Finding | Evidence | Impact |
| --- | --- | --- | --- |
| Q1 durable record correctness | Confirmed: 9 rows, seq 1-9, no gaps, no duplicate seq; cursor 9; processed 4 (only the single `captain` verdict seq 4); one deliveryId per row | `raw-final/branch-outcomes.jsonl` (9 rows), `.branch-outcomes-cursor=9`, `.branch-outcomes-processed=4`; `raw-stage12` shows the seq 1-6 midpoint (cursor 6) | Store path is sound; no loss or duplicate store record |
| Q1 ownership / option-2 adoption | Confirmed for the only in-flight marker: seq 7 `status=committed, owner=3379030, generation=1, destination=main session, deliveryId=66998510-…`; successor adopted with store unchanged 7, cursor 6→7, deliveryId and summary each once | `stage3-inflight.txt`; `stage3-successor.txt` (cursor=7, lock=3399841); `stage3-final.txt` (`seq7_deliveryid_occurrences=1`, `seq7_summary_occurrences=1`) | Option-2 adoption evidenced; no competing record |
| Q1 committing marker dir | The final capture has no `.branch-outcomes-delivered/` directory, so per-sequence marker correctness beyond the seq 7 in-flight snapshot is not independently re-verifiable | `raw-final` listing lacks `.branch-outcomes-delivered`; marker only in `stage3-inflight.txt` | Store+cursor+session entries carry Q1; marker lifecycle rests on the snapshot only |
| Q2 seq 3 | Suppressed, not visible: a `silent:true` custom entry exists (`main-session.jsonl:25`) and no rendered `⛵` line was captured; the seq-3 text in the pane appears only as dumped store JSON | `main-session.jsonl:25` (`silent:true`); `raw-final/main-pane-full.txt:56,150` (JSON rows, not `⛵`) | Confirms suppression; the report's stage-1 "4 routine + 1 outcome = exactly one per sequence" counts this suppressed entry as a visible delivery |
| Q2 seq 6 | Not a user-visible delivery: the summary occurs exactly once in the session as a `caveman_retrieve` tool result containing the session-start digest; no custom entry, no nudge, no pane text | `main-session.jsonl:77` (`"role":"toolResult"`, `toolName=caveman_retrieve`); `BRANCH OUTCOMES` appears only at that line in the session; absent from `raw-final/main-pane-full.txt` | The reported "re-presented exactly once" is a tool artifact, not a rendered delivery |
| Q2 seq 7 | Persisted renderable entry in the destination session; never captured on a pane | `main-session.jsonl:98` (`fm-branch-visible-routine`, `silent:false`, deliveryId 66998510); `stage3-successor.txt`/`stage3-final.txt` show `session_visible_routine=5`; 0 `⛵` in `stage3-successor.txt` | Correct store/adoption, but screen visibility is only inferred from the entry |
| Q2 seq 8 | Dual path: a persisted renderable entry in the destination session **and** a fresh session that advanced the cursor via a `display:false` nudge | `main-session.jsonl:122` (`silent:false`, deliveryId c1996719…); `fresh-session.jsonl:8` (`firstmate-sessionstart-nudge`, `display:false`, contains seq 8); no sealed/visible custom entry in `fresh-session.jsonl`; no pane capture after 00:33 | The report's "no durable visible entry in the fresh session" is true for the fresh session but omits the destination-session entry; whether the cursor advance was a replay or a second read is unresolved |
| Q2 seq 9 | Flag-off lane: one plain `fm-branch-merge` note, `display:true`, no durable entry | `flagoff-session.jsonl:4` (session id `01a113cb`, started `2026-10-07T00:37:27Z`) | Expected rollback behaviour; not part of the durable-flow count |
| Q3 alarm count | **Three** identical `watcher: FAILED - … no longer owns the lock` + `watcher cycle exited 143 without an actionable reason` wakes, not one | `main-session.jsonl:108` (inner ts 1791333065), `:123` (1791333245), `:135` (1791333448); only one (`:222-223`) reached the captured pane `main-pane-full.txt` | The report understates the alarm; rule 3 HOLD applies to each |
| Q3 classification | The alarm is the by-design non-owner refusal during handover, not a crash: the message is emitted only when `lockOwnership() !== "owned"` or a successor arm reports read-only/no-live-session | `.pi/extensions/fm-primary-pi-watch.ts:1007-1023` (and HEAD copy) | Supports "deliberate handover artifact", but only the message is proven; intent is inferred |
| Q3 coverage continuity | **Not uninterrupted**: cycle-exit log shows predecessor ends with `successor=none` and gaps, e.g. 1791333247→1791333325 (78 s) around the handover and 1791331727→1791332066 (339 s) across the stage-2 restart; the final cycle 3450418 ended 1791333466 with `successor=none` and recorded pending downtime | `raw-final/watch-cycle-exits.log` (16 cycles); generation `3437741` ended 1791333448 `successor=none`; `raw-final/watcher-down.txt` = `pending:downtime:3450418.1791333466.hqolO2`; `watch-deliveries.log` has no entry for 3437741 | "Self-healed and no wake was lost" is not proven for the gaps or the tail |
| Q3 diagnostics | The opt-in extension log was not enabled and the beacon was not sampled independently; freshness is only the `beacon_age` column of the cycle-exit log (0-32 s) | `docs/pi-durable/34-…md` (log not enabled); `raw-final/watch-cycle-exits.log` `beacon_age=` values; no beacon file under `/tmp/pilot-evidence` | Evidence gap, not proof of harmlessness |
| Runtime flake | The pane captured repeated `opencode-go API error (503) service_overloaded` during stage 1 | `raw-final/main-pane-full.txt:41-42` | Model-backend noise; noted, not the basis of the HOLD |

## Re-counted user-visible deliveries

Distinguish "persisted renderable entry" from "captured on a terminal pane".

| Seq | Durable rendered entry (session file) | Captured pane | Present to user? |
| --- | --- | --- | --- |
| 1 | `main-session.jsonl:23` | `main-pane-full.txt:43` (and re-render `:137`) | Yes |
| 2 | `main-session.jsonl:24` | `main-pane-full.txt:44` (and re-render `:138`) | Yes |
| 3 | `main-session.jsonl:25` (`silent:true`) | none (only JSON dumps `:56,:150`) | **Suppressed** |
| 4 | `main-session.jsonl:27` (`fm-branch-visible-outcome`) | `main-pane-full.txt:47` (and re-render `:141`) | Yes |
| 5 | `main-session.jsonl:52` | `main-pane-full.txt:211` | Yes |
| 6 | none | none (tool result only, `main-session.jsonl:77`) | **No** |
| 7 | `main-session.jsonl:98` | none captured | Persisted; screen unproven |
| 8 | `main-session.jsonl:122` + fresh nudge `fresh-session.jsonl:8` (`display:false`) | none captured | Persisted; screen unproven |
| 9 | none (flag-off plain note `flagoff-session.jsonl:4`) | none captured | Flag-off path |

Counts:

- Durable persisted entries: **6** (seq 1, 2, 4, 5, 7, 8); seq 3 suppressed.
- Captured as rendered on a pane: **4** (seq 1, 2, 4, 5), each re-rendered once after the restart.
- Not a rendered delivery in any sense: seq 3 (suppressed), seq 6 (tool result), seq 9 (flag-off plain note).

The report's "5 full-flow rows" (seq 1, 2, 4, 5, 7) is wrong in both directions: it includes suppressed seq 3 in the stage-1 arithmetic, and it omits the seq 8 destination-session entry. The honest stage-1 rendered count is 4, and the honest durable-entry count through stage 3 is 6.

## Watcher verdict

- The failure text is the extension's deliberate non-owner refusal (`fm-primary-pi-watch.ts:1007-1023`): it fires when the session no longer owns the lock, which is exactly the pilot's handover condition. The `143` is `SIGTERM` outside the arm's actionable close.
- Therefore this is best read as a **non-owner refusal during the deliberate handover**, not an unplanned outage — but it recurred three times, and the cycle-exit log shows real no-watcher windows (`successor=none`) around each refusal and across the stage-2 restart, ending with a pending-downtime record.
- Successor coverage resumed after the first two refusals and the stages continued: seq 7 (00:30:24), the first alarm (00:31:05), seq 8 (00:33:45), and stage 4 / seq 9 (flagoff session started 00:37:27) all ran after the first alarm. So the fleet kept operating, but **uninterrupted** coverage is not demonstrated.
- Because the extension log was off and the beacon was not sampled independently, the internal retry/refusal sequence cannot be reconstructed. That is an evidence gap.

## What this run establishes vs what remains unproven

Establishes:

- Durable store correctness for seq 1-9: one row per sequence, correct cursor progression, one deliveryId per row, correct option-2 adoption of the seq 7 in-flight record, and a negative control proving reconciliation is load-bearing (`stage4-negative.txt`: `duplicateObserved=true`, `durableEntries=1`, `plainEntries=1`).
- Stages continued after the first failure alarm.
- The watcher failure is the extension's designed non-owner refusal, not a crash.

Unproven:

- Whether the non-owner refusal is the *whole* story, and whether any wake was deferred or lost during the coverage gaps — needs the opt-in extension log.
- Uninterrupted watcher coverage across the handover and the stage-2 restart.
- Real user-visible presentation of seq 6, 7, 8: seq 6 is a tool artifact; seq 7 and 8 are persisted entries with no captured pane; seq 8 also has a `display:false` fresh-session replay that advanced the cursor.
- Which writer advanced the cursor at seq 8 (durable delivery vs startup replay) — the in-flight window the design targets.

## Recommendation

The HOLD is warranted, but it should be stated as **HOLD - EVIDENCE**, not a clean confirmation of the original watcher narrative. A rerun must, before running:

1. **Preserve the in-flight handover overlap** (the committed-marker / unadvanced-cursor window) so the seq 8-class dual path is exercised with instrumentation on.
2. **Enable watcher diagnostics** (`FM_WATCH_EXTENSION_LOG_KEEP_LINES`) and capture an independent beacon timeline plus the `.branch-outcomes-delivered/` directory, so refusals, retries, and markers are reconstructable.
3. **Define the expected non-owner-refusal classification before running** — the exact condition, the expected wake count, and the acceptable no-watcher gap — so a refusal can be accepted or rejected against a stated criterion instead of inferred after the fact.

Do not mark the trial clean on the current evidence.

HOLD - EVIDENCE
