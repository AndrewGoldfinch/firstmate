# Pi-durable delivery hardening - independent adversarial verification

Task: independently and adversarially verify the hardening landed at
`e531c560926c7a98b174dc1f86c50972f1902db9` (`fix(pi): harden durable delivery
reservation recovery`), doc `docs/pi-durable/22-delivery-hardening.md`. The
deliverable is this report, not a code change.

- Repo/worktree: disposable scratch worktree of firstmate-pi-durable, detached HEAD `e531c560`.
- Files changed by the commit: only `.pi/extensions/fm-branch-supervision.ts` (+87/-21),
  `docs/pi-durable/22-delivery-hardening.md` (+56), `tests/assets/pi-f09-probe.mjs` (+103/-21).
  No change to the frozen append mechanism (`bin/fm-branch-outcome.sh`) or `runtime/pi-durable/`.
- No repository code is modified in the final tree (`git status --short` empty). The adversarial
  scenario lived in a scratch copy of the probe (`/tmp/adv-probe-commit-race.mjs`) and a scratch
  plugin dir (`/tmp/adv-repo`); the worktree probe was restored with `git checkout`.
- Node v22.21.1. Unix sockets: **work** (`net.createServer`/`connect` on a unix path returned `ok`).

## Required commands

| Command | Result |
|---|---|
| `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` | `exit=0`, `F09_PROBE_COMPLETE verdict=PASS`; `FM_TEST_SUMMARY total=1 failed=0` |
| `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` | `exit=0` |
| `(cd runtime/pi-durable && npm ci && npm test)` | `# tests 81`, `# pass 81`, `# fail 0`, `# skipped 0` |
| Scratch probe with added `adv-commit-race` scenario (fixed extension) | `exit=0`, all 32 observation rows, `failed=0` |
| Same scratch scenario against pre-fix `e531c560^` extension | scenario logged, then `AssertionError: a superseded owner must not append or render a record after takeover` (the pre-fix run legitimately fails the hardening's own assertion; the scenario output was captured before it) |

## Challenge table

| Challenge | Result | Evidence | Gate impact |
|---|---|---|---|
| 1. Stale-owner append after takeover | Fixed for the probe's schedule; **STILL BREAKABLE in a concurrent commit race** | `takeover-at-destination-write` -> `memoryRecords:0, diskRecords:0, markers:0`; but `adv-commit-race` -> replacement finishes `cursor:1, unread:0, diskRecords:0` | **blocks ADVANCE** |
| 2. Reclaim atomicity (two winners / clobber) | Holds | `reclaim-interleave`: first reclaimer resumes after successor won; marker still names successor, `diskRecords:1`; `reclaimReservation` re-checks the fence at `:1266` before `renameSync` | none |
| 3. Marker-write crash (empty/partial marker, abandoned temp) | Holds for create; temp always reclaimed | `marker-write-crash` -> `diskRecords:1, unread:0, markers:0`; `createMarkerAtomic`/`writeMarkerAtomic` `:1147`,`:1156`; reaper `:1288-1301` removes non-integer names | none |
| 4. Regression set (recovery, double-destination, adoption+rollback, crash-before-append, rise-after-committed, fresh-session, EACCES, leaked-marker, flag-off) | Green except the new race | live probe all schedules pass; `fm-pi-branch-extension.test.sh` exit 0; `npm test` 81/81 | none |
| 5. Flag-off default path / frozen append untouched | Holds | commit touches no `bin/` or `runtime/pi-durable/` file; `deliverRoutineOutcome` `:1399` unchanged; `default-restart` reproduces the documented duplicate-on-restart | none |

## Per-question findings

### 1. Stale-owner append / adopted-only copy - **NEW DEFECT (loss)**

Can a superseded owner still append or render after takeover? The eager-release path
(`appendDurableOutcome` -> `supersededPending` -> `rollbackDeliveryEntry(..., force=true)`,
`.pi/extensions/fm-branch-supervision.ts:1372-1374`, force block `:1067-1075`) correctly rolls the
stale owner's own record out for the probe's schedule. But the guard is only a single read of the
marker:

```
:1372  const marker = readReservation(row.seq);
:1373  const supersededPending = marker?.status === "reserved" && marker.deliveryId === deliveryId;
:1374  rollbackDeliveryEntry(row.seq, currentMainSession.getSessionFile(), customType, deliveryId, supersededPending);
```

The stale owner does this **without holding the lock** (it has already failed
`generationOwnsLockSync`). Meanwhile the lock owner is in `markDeliveryCommitted`
(`:1236`): it reads the reserved marker, then writes the committed marker
(`writeMarkerAtomic`, `:1147`). A stale owner that reads the marker between those two steps sees
`reserved` and force-deletes a record the replacement is in the middle of adopting. This is a
TOCTOU window, not an impossible schedule: the stale owner's `readReservation` only has to land
before the replacement's `renameSync`, which is a few syscalls after the replacement's own read.

I forced the window with the probe's existing `pause-after-write` (stale owner stops with its record
durable) plus `pause-before-marker-write` (replacement stops inside its commit write), then resumed
the stale owner first. `adv-commit-race` output on the fixed commit:

```
ADV_COMMIT_RACE {"stale":{"memoryRecords":0,"renderedCopies":1,"cursor":0,"unread":1,"diskRecords":0,"destinationRecords":0,"deliveryMarkers":0},
"replacement":{"memoryRecords":1,"renderedCopies":1,"cursor":1,"unread":0,"diskRecords":0,"destinationRecords":0,"deliveryMarkers":0}}
```

The same scenario on the pre-fix extension (`e531c560^`):

```
ADV_COMMIT_RACE {"stale":{"memoryRecords":1,"renderedCopies":1,"cursor":0,"unread":1,"diskRecords":1,"destinationRecords":1,"deliveryMarkers":1},
"replacement":{"memoryRecords":1,"renderedCopies":1,"cursor":1,"unread":0,"diskRecords":1,"destinationRecords":1,"deliveryMarkers":0}}
```

Interpretation:

- Pre-fix, the conservative rule sees `readCommittedDeliveryId(seq) === deliveryId` (a reserved
  marker already names the stale owner's id, and `readCommittedDeliveryId` at `:1200` does not
  filter on `status`) and keeps the record; the replacement adopts it durably: `diskRecords:1`.
- Post-fix, the eager release deletes the only durable copy. The replacement then adopts from its
  **in-memory** session model (`scanDurableDelivery`, `:1319`, iterates
  `currentMainSession.getEntries()`), which still holds the record it loaded at launch, and advances
  the cursor (`cursor:1, unread:0`) while `diskRecords:0` and `destinationRecords:0`.
- Net effect: a durable note is destroyed and the system records it as delivered. After any restart
  the cursor says read and the note is gone. This is a new loss introduced by the hardening, exactly
  the "record a replacement adopted and read" case the commit's own comment says it preserves.

### 2. Reclaim atomicity - holds

`reclaimReservation` (`:1251`) compares the exact stored bytes, writes the replacement to a temp,
re-checks the fence with `generationOwnsLockSync(generation)` (`:1266`) and only then renames. The
`reclaim-interleave` probe stops the first reclaimer between compare and publish, lets a successor
take the lock and reclaim, then resumes the first reclaimer; the committed marker still names the
successor (`owner` assertion) and the home keeps one record. Two winners are impossible while the
home lock admits one reclaimer, and the re-check aborts a superseded reclaimer before its rename.
A crash mid-reclaim can only leave the abandoned temp plus the unchanged stale marker (reclaimable
by the next reconcile) or the already-renamed replacement marker. The only residual is the
documented one: a re-check-to-rename window with no lock change is not eliminated, only bounded.

### 3. Marker-write crash - holds

`createMarkerAtomic` (`:1156`) writes a UUID-named temp and `linkSync`s it (EEXIST is the fence),
`writeMarkerAtomic` (`:1147`) writes a temp and `renameSync`s it, and both reclaim the temp in a
`finally`. A crash before the publish leaves the note recoverable: no marker + unread row (create
path) or a reserved marker with a dead owner and a durable record (overwrite path). The reaper
(`reclaimReadDeliveryMarkers`, `:1288`) removes any directory name whose `Number(name)` is not an
integer, so the `<seq>.<pid>.<uuid>.tmp` temps are always reclaimed on the next reconcile; the
UUID's hyphens make an all-numeric temp name impossible. The probe's `marker-write-crash` leaves an
empty temp and recovers to `diskRecords:1, unread:0, markers:0`.

### 4. Regression set - green

All schedules in the live probe pass on the fixed commit, including `reservation-crash-before-record`,
`reservation-crash-fresh-destination`, `double-destination-append`,
`takeover-after-append-before-commit`, `durable-restart`, `fresh-session`, `write-failure`,
`leaked-marker-reclaim`, `new-destination-before-ack`, and the flag-off `default-restart`.
`fm-pi-branch-extension.test.sh` exits 0 and `runtime/pi-durable` is 81/81. The only regression found
is the race in finding 1, which is a new interleaving, not a previously-passing schedule.

### 5. Flag-off default path and frozen append - unchanged

`git show --stat e531c560` lists only the extension, doc 22, and the probe. `deliverRoutineOutcome`
(`:1399`) and the flag-off branch are untouched; `default-restart` still reproduces the documented
duplicate-on-restart. `bin/fm-branch-outcome.sh` and `runtime/pi-durable` are untouched.

## New issue

**F1 (blocking):** the eager release can delete a durable record that the lock owner is concurrently
committing/adopting, turning a delivery into a memory-only adoption (`cursor:1` with
`diskRecords:0`). The fix's condition "marker is still `reserved` and names my `deliveryId`" does not
prove "no replacement has claimed this record", because the replacement's commit is a separate
non-atomic read-then-rewrite.

Suggested direction (for the implementation task, not done here): make the stale owner's rollback and
release conditional on holding the home lock (or re-check under it), so it cannot interleave with
`markDeliveryCommitted`; or have the replacement publish its claim before adopting and have the stale
owner re-read the marker immediately before deletion with the lock held. The current `finally`
removal of the temp is fine; the missing piece is mutual exclusion between the stale owner's
force-delete and the replacement's commit.

## What remains uncovered

- Free-running, truly simultaneous multi-process reclaim with no lock change: not forced; only the
  re-check bounds it (same residual doc 22 records).
- `reclaimReadDeliveryMarkers` runs on the unread snapshot taken before the per-row lock re-check
  (`:1689` vs `:1713`), so a marker written by a newly-locked owner could in principle be reclaimed
  from a stale snapshot; not reproduced (pre-existing, not introduced by this commit).
- A machine-level torn `writeFileSync` (power loss mid-write) and mixed pre-fix/post-fix legacy
  marker homes: reasoned, not reproduced.
- A live-but-replaced owner that never exits still stalls its row (liveness, not loss), as doc 22
  states.

## Recommendation

HOLD - IMPLEMENTATION
