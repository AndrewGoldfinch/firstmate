# Phase 1 pilot — independent adversarial verification

- Verified commit: `a9ada2d1380a9e5f5f0e4f3f68ce506de8c71737` (detached; `docs/pi-durable/29-phase1-pilot.md`, `tests/assets/pi-phase1-probe.mjs`, `tests/fm-pi-phase1-pilot.test.sh`).
- Method: read the probe, the guard, the doc, and the extension's real lock/durable-delivery code end to end; re-ran every shipped suite; ran an instrumented copy of the probe to prove the soak's schedule alternation; ran a modified probe to attack the two schedules the doc explicitly does NOT claim; mutated the pre-Phase-1 baseline to test whether the baseline gate can actually fail.
- All evidence below is from this worktree, Pi `1.0.4`, Node `v22.21.1`, Linux. Scratch artifacts live under `/tmp/verify/` and are not part of any commit.

Hashes at the verified commit:

```
cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09  .pi/extensions/fm-branch-supervision.ts
f3151ea0bd5608282a575288c79d02f54d3b4dbcf7fe8d92f47ccfa19aaa66f5  tests/assets/pi-phase1-probe.mjs
af47add66459251c1567d5fef9e87ad15648fd49a8d3264f76c1a81930a90721  bin/fm-branch-outcome.sh
```

Extension and probe hashes match the doc's "Lab identity" exactly. `git diff-tree --no-commit-id --name-status -r a9ada2d1` shows the commit adds only the three files above (803 insertions); extension, `bin/fm-branch-outcome.sh`, and `runtime/pi-durable/src/` are untouched.

## Verdict summary

The headline claim — 0 duplicates / 0 losses across real lock handover, the normal session lifecycle, and a bounded concurrent soak — **held under every independent test I could devise, including 60 soak cycles and the two schedules the pilot does not claim.** I could not produce a duplicate or a loss.

I did find one concrete defect: the pilot's pre-Phase-1 baseline comparison is wrapped in a `try/catch` that swallows the comparison's own assertion failure, so a real baseline body mismatch is recorded as a residual and the probe still reports `verdict=PASS` (exit 0). The harness therefore cannot fail the baseline gate it advertises. See issue I1.

## Challenge table

| # | Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- | --- |
| 1 | Probe inserts a per-consumer anchor; lock names an ancestor, not the consumer's own pid | PASS | `anchor()` forks a worker (`pi-phase1-probe.mjs:145`); `grant()` writes `consumer.anchorPid` into `state/.lock` (`:324`), never the worker pid | Real lock walk exercised |
| 2 | Ownership is the extension's real `ps`-walked ancestry, not a depth-0 self-pid check | PASS | `parentPid` = `ps -o ppid= -p` (`fm-branch-supervision.ts:376,382`); `lockOwnership` walks up to `LOCK_ANCESTRY_DEPTH=8` (`:413,435-452`); live chain measured `worker 2710806 <- anchor 2710788 <- controller 2700228`, lock=`2700228`, `controllerInChain=true` | Real ownership, not synthetic |
| 3 | Non-owner stays inert; owner delivers exactly once | PASS | `real-lock-ownership` asserts secondary inert and previous owner inert after handover; my shared-lock attack (3 simultaneously-owned consumers) still produced `records=1 entries=1 cursor=1` | No false delivery |
| 4 | Flag-off default body compared byte-for-byte against the real pre-Phase-1 extension from `1f3e7696` | PASS for content | Guard extracts `git show 1f3e7696:...` (`fm-pi-phase1-pilot.test.sh:45-50`); run with `FM_PHASE1_OUTPUT` reports `baselineCompare="identical"`, both SHAs `8d9343e869b028cf8cb38491de196d55d1def9f8adc92b2b329e441d7ed860cd` | Baseline content confirmed |
| 5 | A body/behavior change would fail that comparison | **FAIL (harness)** | Mutated baseline body (`... MUTATED`) still yields `verdict=PASS`, exit 0, and `baselineCompare="unavailable: the flag-off body must be byte-identical..."` — the `assert.equal` at `:510` throws inside the `try`, caught at `:514-516` | Baseline gate cannot fail the run (I1) |
| 6 | Soak alternates both pause points | PASS (with caveat) | Instrumented copy printed `pausePoint=pause-after-write` on even `i`, `pause-before-write` on odd `i` (6/6 cycles); code `:546` | Both exercised |
| 7 | Soak alternates both handover orders | PASS (with caveat) | Instrumented copy printed `handoverOrder=[1,2],[0,2],[0,1],[2,1],[2,0],[1,0]` for `i=0..5`; code `:548` | Both orders exercised |
| 8 | Soak alternation is not collapsing to one path | PASS (with caveat) | `pausePoint` and `handoverOrder` are both driven by the same `i % 2` (`:546,:548`), so only 2 of the 4 combinations ever occur: after-write+[second,third] and before-write+[third,second] | 2/4 combinations uncovered (I3) |
| 9 | Larger soak: force a duplicate or a loss | PASS (none produced) | `FM_PHASE1_CYCLES=60 FM_PHASE1_SOAK_SECONDS=900`: 60/60 cycles, `totalRecords=60 totalDeliveries=60 duplicates=0 losses=0`, 120 soak rows all `homeRecords=1`, exit 0 | Headline claim holds |
| 10 | Attack schedule NOT claimed: two processes both resolve the lock as owned | PASS (no dup/loss) | Modified probe names the common ancestor (`process.pid`) in the lock so all 3 consumers resolve `owned` at depth 2; result `records=1 entries=1 cursor=1 unread=0` | Reservation serializes even without the lock fence |
| 11 | Attack schedule NOT claimed: free-running reclaim with no lock change | PASS (no dup/loss) | Modified probe hard-kills the owner while its reservation is `reserved` with no record, then lets the next owner reclaim under the same lock pid; result `records=1 cursor=1 unread=0`, no stray marker | No loss on forced stale-owner reclaim |
| 12 | Byte-for-byte default (flag off) unchanged | PASS | `defaultPresentation.sha256 == baselinePresentation.sha256 == 8d9343...`; `state/.branch-outcomes-delivered` absent on the flag-off home (`:503-505`) | Default path unchanged |
| 13 | Frozen Durable Outcome append untouched | PASS | Pilot commit adds only 3 files; `bin/fm-branch-outcome.sh` sha `af47add6...` unchanged by `a9ada2d1` | No runtime change smuggled in |
| 14 | Shipped suites still pass | PASS | see "Shipped suites" below | No regressions |

## Shipped suites (re-run at `a9ada2d1`)

| Suite | Command | Result |
| --- | --- | --- |
| Phase 1 pilot | `FM_PI_PHASE1_PILOT=1 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh` | `FM_TEST_SUMMARY total=1 failed=0`, `PHASE1_PROBE_COMPLETE verdict=PASS`, `exit=0`, 69.7 s |
| Phase 1 pilot, 60 cycles | `FM_PI_PHASE1_PILOT=1 FM_PHASE1_CYCLES=60 FM_PHASE1_SOAK_SECONDS=900 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh` | `total=1 failed=0`, `verdict=PASS`, `exit=0`, 204.3 s; soak 60/60, 60 records, 60 deliveries, 0 dup, 0 loss |
| Live e2e | `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` | `F09_PROBE_COMPLETE verdict=PASS`, `exit=0`, 41.5 s |
| Extension | `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` | `total=1 failed=0`, `exit=0`, 73.1 s |
| Runtime unit tests | `(cd runtime/pi-durable && npm ci && npm test)` | 81 pass, 0 fail, `exit=0` |

## Per-question findings

### 1. Real lock protocol

Confirmed. The probe no longer writes a consumer's own pid (the earlier F09 shortcut). `anchor()` (`pi-phase1-probe.mjs:145-164`) forks the real extension worker as a child, and `grant()` (`:324`) writes the *anchor's* pid into `state/.lock`. The extension reads that pid (`readLockPid`, `fm-branch-supervision.ts:415`) and decides ownership solely by walking its own ancestry with `ps -o ppid=` (`parentPid`/`parentPidSync`, `:376-386`; `lockOwnership`/`lockOwnershipSync`, `:435-466`), depth-limited to 8.

I checked the delivery path really consumes that authority, not a cached hint: `generationOwnsLock` (`:949`, async) gates `readUnprocessedOutcomes` and `actingAsOwner` (`:989`), and `generationOwnsLockSync` (`:959`) re-reads ownership inside `appendDurableOutcome` (`:1422`). I could not make a non-owner deliver: in `real-lock-ownership` the secondary and the previous owner are inert (asserted in the probe), and in my shared-lock attack three consumers that all resolved `owned` still produced exactly one record.

Could not make a real owner go inert incorrectly either, in the exercised depth (1-2). The only residual is the hard-coded depth of 8 (`:413`) — an owner more than 8 ancestors below the named pid would silently read as inert. Not reachable in the lab; see "Uncovered".

### 2. Honest baseline

Content is honest: the guard really extracts the pre-Phase-1 extension from `1f3e7696` (`fm-pi-phase1-pilot.test.sh:45-50`) and the probe loads it in the same lab, renders the same flag-off shape, and compares the bodies with `Buffer.equals` (`pi-phase1-probe.mjs:510`). My run with `FM_PHASE1_OUTPUT` reported `baselineCompare="identical"` and both SHAs `8d9343...`, matching the doc.

But the gate is dishonest at the enforcement level. The comparison lives inside a `try` whose `catch` (`:514-516`) records `baselineCompare = "unavailable: ..."` and pushes a residual, and the probe then prints `PHASE1_PROBE_COMPLETE verdict=PASS`. I mutated the in-lab baseline's plain-note body and re-ran: exit 0, `verdict=PASS`, `baselineCompare="unavailable: the flag-off body must be byte-identical to the pre-Phase-1 baseline extension"`. So a real baseline mismatch does not fail the run. (A plain body regression is still caught by the separate hard-coded `EXPECTED_PLAIN_BODY` assertion at `:503`, which is outside the `try`; the pre-Phase-1 comparison itself is decorative.)

### 3. Soak integrity

Both pause points and both handover orders genuinely occur — I instrumented the cycle loop and printed the pair for each cycle (`/tmp/verify/probe-instrumented.mjs`):

```
SOAK_CYCLE i=0 pausePoint=pause-after-write  handoverOrder=[1,2] first=0
SOAK_CYCLE i=1 pausePoint=pause-before-write handoverOrder=[0,2] first=1
SOAK_CYCLE i=2 pausePoint=pause-after-write  handoverOrder=[0,1] first=2
SOAK_CYCLE i=3 pausePoint=pause-before-write handoverOrder=[2,1] first=0
SOAK_CYCLE i=4 pausePoint=pause-after-write  handoverOrder=[2,0] first=1
SOAK_CYCLE i=5 pausePoint=pause-before-write handoverOrder=[1,0] first=2
```

Two caveats the doc does not state:

- `pausePoint` and `handoverOrder` are both driven by `i % 2` (`:546,:548`), so they are perfectly correlated. Only two of four combinations are ever exercised (after-write with `[second,third]`, before-write with `[third,second]`).
- On the `pause-before-write` path the owner is stopped *after* its reservation but *before* its append, and it stays alive; a successor therefore sees `owner alive` and defers (`reservationReclaimable`, `:1530-1536`) rather than reclaiming. The soak's "reservation with no record behind it" case is only a defer, never a `reclaimReservation`. Reclaim is exercised by the F09 live probe and by my forced-death attack, not by this soak.

I re-ran the soak at 60 cycles: 60/60 completed, `totalRecords=60`, `totalDeliveries=60`, 0 duplicates, 0 losses, exit 0. I could not force a duplicate or a loss.

I attacked both unclaimed schedules with a modified probe (`/tmp/verify/probe-sharedlock.mjs`). Naming the common ancestor (the probe controller, `process.pid`) in `state/.lock` makes all three consumers resolve `owned` at once (measured chain `2710806<-2710788<-2700228`, lock=`2700228`); the O_EXCL reservation marker (`commitDelivery`, `:1208`) still serialized them to one record. Hard-killing an owner while its reservation was `reserved` with no durable record, then letting the next owner reclaim under the same lock pid, settled at `records=1 cursor=1 unread=0` with no stray marker. Neither produced a duplicate or a loss.

### 4. Byte-for-byte default and frozen append

`defaultPresentation.sha256` = `baselinePresentation.sha256` = `8d9343...`; the flag-off home never creates `state/.branch-outcomes-delivered` (`:503-505`). The pilot commit does not touch the extension, `bin/fm-branch-outcome.sh`, or `runtime/pi-durable/src/` (`git diff-tree --name-status` shows three added files). Both pass.

### 5. Shipped suites

All re-ran green (table above).

## New issues

**I1 — Baseline comparison cannot fail the run (harness defect; recommended fix).**
`tests/assets/pi-phase1-probe.mjs:508-516`. The `assert.equal` proving `baseline === current` is inside a `try` whose `catch` downgrades *any* failure — including that assertion — to `baselineCompare="unavailable: ..."` plus a residual, and the probe still emits `verdict=PASS`. Evidence: mutating the in-lab baseline body still exits 0 with `verdict=PASS` and `baselineCompare="unavailable: the flag-off body must be byte-identical to the pre-Phase-1 baseline extension"`. Fix: catch only genuine load/import errors (or narrow the catch to the `captureDefaultPresentation(baseline)` import), and after the `try/catch` assert `report.baselineCompare === "identical"` when a baseline path was provided. Without this the doc's "compared byte-for-byte against the pre-Phase-1 extension" evidence is not enforced.

**I2 — Soak duplicate metric dedups by `seq:deliveryId`.** `homeRecords` is `new Set(...).map(entry => \`${seq}:${deliveryId}\`).size` (`pi-phase1-probe.mjs:218,245`), and the soak only asserts `homeRecords > 1` for duplicates (`:563`). Two durable records that share a delivery identity would collapse to a set size of 1 and be invisible, even though `homeDeliveryEntries` (the actual entry count) would be 2. The soak also never asserts `totalDeliveries === cycles` or `totalRecords === totalDeliveries`, so the doc's "20 records vs 20 deliveries" is reported but not gated. I could not reach a same-`deliveryId` duplicate, so this is a detection-strength gap, not a reproduced bug. Suggested hardening: count raw durable entries, and assert `soak.totalDeliveries === soak.cyclesCompleted`.

**I3 — Soak pause point and handover order are correlated.** `:546,:548`. Only 2 of 4 combinations occur. Cheap fix: derive one of the two from a second independent dimension (e.g. `handoverOrder` from `Math.floor(i/2) % 2`).

**I4 — `reclaimReservation` is not exercised by the soak.** Only a live-owner defer occurs on the `pause-before-write` path (see Q3). The F09 live probe covers reclaim; noting it so the soak's coverage is not over-read.

**I5 — Hard ancestry depth of 8.** `fm-branch-supervision.ts:413`. An owner more than 8 ancestors below the pid named in `state/.lock` reads as inert without any diagnostic. Not reachable in the pilot (depth 1-2) and untested.

## What remains uncovered

- The two schedules the doc already scopes out: free-running multi-process reclaim with no lock change, and same-generation reclaim where two processes both resolve the lock as owned. I attacked both and found no duplicate/loss, but they remain untested by the shipped pilot.
- Reclaim while the owner is alive but has lost the lock (the doc's liveness residual). Confirmed by code reading only.
- Filesystem without atomic `linkSync`/`renameSync`, cross-device marker directories, PID reuse, non-Linux `ps` output, and ancestry depth > 8.
- No CI wiring: `rg -n 'phase1|PHASE1' .github/` returns nothing, so the 0/0 result is a point-in-time opt-in run, not a regression guard.

## Recommendation

The 0-duplicate/0-loss runtime claim is independently confirmed: the lock protocol is the real `ps`-walked ancestry, the flag-off path is byte-identical to the pre-Phase-1 extension, and neither the shipped 60-cycle soak nor my forced shared-ownership and stale-owner-reclaim attacks produced a duplicate or a loss. However, the task explicitly required confirming that a body/behavior change would fail the baseline comparison, and it does not: a real baseline body mismatch still yields `verdict=PASS`. That is a defect in the pilot harness (the deliverable under test), with a small, clear fix (I1); I2/I3 are cheap hardening in the same file. No runtime/extension change is needed.

HOLD - IMPLEMENTATION
