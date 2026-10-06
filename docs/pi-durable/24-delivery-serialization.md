# Pi Durable delivery serialization

Status: implemented on `experiment/pi-durable-delivery-serialization`.
This corrects the hardening landed in `22-delivery-hardening.md` after `23-hardening-verify.md` found that its eager stale-owner release destroyed the only durable copy in a concurrent commit race.
It closes the loss only: it does not start Phase 1, does not run a soak, and does not mark the real-path milestone complete.
The delivery guarantee below is scoped to the schedules the real-SDK probe exercises; reclaim's compare-to-rename window is not closed by exclusive creation, as `26-reclaim-window.md` records.
It keeps the proven reserve-before-append recovery, the atomic marker publication, the frozen Durable Outcome append mechanism (`runtime/pi-durable` and `bin/fm-branch-outcome.sh`), and the default (flag-off) presentation path unchanged.
The real-SDK probe keeps its no-model, no-fetch discipline; every interleaving is forced with a real `SIGSTOP` or `SIGKILL`.

## Defect: the eager release deleted the only durable copy

`23-hardening-verify.md` forced the window with `pause-after-write` (the stale owner stops with its record durable) plus `pause-before-marker-write` (the replacement stops inside its commit write), then resumed the stale owner first.
On the hardened commit, `appendDurableOutcome` read the still-`reserved` marker that named the stale owner's own `deliveryId`, treated that as `supersededPending`, and called `rollbackDeliveryEntry(..., force=true)`, which deleted the record.
The replacement then adopted from its **in-memory** session model and advanced the cursor, ending at `diskRecords: 0`, `cursor: 1`, `unread: 0`.
After any restart the cursor says read and the note is gone: a new loss introduced by the hardening, exactly the "record a replacement adopted and read" case its own comment said it preserved.

## Change 1: a lost fence never deletes a durable record

`appendDurableOutcome` no longer rolls the record back when it loses the fence after the append.
The append is already flushed at that point, so the record is durable; the superseded owner keeps it, and the replacement adopts it.
The `force` parameter and its block were removed from `rollbackDeliveryEntry`, so the only remaining rollback is the losing-sibling cleanup in `adoptDurableDelivery`: it removes this owner's record only when a committed marker names a different record or a different record for the same sequence survives in the session file.
No delivery mutation can now remove the home's only durable copy.

## Change 2: what serializes reserve -> append -> commit, and what does not

The serialization authority is the home-wide marker, not an ownership read.
`commitDelivery` publishes a reservation with `createMarkerAtomic`, which writes a temp and `linkSync`s it, and `linkSync` fails when the marker already exists.
Exactly one owner in the home can therefore hold a reservation for a store sequence.
Every delivery path for that sequence reads that marker first: a fresh owner reserves, a reclaiming owner replaces only the exact stored bytes, and a replacement that finds a live reservation it cannot reclaim defers without appending.
A takeover changes only `state/.lock`; it never touches the marker.
On the reported schedules no second owner appends a competing durable record for the same sequence, but that exactly-once property is scoped to those schedules: reclaim's compare-to-rename window is open in construction, as the next section and `26-reclaim-window.md` record.

What the hardening left unsynchronized was the stale owner's **destructive** rollback, which read the marker and then deleted.
With that removed, the delivery path performs no destructive mutation of a durable record, so a takeover cannot cause loss by interleaving with it.

This is not a claim that reclaim is a true compare-and-swap.
`reclaimReservation` still reads and compares the stored bytes, writes the replacement to a temp, re-checks ownership, and only then renames.
Portable Node offers no compare-and-swap primitive on a file, and the takeover path is an external, non-atomic `state/.lock` rewrite that the extension does not control, so "hold the home lock across the mutation" would be another read-then-act rather than mutual exclusion.
The compare-to-rename window is bounded by the ownership re-check, not eliminated.
A focused takeover probe (`reclaim-takeover-before-rename`) stops the first reclaimer after its final ownership check and before its publish, then lets a successor take the lock and reclaim the same reservation.
No duplicate or loss results: the successor's reconcile reclaims the stopped reclaimer's unpublished temp before it publishes, so the first reclaimer's resume fails with `ENOENT` instead of clobbering the winner.
That reclamation is a ledger-wide temp cleanup, not an exclusive-create fence, so the window stays open in construction and the guarantee is scoped to the reported schedules.

## Contract change (option 2)

Enforceable serialization of takeover against Pi's session append is beyond this task's scope, because Pi's append is not transactional with the marker and cannot be rolled back atomically.
This task therefore records an explicit contract change:

- An already-authorized in-flight delivery may finish and be adopted after takeover.
- The original "a superseded owner cannot deliver" invariant is **not** met.
- This change closes the loss only; it does **not** by itself close the reclaim proof gap.

## Probes

The regression set in `tests/assets/pi-f09-probe.mjs` keeps every existing schedule and adds:

- `adv-commit-race` (the verifier's scenario, now committed): the stale owner stops after its durable append, the replacement loads that record and stops inside its commit write, the stale owner resumes first, then the replacement resumes. The probe asserts the durable record and its visible delivery event survive the stale owner's resume (`memoryRecords: 1`, `renderedCopies: 1`, `diskRecords: 1`) and that the replacement still ends at exactly one durable record with `cursor: 1`, `unread: 0`.
- `takeover-at-destination-write` now asserts the corrected contract on the resumed stale owner: `memoryRecords: 1`, `renderedCopies: 1`, `diskRecords: 1`, `unread: 1`, `deliveryMarkers: 1` (the reservation is committed, not destroyed), with the lock owner still completing the cursor on reopen. This is the takeover after the final authority check and before the append, now asserting visible delivery events as well as final record counts.
- `reclaim-interleave` now also asserts the visible events: the successor renders exactly one delivery and the first reclaimer that loses the race renders none.
- `reclaim-takeover-before-rename`: the first reclaimer stops after its final ownership check and before its publish; a successor takes the lock and reclaims the same reservation; the first reclaimer then resumes. The probe asserts one durable record and one visible delivery across the window (`successor.renderedCopies + resumed.renderedCopies == 1`, `resumed.diskRecords == 1`) and that a later adoption on the winner's destination clears the marker.

Failing first, extension reverted to `ba56c267` with the new probe kept:

- `takeover-at-destination-write` fails `AssertionError: a superseded owner keeps the durable record it appended`.
- With that scenario's assertions relaxed to the old behavior, `adv-commit-race` fails `AssertionError: a lost fence must never delete the durable record`.
- `reclaim-takeover-before-rename` does not fail on the unmodified extension, because the successor's temp reclamation removes the stopped reclaimer's unpublished temp; with `reclaimReadDeliveryMarkers` temporarily changed to skip non-integer names, it fails `AssertionError: the reclaim window must not leave two durable records`.

## Results

- `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `F09_PROBE_COMPLETE verdict=PASS`, exit `0`.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> exit `0`.
- `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass, `0` fail.
- `adv-commit-race` on the fixed extension: stale resume `diskRecords: 1`, `renderedCopies: 1`; replacement settle `diskRecords: 1`, `cursor: 1`, `unread: 0`.
- `reclaim-takeover-before-rename` on the unmodified extension: successor `diskRecords: 1`, `renderedCopies: 1`; resumed first reclaimer `diskRecords: 1`, `renderedCopies: 0` (its publish failed `ENOENT`); later adoption `diskRecords: 1`, `unread: 0`, `deliveryMarkers: 0`.
- The existing schedules stay green in the same live probe: `durable-restart`, `fresh-session`, `write-failure`, `double-destination-append`, `takeover-after-append-before-commit`, `reservation-crash-before-record`, `reservation-crash-fresh-destination`, `leaked-marker-reclaim`, `reclaim-interleave`, `marker-write-crash`, and the flag-off `default-restart`.

## Residual

- The "superseded owner cannot deliver" invariant is not met; an in-flight delivery may finish and be adopted after takeover, as the contract change above states.
- Reclaim is not a true CAS: the compare-to-rename window is bounded by the ownership re-check and, on the reported schedule, by the successor's reclamation of the stopped reclaimer's temp; it is not closed by exclusive creation, so the guarantee stays scoped to the reported schedules.
- A free-running multi-process reclaim with no lock change remains untested.
- A committed reservation whose record lives only in a different destination still defers there, as docs 18 and 20 state.
- A live-but-replaced owner that never exits still stalls its row until it does (liveness, not loss).
- This change does not promote the real path and does not complete the milestone; that decision stays with firstmate.
