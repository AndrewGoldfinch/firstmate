# Adversarial verification: reserve-before-append exactly-once fix (commit 2811e8d8)

Verdict: **HOLD - IMPLEMENTATION**

## Scope and method

- Verified commit: `2811e8d8d021e6dee96e5fe25d61fde115359411` ("fix(pi): reserve routine delivery identity before append"), detached checkout of a disposable worktree; nothing pushed.
- Changed functions live in `.pi/extensions/fm-branch-supervision.ts`: `ensureRoutineOutcome` (`:1325`), `adoptDurableDelivery` (`:1311`), `appendDurableOutcome` (`:1243`), `commitDelivery` (`:1150`), `releaseReservation` (`:1163`), `claimReservationId` (`:1174`), `clearDelivery` (`:1184`), `reclaimReadDeliveryMarkers` (`:1195`), `rollbackDeliveryEntry` (`:1065`), `unpoisonSessionEntry` (`:1037`).
- Extension sha256 `9029f000f0bd09c0eb53ea877ba587ef2a0bf72abae31499259c13cdf154b372`; unmodified probe sha256 `8efd3be336b4dd5bff08841d2866f097d12ff2cd6a28456b54662379d9ffe288`.
- Read the changes and `docs/pi-durable/18-double-destination-exactly-once.md`, re-ran all three requested suites, and added scratch probe scenarios (real SDK, real `SIGKILL`/`SIGSTOP`, real filesystem) that are not in the committed probe. Scratch edits were reverted; only evidence files remain (copied under `data/pi-durable-exactlyonce-verify/`).
- Unix sockets work: `AF_UNIX` bind succeeded (the live e2e also requires it and passed). Node `v22.21.1`, Pi `1.0.0`, linux.

### Requested suites (all green, fixed extension)

| Command | Result |
| --- | --- |
| `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` | exit 0, `F09_PROBE_COMPLETE verdict=PASS` (`e2e-full.log`) |
| `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` | exit 0, `58` ok, `0` failed (`ext.log`) |
| `(cd runtime/pi-durable && npm ci && npm test)` | `NPMCI_EXIT=0`, `# tests 81 / # pass 81 / # fail 0` (`runtime.log`, `npmci.log`) |

## Challenge table

| Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- |
| Q1 Two destinations, different session files, both stall after their write; exactly one durable record? | PASS - exactly one | `double-destination-append` settled: `diskRecords: 1`, `deliveryMarkers: 1`, `unread: 1`; reopen completes `cursor: 1`, `diskRecords: 1` (`e2e-full.log`) | Duplicate closed for this schedule |
| Q2 Crash between committing the reservation and appending the record; is the row still recoverable? | **FAIL - note permanently stranded** | Scratch `reservation-crash-before-append` on the fixed extension: replacement destination `diskRecords: 0, unread: 1, cursor: 0, deliveryMarkers: 1`; original destination identical; explicit retry identical; probe aborts `the original destination must recover the stranded reservation`, `0 !== 1` (`e2e-crash-fixed.log`, `scratch-crash-probe2.json`) | **Blocks advancement** |
| Q3 Losing owner adopts the winner without a competing record and refuses its own append? | PASS for the observed races | Loser holds no record -> `adoptDurableDelivery` returns false, no append: `new-destination-before-ack` / `takeover-at-destination-write` show `diskRecords: 0`, `deliveryMarkers: 1` while the winner is stopped (`e2e-full.log`) | No duplicate from the loser |
| Q4 Can two owners still both deliver or both drop? | Both-deliver: not reproduced. **Both-drop: yes, via the Q2 crash window** | Duplicate schedules all settle at one record; the crash scenario drops the only note (`e2e-crash-fixed.log`) | **Blocks advancement** (loss) |
| Q5 Reservation leak / premature reclaim; legacy empty marker | Reclaim respects unread; legacy empty marker safe but inherits the strand | `reclaimReadDeliveryMarkers` deletes only seqs absent from the unread snapshot (`:1195`, call `:1510`); `leaked-marker-reclaim` -> `deliveryMarkers: 0`; `readCommittedDeliveryId` returns `null` for empty (`:1139`) so rollback is refused and adoption still succeeds | Bounded; no new duplicate/loss beyond Q2 |
| Q6 Un-poison after a rolled-back reconcile, re-reconcile in the rolled-back process | PASS - no phantom | `write-failure` -> `reconcile-after-rollback`: `memoryRecords: 0`, `diskRecords: 0`, `unread: 1`, `deliveryMarkers: 0`; probe asserts exactly that at the new lines (`e2e-full.log`); assertions confirmed in `tests/assets/pi-f09-probe.mjs` | Coverage gap from doc 17 is closed for the in-process path |
| Q7 Default (flag off) path unchanged; frozen Durable Outcome append untouched | PASS | `durableDeliveryEnabled` gates only `:1510`, `:1537`, `:1547`; `deliverRoutineOutcome` extracted byte-identical from `2811e8d8^` (`identical: True`); `git diff --stat 2811e8d8^ 2811e8d8 -- runtime/pi-durable` is empty (`0` lines) | No regression |

## Per-question findings

### Q1 - double-destination exactly-once (tested schedule): holds
`ensureRoutineOutcome` writes the home-wide marker first with `O_EXCL` (`commitDelivery`, `writeFileSync` flag `wx`, `:1150`); only the `O_EXCL` winner reaches `appendDurableOutcome`. The committed probe's `double-destination-append` confirms the loser sees the marker, holds no record, and writes nothing.

### Q2 - crash between reservation and append: permanent loss (new defect)
The reservation is committed at `.pi/extensions/fm-branch-supervision.ts:1334` before `appendDurableOutcome` (`:1336`). If the process dies in that window, the marker survives with no record. On the next run `ensureRoutineOutcome` takes the `deliveryCommitted` branch at `:1327`, calls `adoptDurableDelivery` (`:1311`), finds no durable record in the session, returns `false` at `:1313`, and `reconcileUnreadOutcomes` aborts. The row stays unread forever:

- No path re-appends under an existing reservation.
- `releaseReservation` (`:1163`) is reached only from the in-process failure arm of the same call, never after a crash.
- `reclaimReadDeliveryMarkers` (`:1195`) removes only markers whose seq is absent from the unread set, and this row is unread.

Reproduced with a real `SIGKILL` at the real `fs.appendFileSync` barrier (scratch scenario, `--worker` intercepts the session write; the marker is already on disk):

```
{"scenario":"reservation-crash-before-append","stage":"reservation-crash-recovered", ... 
 "cursor":0,"unread":1,"diskRecords":0,"deliveryMarkers":1}
{"scenario":"reservation-crash-before-append","stage":"reservation-crash-original-destination", ...
 "cursor":0,"unread":1,"diskRecords":0,"deliveryMarkers":1}
{"scenario":"reservation-crash-before-append","stage":"reservation-crash-original-retry", ...
 "cursor":0,"unread":1,"diskRecords":0,"deliveryMarkers":1}
AssertionError: the original destination must recover the stranded reservation
0 !== 1
```

### Q3 - losing owner: correct
A destination that loses the `O_EXCL` race returns `deliveryCommitted ? adoptDurableDelivery : false` (`:1334-1338`). `adoptDurableDelivery` returns `true` only for a flushed record already in its own session file (`:1312-1315`); otherwise it defers and appends nothing. Observed `diskRecords: 0` for the deferred destination while the winner held the marker.

### Q4 - two owners both deliver / both drop
- Both deliver: not reachable through the tested schedules. Only the `O_EXCL` winner reaches the append; all duplicate schedules settle at one record.
- Both drop: reachable through the Q2 crash window (permanent loss), and it is a regression relative to the pre-fix ordering.

Regression proof against the immediate parent `e0f5a471` (pre-fix appends before committing; see `git diff 2811e8d8^ 2811e8d8`), same scratch crash scenario, extension reverted only:

```
{"scenario":"reservation-crash-before-append","stage":"reservation-crash-recovered", ...
 "memoryRecords":1,"renderedCopies":1,"cursor":1,"unread":0,"diskRecords":1,"deliveryMarkers":0}
preCrashMarkers=0
```

Pre-fix recovers and delivers the note (`diskRecords: 1`, `unread: 0`); the fix does not. `e2e-crash-prefix.log`, `scratch-prefix-crash.json`.

### Q5 - ledger leaks, premature reclaim, legacy empty marker
`reclaimReadDeliveryMarkers` removes only markers whose `seq` is not in the unread snapshot taken at reconcile start (`:1195`, `:1510`), so an in-flight reservation is kept and a leaked post-read marker is reclaimed (`leaked-marker-reclaim` -> `deliveryMarkers: 0`). An empty legacy marker reads as `null` identity (`readCommittedDeliveryId`, `:1139`), which only disables the sibling-rollback guard; a session that holds a durable record still adopts, and one that does not defers (same strand as Q2, not a new class). No TOCTOU duplicate found in `releaseReservation`/`claimReservationId`: neither can remove a competing marker, because `commitDelivery` cannot create while the owner's marker exists.

### Q6 - un-poison / re-reconcile after rollback: fixed and asserted
The injected `EACCES` on the real session write rolls the in-memory record out (`unpoisonSessionEntry`, `:1037`) and releases the reservation; the committed probe re-runs reconciliation in the same rolled-back process and asserts `memoryRecords: 0`, `diskRecords: 0`, `unread: 1`, `deliveryMarkers: 0` ("no marker may exist without a durable record"), then restores write permission and proves exactly one record. This closes the doc 17 coverage gap for the in-process path. It does not cover the hard-crash path, which is exactly where Q2 fails.

### Q7 - default path and frozen mechanism
`durableDeliveryEnabled` gates only the three new calls (`:1510`, `:1537`, `:1547`). `deliverRoutineOutcome` is byte-identical between `2811e8d8^` and `2811e8d8` (extracted and compared, `identical: True`). `runtime/pi-durable` and `bin/fm-branch-outcome.sh` are not in the commit diff. All 81 runtime tests pass.

## New issue

**Open-reservation crash permanently drops the note, and the documented mitigation does not exist.**

- Trigger: process death (SIGKILL, OOM, power loss) after `commitDelivery` at `:1334` and before the durable append is flushed.
- Effect: the home-wide marker for an unread sequence survives with no durable record; every later destination (the original one included, even after explicit retries) defers forever.
- `docs/pi-durable/18-double-destination-exactly-once.md:56-58` states: "The same destination recovers it by re-appending under its reservation, while a different destination defers rather than duplicating." The second half is true; the first half is contradicted by `ensureRoutineOutcome:1327` and by the reproduction above. There is no re-append-under-reservation path.
- Severity: this trades a bounded duplicate (pre-fix) for a possible permanent delivery loss (post-fix). The fix's exactly-once property is achieved by stranding rather than by reconciling, so the boundary is now at-most-once in this window, not exactly-once.

Suggested direction (not implemented): on `deliveryCommitted` with no durable record in this session, either re-append under the existing reserved id, or age out / release reservations whose session has no record, or store the reservation with enough identity to distinguish "owner will append" from "owner is gone" (the lease the doc itself names). This is a fix-required HOLD: do not rely on the delivery boundary as exactly-once until this window is closed.

## What remains uncovered

- Free-running multi-process races without `SIGSTOP`/`SIGKILL` injection (only forced interleavings were exercised).
- A crash exactly between the `O_EXCL` marker create and the marker write returning to the caller, and crash-with-record-append-persisted-but-marker-handling variants beyond Q2.
- The strand interaction with legacy empty markers in a mixed pre-fix/post-fix home (reasoned, not reproduced).
- Long-run ledger growth beyond `reclaimReadDeliveryMarkers` coverage.

## Files

- `data/pi-durable-exactlyonce-verify/e2e-full.log` - full F09 probe on the fixed extension (all standard scenarios pass).
- `data/pi-durable-exactlyonce-verify/ext.log`, `runtime.log`, `npmci.log` - extension and runtime suites.
- `data/pi-durable-exactlyonce-verify/e2e-crash-fixed.log`, `scratch-crash-probe2.json` - Q2/Q4 loss on the fixed extension.
- `data/pi-durable-exactlyonce-verify/e2e-crash-prefix.log`, `scratch-prefix-crash.json` - same scenario on the pre-fix extension (recovers), proving regression.
- `data/pi-durable-exactlyonce-verify/scratch-probe-crash-scenario.mjs` - the scratch scenario (reverted from the repo).

HOLD - IMPLEMENTATION
