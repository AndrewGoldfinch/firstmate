# Pi-durable reservation recovery - independent adversarial verification

Task: independently and adversarially verify the recoverable `reserved → committed`
delivery reservation landed at commit `381d98284b7e827be101128562e8cd20057dd57e`
(`fix(pi): make the durable delivery reservation recoverable`), doc
`docs/pi-durable/20-reservation-recovery.md`. Deliverable is a report, not a code change.

- Repo/worktree: disposable scratch worktree, detached HEAD `381d98284b7e` (clean default branch at start).
- Files changed by the commit: only `.pi/extensions/fm-branch-supervision.ts` (+188/-32),
  `docs/pi-durable/20-reservation-recovery.md`, `tests/assets/pi-f09-probe.mjs`. No change to the
  frozen append mechanism (`bin/fm-branch-outcome.sh`) or `runtime/pi-durable/`.
- No repository code was modified. All adversarial scenarios live in a scratch copy of the probe
  (`/tmp/adv-probe.mjs`) and scratch runners under `/tmp/f09-adv/`; nothing was committed or pushed.
- Node v22.21.1. Unix sockets: **work** (`net.createServer`/`connect` on a `unix` path succeeded;
  only the probe's own double-`unlink` threw `ENOENT`, harmless).

## Commands run and results

| Command | Result |
|---|---|
| `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` | `exit=0`, `F09_PROBE_COMPLETE verdict=PASS` |
| `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` | `exit=0`, 58 ok, 0 not ok |
| `(cd runtime/pi-durable && npm ci && npm test)` | after `npm ci`: 81 tests, **81 pass, 0 fail** |
| `bin/fm-test-run.sh tests/fm-branch-supervision.test.sh` (frozen-append surface) | `exit=0` |
| Scratch adversarial probe (8 new scenarios, real SDK + SIGSTOP/SIGKILL) | `exit=0`, all pass |
| Pre-fix extension (`381d9828^`) + the new probe | `exit=1`, `AssertionError: the stranded reservation must recover exactly one durable record`, `0 !== 1` |

Note on `npm ci`: the pre-existing `runtime/pi-durable/node_modules` was stale and missing
`@earendil-works/pi-ai`, which made 10 test files fail at import. Reinstalling restored 81/81; the
failures were environmental, not caused by the commit.

## Challenge table

| Challenge | Result | Evidence | Gate impact |
|---|---|---|---|
| 1. Crash after reserve before append | **Pass (recovered, no loss)** | `reservation-crash-before-record` -> `diskRecords:1, unread:0, deliveryMarkers:0`; fresh dest variant same | none |
| 1. Crash after append before `committed` | **Pass (adopted, no duplicate)** | scratch `adv-crash-after-append-recover` -> `disk=1 dest=1 unread=0 cursor=1 markers=0`; pre-marker asserts `status:"reserved"` with the record already durable | none |
| 1. Crash after `committed` before cursor | **Pass** | `durable-restart` `delivery-before-failed-ack` -> `disk=1 markers=1`, reopen -> `disk=1 unread=0 markers=0` | none |
| 1. Crash during reclaim | **Pass (reasoned + bounded)** | reclaim is a read-compare-write under the home lock; a crash leaves a `reserved` marker whose owner is dead, which the next reconcile reclaims; `adv-no-lock-no-reclaim` shows a non-owner cannot reclaim | none (free-running race untested, see below) |
| 2. Stale-owner reclaim/fencing: can a stale owner append? | **No** | `takeover-at-destination-write` / `takeover-after-append-before-commit`: stale owner resumes, `generationOwnsLockSync` fails, `rollbackDeliveryEntry` refuses to delete the only copy (`diskRecords:1` survives) | none |
| 2. Can a live-but-replaced owner be wrongly reclaimed? | **No** | `reservationReclaimable` (`:1421`) requires `!pidAlive(owner)` or exact pid+generation; `takeover-at-destination-write` shows the replacement defers (`disk=0 unread=1 markers=1`) | none (liveness stall while a replaced owner stays alive) |
| 3. Concurrent reclaim: both/neither, or clobbering a winner | **No clobber; one winner** | home lock serializes reclaimers; `reclaimReservation` (`:1225`) refuses unless the exact stored bytes still match (CAS); `adv-two-live-reclaim` settles at one record; `adv-conflict-defer` refuses to reclaim over a conflicting record | none for lock-serialized case; truly simultaneous CAS race untested |
| 4. Reserved-vs-committed reconciliation, recorded vs fresh destination | **Pass** | recorded: `adv-crash-after-append-recover` adopts; fresh: `adv-crash-after-append-fresh-defer` defers (`disk=1 dest=0 unread=1 markers=1`) then the recorded destination adopts and clears | none |
| 5. Cross-destination commit residual (docs 18/20) | **Reproduced as documented strand, no duplicate/loss of a live record** | `new-destination-before-ack` + `adv-committed-record-gone-defer`: a committed marker whose recorded destination record is destroyed -> `disk=0 unread=1 cursor=0 markers=1` forever | documented residual; escalates only if the recorded destination's record is externally destroyed |
| 6. Idempotent reconcile | **Pass** | `adv-idempotent-first/second/restart` all `disk=1 unread=0 markers=0`; `reclaimReadDeliveryMarkers` (`:1250`) keeps markers for unread seqs and removes only read ones | none |
| 7. Legacy bare/empty marker; flag-off path; frozen append | **Pass as designed (strand is the documented legacy behavior)** | `adv-legacy-bare`/`adv-legacy-empty` with no record -> `disk=0 unread=1 markers=1` (never reclaimed); `default-restart` (flag off) unchanged duplicate-on-restart; commit touches no frozen file | none |

## Per-question findings

### Q1 - crash in every window

The reservation is written before the append (`commitDelivery` O_EXCL, `:1179`), the durable record
is verified before `markDeliveryCommitted` (`:1210`), and `ensureRoutineOutcome` (`:1450`)
reconciles the recorded destination before deciding to reclaim.

- **Reserve-before-append (crash, owner dead, no record):** `reservation-crash-before-record`
  recovers `diskRecords:1, unread:0, deliveryMarkers:0`; the fresh-destination variant likewise.
- **Append-before-commit:** my `adv-crash-after-append` SIGKILLs the owner right after the real
  `appendFileSync` (reservation still `reserved`, record durable) and the recorded destination
  adopts: `disk=1 dest=1 unread=0 cursor=1 markers=0`. The `takeover-after-append-before-commit`
  scenario covers the live-but-replaced variant.
- **Committed-before-cursor:** `durable-restart` and `double-destination-append` adopt on reopen.
- **During reclaim:** `reclaimReservation` compares the exact stored bytes before overwriting, so a
  crash mid-reclaim can only leave a `reserved` marker with a dead owner, which the next reconcile
  reclaims; it can never leave a `committed` marker with no record.

### Q2 - stale-owner reclaim correctness and fencing

`reservationReclaimable` (`:1421`) returns true only when `status==="reserved"`, the owner is set,
the generation is non-negative, this session currently owns the home lock
(`generationOwnsLockSync`, `:959`), and the recorded owner is this process+generation or is dead
(`pidAlive`, `:388`). A stale owner therefore cannot reclaim, and even if it appends, the
post-append fence in `appendDurableOutcome` (`:1298`) forces a rollback that is itself guarded:
`rollbackDeliveryEntry` (`:1065`) refuses to delete a record named by the committed marker or a
record with no sibling copy. `takeover-at-destination-write` and
`takeover-after-append-before-commit` confirm the surviving record count stays 1.

A live-but-replaced owner's reservation is never reclaimed because `pidAlive` is true; the
replacement defers instead. That is a liveness choice (a wedged-but-alive replaced owner stalls the
row until it exits), not a loss or duplicate.

### Q3 - concurrent reclaim

Reclaim is gated on owning the home lock, and `reclaimReservation` is a content CAS
(`readFileSync(...).trim() !== serializeReservation(stale)` -> refuse). A reclaimer that loses the
CAS falls back to `deliveryCommitted ? adoptDurableDelivery : false`, so it never clobbers a
winner's marker or record. `adv-two-live-reclaim` (first reclaimer delivers, second live
destination reconciles afterwards) settles at exactly one record. I could not deterministically
force two processes through the read/compare/write window at once (the lock normally admits one),
so the truly simultaneous CAS race is reasoned, not reproduced; the CAS makes a both-win require
byte-identical stale reads, and the lock fence removes it in the realistic model.

### Q4 - reserved vs committed reconciliation

`recordedDelivery` (`:1385`) has three states: `durable` (adopt), `absent` (allow reclaim),
`defer` (owner may still be writing, or a conflicting record exists). On the recorded destination it
uses the in-memory `scanDurableDelivery` (`:1271`) with a `sessionFlushed` guard; on a different
recorded destination it re-reads the file. Reserved-with-record adopts without a second append;
committed-with-record adopts; reserved-without-record reclaims; conflict defers.
`adv-crash-after-append-fresh-defer` and `adv-conflict-defer` confirm the defer paths write nothing.

### Q5 - cross-destination commit residual

A committed reservation whose recorded destination record still exists is adopted there and defers
elsewhere (`new-destination-before-ack`); no duplicate. If the recorded destination's record is
destroyed (external data loss), `recordedDelivery` returns `absent`, but `status==="committed"` is
not reclaimable, so the row defers forever: `adv-committed-record-gone-defer` ->
`disk=0 unread=1 cursor=0 markers=1`. This is the residual docs 18/20 already state ("a committed
reservation whose record lives only in a different destination still defers there"). It is not
reopened as a duplicate and not a regression from this commit.

### Q6 - idempotent reconcile

Re-running reconcile finds either the committed marker or the durable record and never re-appends:
`adv-idempotent-first/second/restart` all report `disk=1 unread=0 markers=0`. Markers are cleared
after `mark-read` (`clearDelivery`, `:1239`) and leaked markers are reclaimed only when their seq is
absent from the current unread snapshot (`reclaimReadDeliveryMarkers`, `:1250`), so an unread row's
reservation is never reclaimed by the leak sweep (`leaked-marker-reclaim` still passes).

### Q7 - legacy markers, flag-off, frozen append

- Legacy bare marker (`legacy-delivery-id`) and empty marker with no record behind them both defer
  forever (`adv-legacy-bare` / `adv-legacy-empty`: `disk=0 unread=1 markers=1`). Never reclaimed, as
  doc 20 states. For the empty marker this is reached via `readReservation -> null` plus the
  O_EXCL collision, not via `parseReservation`; behaviourally identical (never reclaimed).
- Flag-off (`FM_PI_DURABLE_DELIVERY` unset) still uses the plain presentation path:
  `default-restart` reproduces the documented duplicate-on-restart (`diskRecords:2`), unchanged.
- The frozen append mechanism is untouched: the commit changes no file under `bin/` or
  `runtime/pi-durable/`, and `tests/fm-branch-supervision.test.sh` passes.

## New issues

None that reopen loss or duplication beyond the documented residuals.

Two observations worth recording, neither a regression:

1. **Committed-marker strand on external record destruction (S3).** If the recorded destination's
   only record is destroyed, the committed marker blocks redelivery forever. This is doc 18's
   stated cross-destination residual, not introduced here, but it is a permanent-loss mode under
   data destruction rather than a process crash.
2. **Torn/empty marker strand (S5).** A zero-length or torn `state/.branch-outcomes-delivered/<seq>`
   file is treated as an already-committed legacy marker and is never reclaimed, so a note with no
   record behind it can strand. Reachable from an old-format marker or a machine-level torn write,
   not from the new code's own writes (`writeFileSync` of a small JSON payload). Worth a one-line
   doc note; no duplicate risk.

## What remains uncovered

- Free-running, truly simultaneous multi-process reclaim: the read/compare/write in
  `reclaimReservation` is not atomic, and correctness relies on the home lock admitting one
  reclaimer. The probe forces interleavings with real `SIGSTOP`/`SIGKILL` but cannot force two
  byte-identical CAS wins. Same limitation doc 20 records.
- A machine-level torn reservation write (power loss mid-`writeFileSync`) and the mixed
  pre-fix/post-fix legacy-marker home: reasoned above, not reproduced.
- A live-but-replaced owner that never exits stalls its row until it does (liveness, not loss).
- `reclaimReadDeliveryMarkers` deleting a marker for a seq absent from a stale unread snapshot was
  not adversarially forced beyond `leaked-marker-reclaim`.

## Recommendation

The commit closes doc 19's Q2/Q4 crash-before-append loss (confirmed by the pre-fix falsification:
`0 !== 1`, `the stranded reservation must recover exactly one durable record`) without reopening
doc 18's double-destination duplicate (all duplicate schedules still settle at one record). The
reservation, CAS reclaim, pid/generation fencing, recorded-destination reconciliation, and
idempotent reconcile all hold under the crash and takeover schedules I could construct. The
remaining gaps are the documented cross-destination/legacy residuals and the inherently untestable
free-running CAS race, none of which block the fix.

ADVANCE
