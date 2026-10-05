# Delivery-boundary rollback fix: adoption-safe rollback and marker lifecycle

Status: fixed on `experiment/pi-durable-delivery-rollback-fix`.
This closes the defects the independent adversarial verification recorded against commit `fd1dbb83` in `15-delivery-fixes-verification.md`.
It keeps the two earlier delivery fixes and the flush-durable guard, and it leaves the frozen Durable Outcome append mechanism and the default (flag-off) presentation path unchanged.

## Defect

The home-wide marker recorded that a delivery had happened but not which record was canonical.
A stale owner appended its routine record, a replacement session adopted that record by store sequence (`deliveryId: null`), committed the marker, and completed the cursor.
The stale owner's lost-fence rollback then deleted the same record by `deliveryId`, leaving zero on-disk deliveries, a read cursor, and a cleared marker: a permanent loss of the only committed note.
Three smaller defects shared the path: the rollback removed only the session file line and left a phantom in Pi's in-memory model, the marker was cleared only after a successful `mark-read` so a crash between them leaked it, and `deliveryCommitted` trusted the marker without any guarantee that a committed record survived.

## Fix

- **Adoption-safe rollback.**
  `rollbackDeliveryEntry` removes this owner's record only when a durable delivery for the same store sequence survives without it.
  The marker records the winning `deliveryId`, so a stale owner whose own record won the claim leaves it in place even after a replacement adopted the record and cleared the marker; otherwise a different durable record for the same sequence in the session file is the proof that a sibling exists.
  An adopted record has no sibling copy, so it is never deleted.
- **Identity-bound marker.**
  `commitDelivery(seq, deliveryId)` writes the winning `deliveryId` into the marker, and `appendDurableOutcome` returns a matched record's `deliveryId` instead of `null`, so the rollback guard and an adopter share the identity.
  `deliveryCommitted` is sound now because no rollback removes a record the marker has committed.
- **Un-poison on rollback.**
  A successful rollback also calls `unpoisonSessionEntry`, so the stale owner keeps no phantom or rendered in-memory copy.
- **Bounded marker lifecycle.**
  `reclaimReadDeliveryMarkers` runs on every reconciliation and removes any marker whose row is no longer in the unread set, so a crash between `mark-read` and the marker removal cannot leak it indefinitely.

## Regression

The real-SDK probe (`tests/assets/pi-f09-probe.mjs`) gains `takeover-after-append-before-commit`, which stops the stale owner inside `fs.appendFileSync` immediately after the durable append, launches a replacement that opens the same session file and adopts the record, then resumes the stale owner and asserts the note still exists on disk with one delivery and no loss.
It preserves the probe's no-model, no-fetch discipline: the stop is a real `SIGSTOP` at a real filesystem write.
The same probe gains `leaked-marker-reclaim`, which seeds a marker for an already-read row and asserts that the next reconciliation reclaims it.

## Evidence

- `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 FM_PI_F09_OUTPUT=/tmp/pi-f09-rollback.json bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `exit=0`, `verdict=PASS`, all scenarios including the new adoption and reclaim cases.
- With only the extension reverted to `7032f6e7` and the new probe case kept, the same command fails at the adoption assertion with `actual: 0, expected: 1`, which proves the regression detects the loss.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> `exit=0`, `58` `ok`, `0` failed.
- `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass, `0` fail.

## Residual

- A genuinely concurrent append during the rollback window is still not reconciled atomically; the marker and the sibling scan keep the count correct for the tested schedules, but a free-running multi-process schedule is untested.
- The marker names one `deliveryId`; a legacy empty marker from before this fix is treated as an unknown owner, so a stale owner refuses the rollback rather than risking a loss.
