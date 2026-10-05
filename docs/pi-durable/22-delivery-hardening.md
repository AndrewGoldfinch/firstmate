# Pi Durable delivery hardening

Status: implemented on `experiment/pi-durable-delivery-hardening`.
This hardens the reservation recovery landed in `20-reservation-recovery.md` after `21-reservation-verify.md` found that three of its ADVANCE claims exceeded the evidence.
It closes three defects only: it does not start Phase 1, does not run a soak, and does not mark the real-path milestone complete.
It keeps the proven reserve-before-append recovery, the frozen Durable Outcome append mechanism (`runtime/pi-durable` and `bin/fm-branch-outcome.sh`), and the default (flag-off) presentation path unchanged.
The real-SDK probe keeps its no-model, no-fetch discipline; every interleaving is forced with a real `SIGSTOP` or `SIGKILL`.

## Defect 1: a superseded owner could keep an appended record

The takeover probe asserted only that ownership had changed (`stale.pid !== stale.lockPid`) and that exactly one record survived, not that a superseded owner is forbidden to append or render.
On resume, `appendDurableOutcome` appended after the fence was already lost, and `rollbackDeliveryEntry` kept that record because the still-`reserved` marker named it as the only copy.
So the stale owner did append and render a record after the successor had taken over.

Fix: `appendDurableOutcome` now detects a fence-lost owner whose only claim is its own still-`reserved` marker and forces that record out, then `appendUnderReservation` releases the reservation.
Every other rollback keeps the original conservative rule, because the record may be the only durable copy of a note a replacement already adopted and read.
The probe's `takeover-at-destination-write` now asserts the resumed owner has `memoryRecords: 0`, `diskRecords: 0`, and `deliveryMarkers: 0`, with the row left unread for the lock owner.

Failing first, extension reverted to pre-fix and the new probe kept: `AssertionError: a superseded owner must not append or render a record after takeover` with `1 !== 0`.

## Defect 2: reclaim was a read-compare-write TOCTOU

`reclaimReservation` read the marker, compared its bytes, then separately overwrote it, so a takeover between the compare and the overwrite could clobber a winner.
The probe `reclaim-interleave` seeds a reservation left by a dead owner, stops the first reclaimer between its compare and its publish, lets a successor take the lock and reclaim, then resumes the first reclaimer.
The successor's committed marker must still name the successor, and the home must keep exactly one durable record.

Fix: `reclaimReservation` writes the replacement to a temp file, re-checks `generationOwnsLockSync` after the compare and before publishing, and only then renames the temp over the marker.
A takeover in that window aborts instead of overwriting the winner.

Failing first, extension reverted to pre-fix and the new probe kept: `AssertionError: a resumed reclaimer must not leave two winners` with `2 !== 1`.

## Defect 3: a direct marker write could strand the note

Markers were written with a direct `writeFileSync`, so a crash between creating or truncating the marker and writing its JSON could leave an empty or partial marker.
An empty marker with no durable record behind it was never reclaimed, so the note stranded forever.

Fix: marker writes are atomic.
`createMarkerAtomic` writes a temp and publishes the claim with `linkSync`, which fails if the marker already exists, and `writeMarkerAtomic` writes a temp and publishes with `renameSync`.
`reclaimReadDeliveryMarkers` also removes abandoned non-numeric temp files while the lock is held.
The probe `marker-write-crash` crashes inside the reservation write and asserts a fresh owner still recovers exactly one committed note.

Failing first, extension reverted to pre-fix and the new probe kept: `AssertionError: a marker-write crash must not strand the note` with `0 !== 1`.

## Results

- `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `F09_PROBE_COMPLETE verdict=PASS`.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> exit `0`.
- `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass, `0` fail.
- The existing schedules stay green in the same live probe: `durable-restart`, `fresh-session`, `write-failure`, `double-destination-append`, `takeover-after-append-before-commit`, `reservation-crash-before-record`, `reservation-crash-fresh-destination`, `leaked-marker-reclaim`, and the flag-off `default-restart` are unchanged.

## Residual

- The reclaim CAS is serialized by the home lock plus the re-check; a free-running multi-process race with no lock change remains untested.
- A committed reservation whose record lives only in a different destination still defers there, as docs 18 and 20 state.
- A live-but-replaced owner that never exits still stalls its row until it does (liveness, not loss).
- This change does not promote the real path and does not complete the milestone; that decision stays with firstmate.
