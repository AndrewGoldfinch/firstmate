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
- Deterministic faults: in-flight windows use real `SIGSTOP`, and crashes use real `SIGKILL`.
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

Schedules reached: handover after the durable append and before the commit; handover with the reservation committed and the record not yet written; ownership in both directions of a lock handover.
Schedules not reached: a handover during a free-running multi-process reclaim with no lock change, and a same-generation reclaim where two processes both resolve the lock as owned.

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

## Validation 3: concurrent soak

`soak-concurrent` runs bounded cycles.
Each cycle commits one note, launches three concurrent consumers on three destinations, stops the owner at an in-flight window, hands the lock to both other consumers in turn, returns the lock to the owner, resumes it, and then adopts on the owner's destination.
The pause point alternates between after the durable append and before the record is written, and the handover order alternates, so both a committed reservation with its record on disk and a reservation with no record behind it are exercised.

| Count | Value |
| --- | --- |
| Cycles requested / completed | 20 / 20 |
| Durable records across all homes | 20 |
| Externally visible deliveries | 20 |
| Duplicates | 0 |
| Losses | 0 |
| Soak wall clock | 60.7 s |
| Slowest cycle | 3.17 s |

Every cycle settled with exactly one durable home-wide record per committed note, one visible delivery, cursor 1, unread 0, and no marker left behind.

## Regression suite

- `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `exit=0`, `F09_PROBE_COMPLETE verdict=PASS`, 43.4 s.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> `exit=0`, 76.4 s.
- `(cd runtime/pi-durable && npm ci && npm test)` -> 81 pass, 0 fail.
- `FM_PI_PHASE1_PILOT=1 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh` -> `exit=0`, `PHASE1_PROBE_COMPLETE verdict=PASS`, 73.1 s.

Lab identity: Pi `1.0.4`, Node `v22.21.1`, `linux`, extension SHA-256 `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09`, probe SHA-256 `f3151ea0bd5608282a575288c79d02f54d3b4dbcf7fe8d92f47ccfa19aaa66f5`.

## Residuals

The option-2 contract still permits an already-authorized in-flight delivery to finish and be adopted after takeover, so the "a superseded owner cannot deliver" invariant is not met.
The no-loss/no-duplicate claim stays scoped to the schedules exercised here and does not extend to free-running multi-process reclaim.
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

`FM_PHASE1_CYCLES` and `FM_PHASE1_SOAK_SECONDS` bound the soak; `FM_PHASE1_OUTPUT` retains the raw JSON observations, and `FM_PHASE1_BASELINE_PLUGIN` overrides the baseline extension used for the byte-for-byte comparison.
