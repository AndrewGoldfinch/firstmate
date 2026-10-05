# Adversarial verification: corrected Pi Durable delivery serialization (2459982b)

- Task: `pi-durable-serialization-verify` (scout; report only, no code change).
- Commit under test: `2459982bf46f6a5aaa64996ecbd5f56b469dce24` ("fix(pi): keep a superseded owner's durable delivery"), merged at `cef0046f`.
- Worktree: detached at `2459982b`, clean, `git fetch origin` run first.
- Environment: node v22.21.1, npm 11.21.0, `@earendil-works/pi-coding-agent` 1.0.0.
- Unix sockets: available (`node -e "net.createServer().listen('/tmp/fmtest.sock')"` -> `unix socket OK`).
- Deliverable verdict: **ADVANCE**.

## Scope of the change

`git show --name-status --format= 2459982b`:

```
M  .pi/extensions/fm-branch-supervision.ts
A  docs/pi-durable/24-delivery-serialization.md
M  tests/assets/pi-f09-probe.mjs
```

Two code hunks, both in the flag-on (`FM_PI_DURABLE_DELIVERY`) routine delivery path:

1. `appendDurableOutcome` lost-fence branch (`.pi/extensions/fm-branch-supervision.ts:1365-1377`) no longer rolls back; it keeps the already-flushed record and reports it durable.
2. `rollbackDeliveryEntry` (`.pi/extensions/fm-branch-supervision.ts:1066`) lost its `force` parameter and the destructive forced branch.

`bin/fm-branch-outcome.sh`, `runtime/pi-durable/**`, and the flag-off branch (`.pi/extensions/fm-branch-supervision.ts:1712-1716`, `deliverRoutineOutcome`) are untouched by the commit.

## Challenge table

| # | Challenge | Result | Evidence | Gate impact |
|---|-----------|--------|----------|-------------|
| 1 | Re-run the verifier's `adv-commit-race`; try to still cause a loss (stale owner stops after durable append, replacement stops inside commit write, stale resumes first) | No loss | `FM_PI_F09_ONLY=1 ...` -> `F09_PROBE_COMPLETE verdict=PASS`; obs `stale-owner-resumes-before-commit` `memoryRecords:1 renderedCopies:1 diskRecords:1 deliveryMarkers:1`; `replacement-commits-after-race` `diskRecords:1 destinationRecords:1 cursor:1 unread:0` | PASS |
| 2 | A superseded owner keeps its record and the replacement adopts it (no delete of an adopted record) | No delete | `.pi/extensions/fm-branch-supervision.ts:1365-1377` keeps the record; `rollbackDeliveryEntry` is called from exactly one site (`:1425`, `adoptDurableDelivery`) and that call returns `false`, so the cursor never crosses a removed record | PASS |
| 3 | Marker `O_EXCL` creation: get two owners to reserve one sequence | One winner only | `commitDelivery` (`:1204`) uses `createMarkerAtomic` (`:1155`, temp + `linkSync`); scratch scenario `adv-double-reserve` (below) passed: loser `diskRecords:0 renderedCopies:0`, winner marker owner unchanged | PASS |
| 4 | Second owner appends a competing durable record | None appended | Scratch `adv-double-reserve`: winner `diskRecords:1 deliveryMarkers:1`; loser after resume `diskRecords:1` total, its own `destinationRecords:0`, `deliveryMarkers:1` (winner's reservation preserved) | PASS |
| 5 | Option-2 contract honest: code permits an in-flight delivery to finish and be adopted after takeover | True | `appendDurableOutcome` keeps the record and returns `durable:true`; `appendUnderReservation` (`:1481`) marks it committed; replacement adopts via `recordedDelivery`/`adoptDurableDelivery` (`:1417`). `adv-commit-race` ends `cursor:1 unread:0` | PASS |
| 6 | Doc states the "superseded owner cannot deliver" invariant is NOT met | Stated | `docs/pi-durable/24-delivery-serialization.md` Contract change (option 2): "An already-authorized in-flight delivery may finish and be adopted after takeover" / "The original \"a superseded owner cannot deliver\" invariant is **not** met." | PASS |
| 7 | Reclaim non-atomicity documented, not overclaimed | Stated | Same doc: "This is not a claim that reclaim is a true compare-and-swap ... The compare-to-rename window is bounded by the ownership re-check, not eliminated." Matches `reclaimReservation` (`:1250-1269`) compare -> temp -> `generationOwnsLockSync` re-check -> rename | PASS |
| 8 | Regression set green | Green | See "Regression evidence" below; all 14 homes green | PASS |
| 9 | Default (flag off) path unchanged | Unchanged | Flag gate `:1712-1716`; changed functions are only reached when `durableDeliveryEnabled` (`:173`). `default-restart` scenario still shows the pre-existing duplicate-by-design `diskRecords:2 renderedCopies:2` | PASS |
| 10 | Frozen Durable Outcome append untouched | Untouched | `git show --name-status` lists no `bin/fm-branch-outcome.sh`; no hunk touches it; `runtime/pi-durable` npm suite unchanged 81/81 | PASS |

## Per-question findings

### (a) No code path deletes a durable record a replacement is adopting

- The only record-deleting code is `rollbackDeliveryEntry` (`.pi/extensions/fm-branch-supervision.ts:1066`). It is reached from exactly one caller, `adoptDurableDelivery` (`:1425`), and after deleting it always `return false` (`:1427`). The reconciliation loop returns `false` from `ensureRoutineOutcome`, so no `mark-read` occurs and the row stays unread: the delivery is never lost even in the worst case.
- The old loss is exactly gone: the stale owner no longer calls `rollbackDeliveryEntry` after losing the fence (`appendDurableOutcome:1365-1377`). `adv-commit-race` proves the stale owner keeps `diskRecords:1 renderedCopies:1` and the replacement finishes at `diskRecords:1 cursor:1 unread:0`.
- I tried the inverse interleavings already in the suite (`takeover-at-destination-write`, `takeover-after-append-before-commit`, `reclaim-interleave`) and one new one (`adv-double-reserve`). None produced a loss or a duplicate.

### (b) Marker O_EXCL serialization

- `commitDelivery` (`:1204`) publishes with `createMarkerAtomic` (`:1155`): write a unique temp (`${path}.${pid}.${uuid}.tmp`) then `linkSync(temp, path)`. `linkSync` fails with `EEXIST` when the marker already exists, and `commitDelivery` returns `false`; no second reservation for one sequence can be created. The `finally` removes the temp, so a failed link leaves no debris.
- `releaseReservation` (`:1221`) and `markDeliveryCommitted` (`:1235`) only touch a marker whose `deliveryId` equals this owner's random UUID, so neither can remove or overwrite a winner's marker.
- Scratch scenario `adv-double-reserve` (added to `tests/assets/pi-f09-probe.mjs`, run, then reverted so the repo is unmodified): owner A stops before its marker publish, owner B takes the lock and reserves first, then A resumes and its `linkSync` must fail. Result: winner `{diskRecords:1, renderedCopies:1, deliveryMarkers:1, marker.owner=B}`; loser after resume `{diskRecords:1 (home total), destinationRecords:0, renderedCopies:0, deliveryMarkers:1, marker.owner=B unchanged}`. Exactly one reservation, exactly one durable record, no competing append.
- A free-running multi-process reclaim with no lock change remains untested; the doc says so. The compare-to-rename window is bounded by the ownership re-check, not eliminated; the doc says so.

### (c) Option-2 contract honesty

Confirmed by reading `docs/pi-durable/24-delivery-serialization.md` end to end against the code:

- The doc explicitly records that an already-authorized in-flight delivery may finish and be adopted after takeover, and that the original invariant is **not** met. Code supports this (`appendDurableOutcome:1365-1377` keeps the record; the replacement adopts it).
- The doc explicitly declines to call reclaim a CAS and bounds its window; code matches.
- The doc's own "uncovered" list is accurate: a free-running multi-process reclaim with no lock change is untested; a committed reservation whose record lives only in a different destination still defers (see `new-destination-before-ack`, `recordedDelivery:1436-1470`); a live-but-replaced owner that never exits stalls its row (liveness, not loss); this change does not promote the real path.

### (d) Regression evidence

Commands run from the worktree root at `2459982b`:

```
FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh
  -> ok - real Pi SDK 1.0.0 F09 delivery boundary holds exactly one home-wide delivery with no loss
  -> F09_PROBE_COMPLETE verdict=PASS, exit=0, duration_ms=21577

bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh
  -> exit=0, duration_ms=66740, FM_TEST_SUMMARY total=1 failed=0

(cd runtime/pi-durable && npm ci && npm test)
  -> # tests 81 / # pass 81 / # fail 0, exit=0
```

All 14 probe homes are exercised (12 named plus the `durable-restart`/`default-restart` loop): `default-restart`, `durable-restart`, `fresh-session`, `write-failure` (EACCES), `double-destination-append`, `new-destination-before-ack`, `takeover-at-destination-write`, `adv-commit-race`, `takeover-after-append-before-commit`, `reservation-crash-before-record`, `reservation-crash-fresh-destination`, `leaked-marker-reclaim`, `reclaim-interleave`, `marker-write-crash`.

Key observations (verbatim from the probe output):

- `adv-commit-race` stale resume: `diskRecords:1 renderedCopies:1 deliveryMarkers:1`; replacement settle: `diskRecords:1 cursor:1 unread:0`.
- `takeover-at-destination-write` stale resume: `memoryRecords:1 renderedCopies:1 diskRecords:1 unread:1 deliveryMarkers:1`; reopen: `cursor:1 unread:0`.
- `reclaim-interleave` successor: `diskRecords:1 renderedCopies:1`, marker `owner=<successor>`; first reclaimer resume: `diskRecords:1 renderedCopies:0`, marker owner unchanged.
- `write-failure` (EACCES): `ioErrors:["EACCES"]`, `memoryRecords:0 diskRecords:0 deliveryMarkers:0 unread:1`; after recovery `diskRecords:1 unread:0`.

### (e) No new loss/duplicate; frozen append untouched

- No new loss/duplicate found. The only remaining rollback (`adoptDurableDelivery` -> `rollbackDeliveryEntry`) returns `false`, so it can only shrink a sibling set on an unread row, never cross the cursor.
- The flag-off path (`deliverRoutineOutcome`) and the captain path (`ensureVisibleCaptainOutcome`) are structurally unchanged except that the captain path also benefits from the no-rollback fix.
- `bin/fm-branch-outcome.sh` (the frozen append) is not in the commit; `runtime/pi-durable` is not in the commit and its suite stays green.

## New / minor issues (not blockers)

1. **Dead guard / doc imprecision (minor).** The doc says the remaining rollback fires "only when a committed marker names a different record **or** a different record for the same sequence survives in the session file." But the sole call site (`adoptDurableDelivery:1422`) requires `committed && committed !== existing.deliveryId`, so `readCommittedDeliveryId(seq)` is non-null there. The `committedId === null && !hasSiblingDelivery(...)` branch in `rollbackDeliveryEntry:1074` is therefore unreachable. It is conservative (it can only prevent deletion), so it is not a safety bug, but it is dead code and the doc describes a path that cannot run.
2. **"Committed marker" is imprecise (minor).** `readCommittedDeliveryId` (`:1199`) returns a **reserved** marker's `deliveryId` too. `adoptDurableDelivery` can therefore be reached with a reserved marker via the `commitDelivery`-failure path (`:1533`). It still returns `false` on a sibling rollback, so the row stays unread; but the doc's "committed marker" wording is stronger than the code guarantees.
3. **Legacy records without `deliveryId` bypass the sibling check (uncovered).** `parseRoutineDeliveryRecord` (`:556`) does not require `deliveryId`, so `existing.deliveryId` can be `null`; `adoptDurableDelivery:1422` then skips the rollback and returns `true`. If a legacy routine record (no `deliveryId`) and a newer committed record for the same sequence coexist, the legacy copy is not cleaned up and the cursor can cross. This is a pre-existing record-shape edge, not introduced by `2459982b`, and the durable feature is flag-gated; still worth a follow-up test if the feature is ever promoted.

## What remains uncovered

- Free-running multi-process reclaim with no lock change (documented gap).
- Reclaim compare -> temp -> recheck -> rename is bounded, not eliminated (documented; the `reclaim-interleave` probe only forces a lock takeover, not a same-generation double rename).
- A committed reservation whose durable record lives only in a different destination defers there (documented; `new-destination-before-ack`).
- Legacy `deliveryId`-less routine records coexisting with a newer committed record (item 3 above).
- No model or live terminal was used; the probe drives synthetic lifecycle events against the real SDK, as its own scope line states.

## Completion gate (captain-hold-lifecycle)

Semantic inventory of this report: **no captain-owned unresolved choice is exposed.** The ADVANCE recommendation is a firstmate implementation call, not a product/security/data decision, and no other question in this report belongs to the captain. Therefore the completion attestation is `--none`. I did not run `bin/fm-captain-hold.sh complete pi-durable-serialization-verify --none` because the worker brief (Rule 2) permits writing only the report and the status file outside the worktree; firstmate owns that backlog attestation.

## Reproduce

```
git fetch origin && git checkout --detach 2459982b
FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh
bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh
(cd runtime/pi-durable && npm ci && npm test)
```

Scratch adversarial scenario (temporary edit to `tests/assets/pi-f09-probe.mjs`, reverted after the run; key body):

```js
const home = setup("adv-double-reserve");
const markerDir = join(home, "state/.branch-outcomes-delivered");
const first = await launch(home);
const second = await launch(home, { destination: "replacement" });
grant(home, first);
await first.request("pause-before-marker-write");
const firstBlocked = first.request("start"); firstBlocked.catch(() => {});
// wait for first to SIGSTOP before its marker publish; assert no marker exists
grant(home, second); failAck(home);
const winner = observe(home, "successor-reserves-first", await second.request("start"));
assert.equal(winner.diskRecords, 1); assert.equal(winner.deliveryMarkers, 1);
first.child.kill("SIGCONT");
const loser = observe(home, "first-resumes-loses-reserve", await firstBlocked);
assert.equal(loser.diskRecords, 1); assert.equal(loser.renderedCopies, 0);
```

## Final line

ADVANCE
