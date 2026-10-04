# Pi Durable evaluation report (P2)

Generated 2026-10-04T22:49:19.209Z.

## Environment and scope

Node v22.21.1; local Linux host; deterministic faux model for both arms; disposable-container restart lane for the process-crash and store-reopen boundaries; bounded real-model pilot when a provider credential is reachable
A disposable-container restart lane provides the process-crash and store-reopen boundaries; no real VM or OS reboot boundary exists, and every case this environment cannot exercise is recorded as not-covered, never faked.
Arm A is a reduced model of the existing in-process path: it uses the real outcome store and wake semantics but not the full Pi supervision extension.
Arm B is the real durable sidecar, bridge, and outcome sink with a deterministic faux model.
Correctness evidence is initial contracts tested; important correctness gaps remain, so the prototype stays experimental.
Socket-dependent tests are environment-sensitive: the reviewer's environment blocked Unix-socket listeners (listen EPERM), so a run without socket support records those cases as not-covered rather than passing them.

## Grader scorecard

| Arm | Result | Failed checks |
| --- | --- | --- |
| A existing (no fault) | pass | none |
| B pi-durable (no fault) | pass | none |
| A existing (fault at T3) | fail | every accepted task has an outcome, no lost accepted row |
| B pi-durable (fault during model) | pass | none |

## Grader negative controls

| Corruption | Rejected |
| --- | --- |
| drop one accepted row | yes |
| inject a second effect | yes |
| forge a completion without a receipt | yes |
| change the owner of an acknowledgement | yes |

## F01-F18 fault matrix

| Case | Injection point | Status | Detail |
| --- | --- | --- | --- |
| F01 | before runtime acceptance | pass | crashed=true absentAfterCrash=true retrySeq=1 |
| F02 | after acceptance, before reply | pass | state=accepted retry=none outcomes=1 |
| F03 | conversation identity across restart | pass | conversationId=2 recovered=2 |
| F04 | during a model response | pass | state=accepted outcomes=0 |
| F05 | during a declared safe read | pass | crashed=true replay=safe reran=true attempt=2 stable=true readRecords=2 outcomes=1 undeclaredTool=CAPABILITY_UNKNOWN |
| F06 | after unsafe effect, before receipt commit | pass | reconciled=true outcomes=1 incapableSink=RECONCILE_REQUIRED incapableOutcomes=1 |
| F07 | after runtime settlement, before FirstMate outcome commit | pass | outcomesBeforeRetry=0 reconciled=true replayed=true appendedOnce=true seq=1 |
| F08 | after outcome commit, before adapter receipt | pass | reconciled=true replaySeq=1/1 outcomes=1 |
| F09 | after delivery, before acknowledgement | not-covered | the existing routine-note delivery limitation is documented, not re-tested here |
| F10 | stale generation cannot mutate | pass | code=AUTHORITY_STALE |
| F11 | service crash with valid generation | pass | image=fm-pi-durable-lane:local docker=29.8.2 {"generation":1,"killed":true,"nodeInContainer":"v22.23.3","pid":3508481} |
| F12 | cancellation during tool execution | pass | intentBeforeAbort=true settledCancel=true state=cancelled runOutcome=INTERNAL outcomes=0 retainedState=cancelled unresolvedEffect=outcome-effect-unresolved unresolvedState=cancel-unresolved |
| F13 | second owner refused | pass | refused=true |
| F14 | observer reconnect recovers settlement | pass | settlements=1 |
| F15 | changed payload under repeated ID | pass | code=CONFLICT |
| F16 | credential reachability (named failure not injected) | known-gap | a real opencode-go credential was reachable and used for 6 model calls; the case never injects a missing credential or an incompatible dependency into the sidecar, so the named failure remains unexercised |
| F17 | container process/store restart (host reboot not exercised) | known-gap | image=fm-pi-durable-lane:local docker=29.8.2 {"storeReopened":true,"authorityReconciled":true,"sameConversation":true,"sameGeneration":true,"staleGeneration":"AUTHORITY_STALE","operationState":"settled","receiptSeq":1,"expectedReceiptSeq":1,"outcomeRows":1,"nodeInContainer":"v22.23.3"}; the container restarted but the host kernel kept running, so a real host reboot remains unexercised |
| F18 | wrong-home request refused (store restore not exercised) | known-gap | code=HOME_MISMATCH; the request carried a different homeId and no store was restored into another home, so the restore boundary remains unexercised |

## Disposable-container restart lane

Status: pass.
Image: fm-pi-durable-lane:local; Docker server: 29.8.2.
The failure boundary - SIGKILL and restart - is owned by the host, outside the container.

```sh
docker run -d --name <lane> --rm --pid=host --user 1000:1000 -e FM_HOME=/home -v /home/andy/.treehouse/firstmate-pi-durable-18cae0/1/firstmate-pi-durable:/repo:ro -v <workdir>/home:/home -w /repo/runtime/pi-durable fm-pi-durable-lane:local node eval/docker-lane-container.ts serve /home /repo/bin/fm-branch-outcome.sh
```

```sh
docker run --rm --pid=host --user 1000:1000 -e FM_HOME=/home -v /home/andy/.treehouse/firstmate-pi-durable-18cae0/1/firstmate-pi-durable:/repo:ro -v <workdir>/home:/home -w /repo/runtime/pi-durable fm-pi-durable-lane:local node eval/docker-lane-container.ts verify /home /repo/bin/fm-branch-outcome.sh
```

## Bounded real-model pilot

Status: pass.
Provider opencode-go, model muse-spark-1.3-contributor; 6 calls in 10557 ms with 0 timeouts.
Both arms ran against the same real model answers, so the arms differ only in execution durability; arm A completed=true, arm B completed=true.
The model matched the fixture's required disposition on 5 of 6 tasks, so a real model does not simply reproduce the fixture.

| Task | Verdict | Latency | Answer |
| --- | --- | --- | --- |
| T1 | routine | 1254 ms | disposition=ready_for_review; worker done tests pass awaiting review |
| T2 | routine | 1412 ms | disposition=surface_failure; worker claims completion but CI has failing case |
| T3 | routine | 1299 ms | disposition=working; live worker and heartbeat show progress despite no text output |
| T4 | captain | 1155 ms | disposition=escalate_decision; expired credentials need captain-owned decision |
| T5 | routine | 3803 ms | disposition=surface_failure; worker exit with incomplete result |
| T6 | routine | 1633 ms | disposition=preserve_state; duplicate and late older event handled idempotently |

## Benefit scorecard (deterministic, calibrated)

| Benefit | Metric | Arm A | Arm B | Status |
| --- | --- | --- | --- | --- |
| Reliable recovery | Correct dispositions / fleet tasks | all | all | parity |
| Safe retries | Outcome rows after a fault (total counts, not a duplicate check) | 5 outcomes for 6 tasks | 6 outcomes for 6 tasks | unproven |
| Controlled ownership | Stale-owner actions | 0 | 0 | pass |
| Useful visibility | Recoverable settlements | n/a | 6 | pass |
| Reduced recovery burden | Recorded faults on the faulted fleet (not operator actions) | 1 | 1 | unproven |
| Faster recovery | Median faulted-scenario time (ms) | 322 | 422 | unproven |

## Threshold calibration

Status: pass over 10 deterministic runs.
Median scenario time (ms): arm A 385, arm B 413, arm A faulted 322, arm B faulted 422.
Calibrated thresholds: at least 50% fewer manual recovery actions, at least 30% lower median faulted-scenario time, and healthy-scenario time within 15% of baseline.
Measured noise floor: 1% of the faulted baseline median.
Basis: measured over 10 deterministic runs: median absolute deviation of the faulted baseline is 1% of its median, so the recovery-time threshold is max(30%, 3x noise) and the healthy-latency tolerance is max(15%, 2x noise).
Verdicts: manual recovery actions unproven, recovery time unproven, duplicate outcomes unproven.

## Measurement limits

- manual recovery actions count recorded faults, not operator actions.
- recovery time compares whole scenario wall-clock times whose faulted runs still include missing outcomes.
- duplicate outcomes are compared by subtracting total outcome counts between arms; equal totals do not establish the absence of duplicates.

| Run | Arm A (ms) | Arm B (ms) | Arm A faulted (ms) | Arm B faulted (ms) |
| --- | --- | --- | --- | --- |
| 1 | 375 | 408 | 323 | 420 |
| 2 | 383 | 414 | 320 | 417 |
| 3 | 379 | 412 | 327 | 428 |
| 4 | 399 | 417 | 327 | 429 |
| 5 | 397 | 422 | 322 | 411 |
| 6 | 383 | 411 | 320 | 424 |
| 7 | 390 | 421 | 335 | 430 |
| 8 | 396 | 423 | 328 | 423 |
| 9 | 388 | 409 | 319 | 415 |
| 10 | 377 | 408 | 321 | 412 |

## Raw evidence

The machine-readable per-run records are in [`eval-results.json`](eval-results.json).
Each arm records the outcome rows, adapter operation records, effects, faults, and notes.

## Honest limitations

- Arm A is a reduced model, not the full pinned Pi supervision extension; it demonstrates the durability gap of an in-process owner without durable acceptance, and does not exercise the extension's own recovery.
- The faux model returns fixture truth, so this harness measures execution durability, not model judgment.
- F09 is not covered here: the routine-note delivery limitation is documented rather than re-tested.
- The outcome sink is keyed by the operation identity with an atomic append-or-return-existing, so two distinct operations with identical text no longer collide; the evaluation's duplicate-outcome comparison still only subtracts total outcome counts between arms and does not establish the absence of duplicates.
- The container lane shares the host pid namespace on purpose, because the runtime ownership lock records a pid and treats a live pid as a live owner; a containerized restart inside its own pid namespace would need an explicit lock reclaim first.
- The container lane is a process and store boundary, not an OS reboot: it proves the store reopens and the recorded authority reconciles, not that a kernel or filesystem failure is survivable.
- The pilot's answers vary between runs, so its disposition match count is one sample rather than a rate.
- The real-model pilot asks one shared set of model answers and replays them through both arms, so it isolates execution durability rather than measuring per-arm model variance; independent per-arm model calls remain the fuller form the design describes.
- The pilot drives the pinned provider directly because the durable conversation seam does not carry the session-affinity header the provider requires, so it does not exercise the prototype's execution seam end to end.
- F16 exercises credential reachability, not an injected missing-credential or incompatible-dependency failure; F17 is a container process/store restart, not a host reboot; F18 exercises a wrong-home refusal, not a store restored into another home. Those cases are marked known-gap rather than pass.
- The milestone verification drives two successive wakes, an execution crash with resume, and an ownership replacement through the extension's durable-branch path and the real sidecar; it verifies exactly one outcome per accepted operation, no stale append, and distinct identities. Socket-dependent tests are environment-sensitive (the reviewer's environment blocked Unix-socket listeners with listen EPERM).
- Token and cost comparison and the operator diagnosis study from the design remain out of scope for this pass.
- The calibrated thresholds are derived from this lab's own run-to-run spread, and the deterministic arms are byte-identical workloads, so a measured recovery-time improvement would have to exceed several times the noise floor before it counts as proven.
