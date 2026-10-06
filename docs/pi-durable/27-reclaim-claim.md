# Pi Durable reclaim claim

Status: implemented on `experiment/pi-durable-reclaim-close`.
It closes the reclaim compare-to-rename window that `26-reclaim-window.md` left open.
It keeps the option-2 stale-delivery contract and the adoption-loss fix from `24-delivery-serialization.md`, does not start Phase 1, does not run a soak, and does not mark the real-path milestone complete.
It touches `.pi/extensions/fm-branch-supervision.ts`, `tests/assets/pi-f09-probe.mjs`, this doc, and the scoping lines of docs 24 and 26; `runtime/` and `bin/fm-branch-outcome.sh` are unchanged.

## Mechanism

`reclaimReservation` no longer compares the stored marker and then renames a separate temp over it.
It first removes a claim left by a dead owner, then writes the replacement reservation to a temp and creates the per-sequence claim file `<seq>.claim` with `linkSync`.
`linkSync` fails when the claim already exists, so exactly one reclaimer in the home can hold the claim.
The claim file is a hard link to the replacement bytes; the winner drops its own temp link and, after re-checking that the stored bytes still match and that it still owns the lock, renames the claim file over the marker.
The claim is therefore the publish itself, and no separate temp has to survive the window.
After the rename the winner confirms the marker names its own delivery and otherwise appends nothing.
`reclaimReadDeliveryMarkers` never sweeps a `.claim` file as an abandoned temp; it reclaims one only when its recorded owner pid is dead.

## Why it is exclusive

`linkSync` is an atomic exclusive-create on the filesystem: the kernel grants it to exactly one caller and fails every other with `EEXIST`.
The winner is decided by that link, not by reading another owner's state, so a takeover cannot interleave between the compare and the publish.
The old compare-then-rename publish was two operations with a window between them; the claim collapses the win into one atomic filesystem operation.
A second reclaimer that loses the link returns without publishing, and once a winner has published the later marker compare can only fail.
A dead-claim cleanup can race a live claim when two reclaimers both observe a crashed owner, but the post-rename identity check means the loser never appends against a marker that does not name its delivery, so the race can stall a row but cannot produce two durable records.

## Regression

`tests/assets/pi-f09-probe.mjs` adds `reclaim-takeover-without-temp-sweep`, the doc-26 counterfactual as a real-SDK schedule.
It stops the first reclaimer after its final ownership check and before its publish, then lets a successor reclaim the same reservation with the successor's abandoned-temp sweep suppressed, so the first reclaimer's unpublished temp survives exactly as doc 26 described.
On the pre-fix compare-then-rename publish the resumed first reclaimer clobbers the successor's marker, both owners append, and the probe fails `AssertionError: the reclaim window must not leave two durable records` with `resumed.diskRecords: 2`.
With the claim the successor cannot take the claim, the first reclaimer publishes once, and the probe settles at exactly one durable record, one visible delivery, and a committed marker that a later adoption on the winner's destination clears.
The existing `reclaim-takeover-before-rename` schedule now sees the first reclaimer's in-flight delivery finish after the takeover under the option-2 contract, so its later adoption runs on that destination.

## Evidence

- `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `F09_PROBE_COMPLETE verdict=PASS`, exit `0`.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> exit `0`.
- `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass, `0` fail.
- Pre-fix `reclaim-takeover-without-temp-sweep`: `resumed.diskRecords: 2`, `AssertionError: the reclaim window must not leave two durable records`.
- Fixed `reclaim-takeover-without-temp-sweep`: successor `renderedCopies: 0`; resumed first reclaimer `diskRecords: 1`, `renderedCopies: 1`; later adoption `cursor: 1`, `unread: 0`, `deliveryMarkers: 0`.
- Fixed `reclaim-takeover-before-rename`: successor `diskRecords: 0`, `renderedCopies: 0`; resumed first reclaimer `diskRecords: 1`, `renderedCopies: 1`; later adoption `cursor: 1`, `unread: 0`, `deliveryMarkers: 0`.

## Scope

The reclaim publish is now fenced by an exclusive-create claim, so the exactly-once property no longer depends on the successor's incidental temp reclamation and the doc-26 conditional scope is closed.
The guarantee stays scoped to the remaining limits:
- A free-running multi-process reclaim with no lock change remains untested.
- A live-but-replaced owner that never exits still stalls its row until it does (liveness, not loss).
- A committed reservation whose record lives only in a different destination still defers there, as docs 18 and 20 state.
- The dead-claim cleanup is a read-then-remove that two reclaimers can race; the post-rename identity check keeps that race from producing a second durable record, but it can leave a row stalled until the stale owner exits.
- The option-2 contract still permits an already-authorized in-flight delivery to finish and be adopted after takeover.
- This change does not promote the real path and does not complete the milestone; that decision stays with firstmate.
