# Reclaim compare-to-rename window probe

Status: probe and doc correction on `experiment/pi-durable-reclaim-probe` (base `c3466afd`).
It keeps the adoption-loss fix from `24-delivery-serialization.md`, does not start Phase 1, does not run a soak, and does not mark the real-path milestone complete.
It touches only `tests/assets/pi-f09-probe.mjs` and this doc; `runtime/` and `bin/fm-branch-outcome.sh` are unchanged.

## Window

`commitDelivery` serializes the initial reservation with `createMarkerAtomic`: a temp file plus `linkSync`, which fails when the marker already exists.
`reclaimReservation` does not use that fence.
It reads the stored marker, compares the exact bytes, writes its replacement to a temp, re-checks lock ownership, and only then calls `renameSync` over the marker.
The compare and the publish are therefore separate operations, and a takeover between the final ownership check and the `renameSync` can let two owners each believe they hold the sequence.

## Probe

`tests/assets/pi-f09-probe.mjs` adds the real-SDK, no-model schedule `reclaim-takeover-before-rename`.
It writes a reservation whose owner pid is dead and whose destination is `main.jsonl`, then:

1. Launches the first reclaimer, grants it the lock, and stops it with a real `SIGSTOP` at a new `pause-before-marker-rename` hook, i.e. after its final ownership check and before its `renameSync`.
2. Launches a successor on `replacement.jsonl`, grants it the lock, and lets it reclaim the same reservation while the first reclaimer is stopped.
3. Resumes the first reclaimer and lets it settle.
4. Opens the winner's destination again to adopt the committed record and clear the marker.

It asserts the visible delivery events and final counts: `resumed.diskRecords == 1` and `successor.renderedCopies + resumed.renderedCopies == 1`, then `settled.diskRecords == 1`, `settled.unread == 0`, and `settled.deliveryMarkers == 0`.

## Result

No duplicate and no loss is demonstrated.
On the unmodified extension the successor reclaims and delivers exactly once (`diskRecords: 1`, `renderedCopies: 1`), and the resumed first reclaimer delivers nothing (`diskRecords: 1`, `renderedCopies: 0`): its `renameSync` fails with `ENOENT` because the successor's reconcile already reclaimed the first reclaimer's unpublished temp.
The marker stays committed with one record, and the later adoption completes the cursor.

## Why the window stays open

The duplicate is real if that incidental temp reclamation is removed.
With `reclaimReadDeliveryMarkers` temporarily changed to skip non-integer names, the first reclaimer's temp survives, its `renameSync` clobbers the successor's marker, both owners append, and the probe fails `AssertionError: the reclaim window must not leave two durable records`.
The reclamation is a ledger-wide garbage collection of abandoned atomic-write temps, not an exclusive-create fence, so the safety of the reported schedule rests on a side effect rather than on the reclaim mechanism.
Reclaim still bypasses exclusive creation, and the guarantee is therefore scoped to the schedules the probe exercises rather than claimed unconditionally.

## Fix decision

No code change is made.
The focused schedule does not demonstrate a duplicate or a loss, and the task's rule is to leave reclaim unchanged in that case.
A structural close would replace the compare-then-rename publish with an exclusive-create claim (for example a per-sequence claim file created with `linkSync`, held only by the publisher, and reclaimed when its owner pid is dead) or serialize reclaim and append under a single winner; that is left for a separate task, with the counterfactual above as the evidence that the window is open.

## Corrected guarantee

`docs/pi-durable/24-delivery-serialization.md` now scopes its exactly-once wording: the delivery path passes on the reported schedules, the reclaim compare-to-rename window is open in construction, and no unconditional exactly-once claim is made.

## Verification

- `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `F09_PROBE_COMPLETE verdict=PASS`, exit `0`.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> exit `0`.
- `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass, `0` fail.
- `reclaim-takeover-before-rename`: successor `diskRecords: 1`, `renderedCopies: 1`; resumed first reclaimer `diskRecords: 1`, `renderedCopies: 0`; adoption `diskRecords: 1`, `unread: 0`, `deliveryMarkers: 0`.

## Residual

- The window is open in construction and closed only by the successor's temp reclamation on the reported schedule.
- A same-generation concurrent reclaim, two processes that both resolve the lock as owned, and a free-running multi-process reclaim with no lock change remain untested.
- The committed reservation whose record lives only in a different destination still defers there, as docs 18 and 20 state.
- This change does not promote the real path and does not complete the milestone; that decision stays with firstmate.
