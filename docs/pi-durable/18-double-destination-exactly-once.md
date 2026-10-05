# Pi Durable double-destination exactly-once fix

Status: fixed on `experiment/pi-durable-double-destination-fix`.
This closes the reproducible duplicate that `17-double-destination-verify.md` recorded.
It keeps the rollback-adoption loss fix on `experiment/pi-durable-delivery-rollback-fix`, and it leaves the frozen Durable Outcome append mechanism (`runtime/pi-durable` and `bin/fm-branch-outcome.sh`) and the default (flag-off) presentation path unchanged.

## Defect

One committed routine note could still be delivered twice home-wide.
Two destinations reconciled the same unread row from different session files and both appended before either committed the home-wide marker.
The stale owner then resumed before the winner committed, so its lost-fence rollback found no marker and no sibling record in its own session file and kept its record.
The winner then committed its own record.
The result was two durable records for one sequence, a read cursor, and no outstanding rollback: a permanent duplicate on disk.

## Fix: reserve the delivery identity before the append

`ensureRoutineOutcome` now pre-allocates a `deliveryId` and creates the home-wide marker `.branch-outcomes-delivered/<seq>` naming it with `O_EXCL` before it writes the session record.
The winner of the marker is the only writer, so a destination that loses the race sees a winner and cannot leave a competing durable record.

- The winner appends its session record carrying the reserved `deliveryId`.
- A loser (`O_EXCL` fails, or the marker already exists) never appends a competing record.
  It adopts the delivery only when its own session already holds the flushed record for the sequence, and it rolls back an orphan sibling of the committed identity.
  Otherwise it defers, leaving the row unread and the marker in place so the owner that holds the record can finish.
- On any in-process failure after reserving but before a durable append, the reservation is released by content identity so the row stays recoverable instead of stranding a marker with nothing behind it.
- When the durable record that survives has a different identity than the reservation (an adopted record), the marker is renamed to the surviving `deliveryId`.

This was chosen over the orphan-reconciliation alternative because a loser cannot see another destination's session file.
In the reproduced schedule the stale owner resumes before the winner commits, so it has no committed winner to reconcile against, and the winner never sees the loser's file.
Reserving first makes the race decidable at the marker, which every destination can see.

## Un-poison re-reconcile coverage

`17-double-destination-verify.md` noted that no test re-ran reconciliation in a rolled-back process, so a surviving in-memory phantom could make the boundary claim a home-wide marker with no durable record behind it.
The probe's `write-failure` scenario now re-runs reconciliation in the same rolled-back process with the session file still unwritable.
It asserts `memoryRecords: 0`, `diskRecords: 0`, `unread: 1`, and `deliveryMarkers: 0`, which fails if a phantom survives and is mistaken for a delivery.

## Regression

- New real-SDK probe scenario `double-destination-append`.
  Destination A stops with a real `SIGSTOP` after its durable append, destination B opens a different session file and reconciles the same unread row, then A resumes.
  It asserts exactly one durable record home-wide, and that reopening the winning destination adopts it and completes the cursor.
  It keeps the probe's no-model, no-fetch discipline: the stop is a real `SIGSTOP` at a real filesystem write.
- `write-failure` gains the re-reconcile-after-rollback assertions.
- The existing adoption-loss case `takeover-after-append-before-commit` and the leaked-marker case `leaked-marker-reclaim` still pass.
- The existing takeover and replacement schedules were updated to the new protocol: a destination that holds no record defers instead of advancing the cursor, and the destination that owns the record completes it on reopen (`new-destination-before-ack`, `takeover-at-destination-write`, and the extension test `test_f09_durable_delivery_identity_replacement_destination_does_not_re_deliver`).

## Evidence

- `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> exit 0, `F09_PROBE_COMPLETE verdict=PASS`, all scenarios including `double-destination-append`, `takeover-after-append-before-commit`, `leaked-marker-reclaim`, and `reconcile-after-rollback`.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> exit 0, `58` ok, `0` failed.
- `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass, `0` fail.
- Falsification: with only the extension reverted to the pre-fix version and the new probe kept, the live probe fails `two destinations must produce exactly one durable record` with `actual: 2, expected: 1`, which proves the regression detects the duplicate.

## Residual

- A hard crash (not an in-process failure) between committing the reservation and the durable append can leave a marker with no record.
  The same destination recovers it by re-appending under its reservation, while a different destination defers rather than duplicating.
  A reservation lease or a marker-to-record cross-check would close this window, and it is not exercised by the tested schedules.
- A destination that does not hold the winner's record defers and does not advance the cursor.
  The cursor completes when the destination that owns the record is reopened.
  This trades cursor liveness for the guarantee that no cursor advances past an unverified delivery.
- Free-running multi-process races remain untested; the probe forces the interleavings with real `SIGSTOP`.
