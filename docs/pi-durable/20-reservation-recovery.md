# Pi Durable reservation recovery

Status: implemented on `experiment/pi-durable-reservation-recovery`.
This closes the crash-before-append loss that `19-exactlyonce-verify.md` recorded (its Q2/Q4 failure).
It supersedes the plain reserve-before-append protocol while keeping the already-proven append idempotency and the home-wide marker that closes the `18-double-destination-exactly-once.md` duplicate.
It leaves the frozen Durable Outcome append mechanism (`runtime/pi-durable` and `bin/fm-branch-outcome.sh`) and the default (flag-off) presentation path unchanged.

## Design

The home-wide marker at `state/.branch-outcomes-delivered/<seq>` is now a version-2 JSON reservation with `status`, `owner`, `generation`, `destination`, and `deliveryId`.
A legacy bare-deliveryId marker (or an empty marker) reads as an already-committed delivery and is never reclaimed.

- `reserved` is written by `commitDelivery` with `O_EXCL` before the session append; it records the owner pid, the in-process session generation, the destination session file, and the reserved delivery id.
- `committed` is written by `markDeliveryCommitted` only after a durable session record has been verified; it names the exact `deliveryId` that survived and keeps the destination.
- `ensureRoutineOutcome` reconciles the recorded destination first through `recordedDelivery`: a durable record there is a committed delivery even when the marker was never rewritten.
- When no record exists and the owner is stale, `reclaimReservation` replaces the exact stale reservation under the new generation and the append retries; the content comparison means a concurrent winner is never clobbered.
- `reservationReclaimable` only reclaims under the current generation/lock and only when the recorded owner process is gone, so a live-but-replaced owner keeps the existing defer behavior and its own append still fails the `generationOwnsLockSync` fence.

Reconciliation is idempotent: re-running finds the committed marker or the durable record and never re-appends, and a reservation with no record is always reclaimable rather than treated as delivered forever.

## TDD failure and results

The probe gains `reservation-crash-before-record` and `reservation-crash-fresh-destination`: a real `SIGKILL` lands in the window between committing the reservation and appending the session record, then recovery runs on the recorded destination and on a fresh destination.

- Failing first, extension reverted to pre-fix and the new probe kept: `AssertionError: the stranded reservation must recover exactly one durable record` with `0 !== 1` (the lost note), matching doc 19's Q2.
- Fixed: `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `F09_PROBE_COMPLETE verdict=PASS`, both crash scenarios recover `diskRecords: 1`, `unread: 0`, `deliveryMarkers: 0`.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> `58` ok, `0` failed.
- `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass, `0` fail.

The regression schedules stay green in the same live probe: `double-destination-append` still settles at exactly one durable record, `takeover-at-destination-write` still refuses the stale owner's append, `durable-restart` still delivers exactly once after a failed cursor write, `leaked-marker-reclaim` stays bounded and respects unread, and the flag-off path and frozen append mechanism are untouched.

## Residual

- A committed reservation whose record lives only in a different destination still defers there, exactly as doc 18 states; this change closes the no-record crash, not cross-destination commit recovery.
- Free-running multi-process races remain untested; the probe forces the interleavings with real `SIGKILL`/`SIGSTOP`.
