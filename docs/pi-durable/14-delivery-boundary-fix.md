# Delivery-boundary fix: home-wide identity and durable persistence

Status: fixed on `experiment/pi-durable-delivery-fixes`; the real-SDK probe now reports `PASS`.
This supersedes the `HOLD - IMPLEMENTATION` in [the real-SDK delivery probe](13-real-sdk-delivery-probe.md) for the two delivery-boundary defects only.
The frozen Durable Outcome append mechanism and the default (flag-off) presentation path are unchanged.

## Defects

- A replacement destination session received a second delivery of the same home-wide logical note because the delivery identity was per-session.
- A paused or superseded owner appended and rendered after a successor took over.
- `ensureRoutineOutcome` and `ensureVisibleCaptainOutcome` proved persistence through `getEntries()`, Pi's in-memory `fileEntries`, which Pi fills before `_persist` can throw or silently skip; a failed or skipped write still let `mark-read` advance and the note was lost on restart.

## Fix

- **Home-wide delivery identity.**
  `$STATE/.branch-outcomes-delivered/<seq>` is a zero-byte marker created with `O_EXCL`.
  Presence means the routine sequence was delivered somewhere in this home, so a replaced destination session recognizes it instead of rendering a second copy.
  The marker is removed once the row is read, keeping the ledger bounded to rows still unread after a failed cursor write.
- **Durable persistence before the cursor advances.**
  A delivery is durable only once Pi has flushed the session file.
  An append that throws is rolled back out of Pi's in-memory model so the next reconciliation re-appends it for real; a session Pi has never flushed defers the note and never lets `mark-read` cross it.
- **Ownership fence.**
  The delivery re-checks the live owner, and the atomic marker commit decides the race.
  A stale owner that lost the fence removes its own record by `deliveryId`, so the home keeps exactly one copy and a sibling owner's copy survives.

## Results

- Real-SDK probe: `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `verdict=PASS`.
  One committed note is one home-wide delivery across restart, destination replacement, and stale-owner takeover, with a deferred-then-flushed fresh session and a real `EACCES` retry, and no loss.
- Extension fixture: two new regressions (`...replacement_destination_does_not_re_deliver`, `...defers_until_the_session_flushes`) plus the existing durable tests pass (`bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh`).
- ShellCheck and actionlint pass (`bin/fm-lint.sh`).

## Residual limitations

- The rollback rewrites the destination session file only on the rare lost-fence path and identifies its own record by `deliveryId`; a concurrent append in that window could still be lost.
  The atomic home-wide marker keeps the delivery count correct regardless.
- The durability verdict reads Pi's `flushed` flag when the destination file is absent, which keeps a fixture stub on its historical in-memory contract; the real SDK's flag is authoritative.

## Open decisions

None.
The destination-change policy is the home-wide identity: a replaced destination is a new view of an already-delivered note, so it completes the cursor and renders nothing new.
