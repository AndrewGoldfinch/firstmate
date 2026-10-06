# Phase 1 bounded opt-in pilot

Status: implemented on `experiment/pi-durable-phase1-pilot` (base `402871d1b8e65a0d3db88d2b5db32bfa52bc06cc`).
It promotes Prototype 1 to a bounded, opt-in Phase 1 pilot under option 2, as approved in [`09-roadmap.md`](09-roadmap.md).
Delivery stays opt-in through `FM_PI_DURABLE_DELIVERY`; the default flag-off presentation path is unchanged and is verified byte-for-byte against the pre-Phase-1 extension.
The extension (`.pi/extensions/fm-branch-supervision.ts`), `bin/fm-branch-outcome.sh`, and `runtime/pi-durable/src/` are untouched; the only tracked additions are the pilot harness and this doc.
The pilot does not start broader adoption, does not run a long soak, and keeps the no-loss/no-duplicate claim scoped to the schedules exercised here.

## Pilot protocol

- Opt-in only: every delivered schedule sets `FM_PI_DURABLE_DELIVERY=1`, and the flag-off schedule proves the default path sends the same bytes as before.
- Isolated lab: every home, session file, lock, outcome store, and process lives under `$TMPDIR`, never the running home.
- Real components: the real supervision extension, the real installed `@earendil-works/pi-coding-agent` SDK, the real headless transcript renderer, and the real `bin/fm-branch-outcome.sh` store.
- No model and no network: the SDK is driven through synthetic lifecycle triggers (`session.bindExtensions`, a `turn_end` emit) and `fetch` throws.
- Deterministic faults: in-flight windows and the reclaim claim boundary use real `SIGSTOP`, and crashes use real `SIGKILL`.
- Real lock protocol: `state/.lock` names a live anchor process, each consumer extension process is a descendant of its own anchor, and ownership is decided by the extension's real `ps`-walked ancestry (`lockOwnership`/`lockOwnershipSync`).
- Bounded soak: a fixed cycle count (default 20) and a wall-clock cap (480 s), whichever ends first.
- HOLD rule: any duplicate or loss fails the run and names the failing schedule rather than smoothing it over.

The harness is [`tests/assets/pi-phase1-probe.mjs`](../../tests/assets/pi-phase1-probe.mjs), run by the opt-in guard [`tests/fm-pi-phase1-pilot.test.sh`](../../tests/fm-pi-phase1-pilot.test.sh).
The earlier F09 probe wrote a consumer's own pid into the lock, which resolves ownership at ancestry depth 0 and never exercises the real walk.
This probe inserts a per-consumer anchor process between the controller and the extension worker, so the lock names a real live ancestor and a lock handover is a real change of the process the walk resolves to.

## Validation 1: real lock handover

`real-lock-ownership` drives ownership both directions through the real ancestry walk.
A consumer whose anchor is not named by the lock stays inert even with the row unread and a durable record on disk, and a consumer whose anchor is named delivers exactly once.
Handing the lock from the first anchor to the second makes the first inert and lets the second adopt the committed record and complete the cursor.

`handover-in-flight` replaces a live owner while its delivery is in flight.
The owner stops after its durable append and before its commit, the lock moves to a live successor, the successor defers to the in-flight reservation and commits the marker, and the replaced owner then resumes and finishes its already-authorized delivery under option 2.
A later session on the winner's destination adopts the one committed record and completes the cursor, so there is no loss and no duplicate.

| Schedule | Stage | lock names anchor | cursor | unread | home records | marker |
| --- | --- | --- | --- | --- | --- | --- |
| real-lock-ownership | owner-delivers | yes | 0 | 1 | 1 | committed |
| real-lock-ownership | secondary-is-inert-under-a-lock | no | 0 | 1 | 1 | committed |
| real-lock-ownership | previous-owner-is-inert | no | 0 | 1 | 1 | committed |
| real-lock-ownership | new-owner-adopts-and-completes | yes | 1 | 0 | 1 | cleared |
| handover-in-flight | owner-stopped-after-durable-append | yes | 0 | 1 | 1 | reserved |
| handover-in-flight | successor-defers-to-in-flight-reservation | yes | 0 | 1 | 1 | committed |
| handover-in-flight | replaced-owner-finishes-delivery | no | 0 | 1 | 1 | committed |
| handover-in-flight | adoption-completes-cursor | yes | 1 | 0 | 1 | cleared |

Schedules reached: handover after the durable append and before the commit; handover with the reservation committed and the record not yet written; ownership in both directions of a lock handover; two live processes that resolve the same unchanged lock as owned and both attempt one stale reservation's reclaim claim.
Schedules not reached: none beyond the platform limits recorded under Residuals.

## Validation 2: normal session lifecycle

`lifecycle-durable` runs start, delivery, session end, a fresh session, and a second fresh session on the same destination.
The first session delivers exactly one durable record and advances the cursor; each fresh session adopts that record, renders the one visible copy, and appends nothing.
The session file line count is identical across all three sessions, which is the no-re-delivery proof.

`lifecycle-default` runs the same shape with `FM_PI_DURABLE_DELIVERY=0`.
The delivered presentation body is exactly `` ⛵ fixture: PHASE1_ROUTINE_NOTE ``, the durable ledger directory is never created, and the fresh session appends nothing.
The flag-off body is compared byte-for-byte against the pre-Phase-1 extension extracted from `1f3e7696` and loaded in the same lab; both produced the same bytes and SHA-256.

| Property | Value |
| --- | --- |
| Flag-off body | `` ⛵ fixture: PHASE1_ROUTINE_NOTE `` |
| Flag-off SHA-256 (head) | `8d9343e869b028cf8cb38491de196d55d1def9f8adc92b2b329e441d7ed860cd` |
| Flag-off SHA-256 (baseline `1f3e7696`) | `8d9343e869b028cf8cb38491de196d55d1def9f8adc92b2b329e441d7ed860cd` |
| Durable records / visible deliveries after three sessions | 1 / 1 |
| Durable ledger on the flag-off path | absent |

The baseline comparison is the byte-for-byte evidence: the pre-Phase-1 extension has no durable delivery at all, so an identical body proves the default presentation is unchanged.
The comparison is required and enforced: the guard extracts the pre-Phase-1 extension from `1f3e7696` and fails closed when it is missing, so a run cannot pass with the gate skipped. A body mismatch or a baseline that will not load fails the run and names the mismatch rather than being recorded as a residual on a passing run, and the guard's negative controls mutate the baseline body and remove the baseline to prove the gate can fail on both.

## Validation 3: concurrent soak

`soak-concurrent` runs bounded cycles.
Each cycle commits one note, launches three concurrent consumers on three destinations, stops the owner at an in-flight window, hands the lock to both other consumers in turn, returns the lock to the owner, resumes it, and then adopts on the owner's destination.
The pause point alternates on every cycle (after the durable append, then before the record is written) and the handover order alternates every two cycles, so all four pause-point x handover-order combinations are exercised within four cycles.
The run records each combination it reaches and asserts every cell was reached, each with exactly one durable entry and no duplicate or loss.

| Count | Value |
| --- | --- |
| Cycles requested / completed | 20 / 20 |
| Pause-point x handover-order cells reached | 4 of 4 |
| Durable records across all homes | 20 |
| Externally visible deliveries | 20 |
| Duplicates | 0 |
| Losses | 0 |
| Soak wall clock | 66.7 s |
| Slowest cycle | 3.49 s |

Every cycle settled with exactly one durable home-wide record per committed note, one visible delivery, cursor 1, unread 0, and no marker left behind.
The run also asserts every one of the four pause-point x handover-order cells was reached and holds exactly one durable entry per completed cycle with no duplicate or loss.
The duplicate check counts raw durable entries rather than deduplicated `seq:deliveryId` identities, so two records sharing a delivery identity are visible, and the run asserts one delivered entry per completed cycle and deduplicated records equal to raw entries.

## Validation 4: reclaim claim with no lock change

`reclaim-same-generation` and `reclaim-free-running` close the two reclaim schedules that docs 26-28 left open: a same-generation reclaim where two live processes both resolve the lock as owned, and a free-running multi-process reclaim with no lock change.
Both seed a reclaimable reservation with the real extension: a live owner is stopped before its durable append with a real `SIGSTOP` and killed with a real `SIGKILL`, so its `reserved` marker names a dead owner and no durable record exists.
The unchanged `state/.lock` then names the live controller, a shared ancestor of both consumers, so both consumers' real `ps`-walk resolves the same lock pid as owned with no handover.

`reclaim-same-generation` starts the first lock owner, stops it holding the exclusive `<seq>.claim` link and before its publish, then starts the second lock owner.
The second owner runs the same reclaim, loses the `linkSync` claim, and appends nothing; the resumed first owner publishes the one durable record and one visible delivery, which a later session adopts and completes the cursor.

`reclaim-free-running` starts both lock owners together every round, so whichever wins the claim holds it while the other runs its full reclaim and loses.
Each consumer records its pid when it reaches the claim, so a logged attempt is an owned attempt: a non-owner never reaches `reclaimReservation`.

| Schedule | Stage | home records | visible deliveries | cursor | unread | marker |
| --- | --- | --- | --- | --- | --- | --- |
| reclaim-same-generation | first-reclaimer-holds-claim | 0 | 0 | 0 | 1 | reserved |
| reclaim-same-generation | second-reclaimer-loses-claim | 0 | 0 | 0 | 1 | reserved |
| reclaim-same-generation | claim-holder-publishes-once | 1 | 1 | 0 | 1 | committed |
| reclaim-same-generation | adoption-after-claim-fence | 1 | 1 | 1 | 0 | cleared |
| reclaim-free-running (4 rounds) | loser | 0 | 0 | 0 | 1 | reserved |
| reclaim-free-running (4 rounds) | winner | 1 | 1 | 0 | 1 | committed |
| reclaim-free-running (4 rounds) | adoption | 1 | 1 | 1 | 0 | cleared |

Both schedules recorded both lock owners at the claim in every round and settled at exactly one durable home-wide record and one visible delivery.
The free-running schedule therefore extends the no-loss/no-duplicate claim to the multi-process reclaim it previously scoped out, and the deterministic schedule is the boundary proof; the free-running invariant is exercised across a bounded round count, not every possible interleaving.
The two schedules are distinct: `reclaim-same-generation` starts the second owner only after the first holds the claim, while `reclaim-free-running` starts both together and lets the winner be whichever process the scheduler grants the claim.

## Regression suite

- `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `exit=0`, `F09_PROBE_COMPLETE verdict=PASS`, 43.2 s.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> `exit=0`, 78.4 s.
- `(cd runtime/pi-durable && npm ci && npm test)` -> 81 pass, 0 fail.
- `FM_PI_PHASE1_PILOT=1 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh` -> `exit=0`, `PHASE1_PROBE_COMPLETE verdict=PASS`, 110.8 s, including the two reclaim schedules above.

Lab identity: Pi `1.0.4`, Node `v22.21.1`, `linux`, extension SHA-256 `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09`, probe SHA-256 `61e2420589b4c0684675a02f0b24cd787418df376a52a00246fe49e116bd1e10`.

## Residuals

The option-2 contract still permits an already-authorized in-flight delivery to finish and be adopted after takeover, so the "a superseded owner cannot deliver" invariant is not met.
The no-loss/no-duplicate claim stays scoped to the schedules exercised here, which now include the two reclaim schedules in Validation 4, but not to every possible interleaving or platform.
A live-but-replaced owner that never exits still stalls its row until it does, which is a liveness cost rather than a loss.
A committed reservation whose record lives only in a different destination defers there.
An externally corrupted `.claim` stalls its sequence, which is unreachable through the extension's own writes.
Filesystems without hard-link or atomic-rename support, cross-device marker directories, PID reuse, and non-Linux platforms were not exercised; on those, reclaim would stall rather than duplicate.

## Running the pilot

```sh
FM_PI_PHASE1_PILOT=1 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh
FM_PI_PHASE1_PILOT=1 FM_PHASE1_CYCLES=50 FM_PHASE1_SOAK_SECONDS=300 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh
FM_PI_PHASE1_OUTPUT=/tmp/phase1.json FM_PI_PHASE1_PILOT=1 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh
```

`FM_PHASE1_CYCLES` and `FM_PHASE1_SOAK_SECONDS` bound the soak, and `FM_PHASE1_RECLAIM_ROUNDS` bounds the free-running reclaim rounds; `FM_PHASE1_OUTPUT` retains the raw JSON observations, and `FM_PHASE1_BASELINE_PLUGIN` names the pre-Phase-1 extension used for the byte-for-byte comparison. The baseline is required: the guard extracts it and the probe fails closed when it is absent.
