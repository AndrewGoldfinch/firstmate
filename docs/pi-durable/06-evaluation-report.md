# Pi Durable evaluation report (P2)

Generated 2026-10-05T03:29:42.725Z.

## Decision

Decision: advance beyond the prototype; Phase 1 adoption remains a captain call.
Benefit validation cleared the promotion gate: durable supervision showed a statistically meaningful reduction in duplicate outcomes or operator intervention under the faulted workload, with recovery parity and zero stale-owner actions.

Promotion gate: advance beyond the prototype only if durable supervision shows a statistically meaningful reduction in duplicate outcomes or operator intervention under faulted workloads, while maintaining recovery parity and zero stale-owner actions.

## Environment and scope

Node v22.21.1; local Linux host; deterministic responder for both arms; arm A drives the real wake queue, claim rules, and append-only outcome store; disposable-container teardown lane (SIGKILL, remove, recreate with its own namespaces) for the process-crash and store-reopen boundaries; bounded real-model pilot when a provider credential is reachable
A disposable-container restart lane provides the process-crash and store-reopen boundaries; no real VM or OS reboot boundary exists, and every case this environment cannot exercise is recorded as not-covered, never faked.
Arm A is the real pinned existing Pi supervision path as far as this environment allows: it drives the real wake queue and lease/claim rules (bin/fm-wake-lib.sh, bin/fm-branch-dispatch.mjs) and the real append-only outcome store (bin/fm-branch-outcome.sh).
Arm B is the real durable sidecar, bridge, and outcome sink with the same deterministic responder.
A full Pi AgentSession cannot be driven headlessly here, so arm A's wake is answered by the deterministic responder rather than a Pi model turn; the wake queue, claim rules, and outcome store it drives are the real ones.
Correctness criteria are met for every fault class this environment can execute; the prototype stays experimental pending benefit validation.
Socket-dependent tests are environment-sensitive: the reviewer's environment blocked Unix-socket listeners (listen EPERM), so a run without socket support records those cases as not-covered rather than passing them.

## Grader scorecard

| Arm | Result | Failed checks |
| --- | --- | --- |
| A existing (no fault) | pass | none |
| B pi-durable (no fault) | pass | none |
| A existing (fault at T3) | pass | none |
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
| F09 | after delivery, before acknowledgement | pass | routineDelivery: append seq=1; a failed cursor write leaves the routine row unread and re-delivered (the documented routine-delivery limitation, tracked as fm-pi-routine-delivery-idempotency-followup-r1); a successful mark-read clears it (unreadAfterAck=0) |
| F10 | stale generation cannot mutate | pass | code=AUTHORITY_STALE |
| F11 | service crash with valid generation | pass | image=fm-pi-durable-lane:local docker=29.8.2 {"generation":1,"killed":true,"nodeInContainer":"v22.23.3","pid":1} |
| F12 | cancellation during tool execution | pass | intentBeforeAbort=true settledCancel=true state=cancelled runOutcome=INTERNAL outcomes=0 retainedState=cancelled unresolvedEffect=outcome-effect-unresolved unresolvedState=cancel-unresolved |
| F13 | second owner refused | pass | refused=true |
| F14 | observer reconnect recovers settlement | pass | settlements=1 |
| F15 | changed payload under repeated ID | pass | code=CONFLICT |
| F16 | missing provider credential refused, no reroute | pass | code=PROVIDER_UNAVAILABLE outcomes=0 fallbackCalls=0; the injected provider has no configured credential and the registered fallback provider was never invoked |
| F17 | container teardown + recreate (host reboot not exercised) | known-gap | image=fm-pi-durable-lane:local docker=29.8.2 {"storeReopened":true,"authorityReconciled":true,"sameConversation":true,"sameGeneration":true,"staleGeneration":"AUTHORITY_STALE","operationState":"settled","receiptSeq":1,"expectedReceiptSeq":1,"outcomeRows":1,"containerRemoved":true,"lockReclaimed":true,"staleOwnerPid":1,"nodeInContainer":"v22.23.3"}; the container was torn down and recreated with its own namespaces, so a real host reboot remains unexercised |
| F18 | restored store refused in another home | pass | code=HOME_MISMATCH; the adapter store copied to a new home is refused because it records a different home identity |

## Disposable-container restart lane

Status: pass.
Image: fm-pi-durable-lane:local; Docker server: 29.8.2.
The failure boundary - SIGKILL, remove, and recreate with fresh namespaces - is owned by the host, outside the container.

```sh
docker run -d --name <lane> --rm --user 1000:1000 -e FM_HOME=/home -v /home/andy/.treehouse/firstmate-pi-durable-18cae0/1/firstmate-pi-durable:/repo:ro -v <workdir>/home:/home -w /repo/runtime/pi-durable fm-pi-durable-lane:local node eval/docker-lane-container.ts serve /home /repo/bin/fm-branch-outcome.sh
```

```sh
docker run --rm --user 1000:1000 -e FM_HOME=/home -v /home/andy/.treehouse/firstmate-pi-durable-18cae0/1/firstmate-pi-durable:/repo:ro -v <workdir>/home:/home -w /repo/runtime/pi-durable fm-pi-durable-lane:local node eval/docker-lane-container.ts verify /home /repo/bin/fm-branch-outcome.sh
```

## Bounded real-model pilot

Status: pass.
Provider opencode-go, model muse-spark-1.3-contributor; 6 calls in 17803 ms with 0 timeouts.
Both arms ran against the same real model answers, so the arms differ only in execution durability; arm A completed=true, arm B completed=true.
The model matched the fixture's required disposition on 5 of 6 tasks, so a real model does not simply reproduce the fixture.

| Task | Verdict | Latency | Answer |
| --- | --- | --- | --- |
| T1 | routine | 1194 ms | disposition=ready_for_review; worker finished tests pass awaiting review |
| T2 | captain | 2000 ms | disposition=surface_failure; worker claims completion but CI has failing case |
| T3 | routine | 1682 ms | disposition=working; heartbeats show progress despite no output |
| T4 | captain | 2762 ms | disposition=escalate_decision; expired credentials requires captain-owned decision |
| T5 | routine | 5043 ms | disposition=surface_failure; worker exit with incomplete result |
| T6 | routine | 5120 ms | disposition=preserve_state; duplicate repeated and late older event ignored |

## Benefit validation (promotion gate)

Status: pass over 30 paired runs. Predeclared N: 30.
Scenario: six-task fleet, fault after the effect on T3 and before acknowledgement.
Fault: existing: crash after outcome append on T3; pi-durable: crash after settlement on T3.
Predeclared operator interventions:
- restart-owner: restart the supervision owner (automatic in both arms, counted as zero operator actions)
- reconcile-effect: reconcile one duplicate applied effect the append-only store cannot remove
- resubmit-work: re-queue one accepted task left without an outcome

| Experiment | Arm A existing | Arm B pi-durable | Difference (A - B) | Verdict |
| --- | --- | --- | --- | --- |
| Duplicate-outcome avoidance | 30 duplicates in 30/30 runs (100%, 95% CI 88.6%-100%) | 0 duplicates in 0/30 runs (0%, 95% CI 0%-11.4%) | 100% points, 95% CI 83.9%-100% | improved |
| Operator burden | 30 interventions / 30 commands; 30/30 runs affected (100%, 95% CI 88.6%-100%) | 0 interventions / 0 commands; 0/30 runs affected (0%, 95% CI 0%-11.4%) | 100% points, 95% CI 83.9%-100% | improved |
| Recovery time | median 940 ms (range 926-1023) | median 412 ms (range 399-440) | 56.2% lower, threshold 30% from a 1% noise floor | improved |

Promotion gate: duplicate reduction yes, operator reduction yes, recovery parity yes, zero stale-owner actions yes -> CLEARED, advance beyond the prototype.

| Run | Arm A faulted (ms) | Arm B faulted (ms) | Arm A duplicates | Arm B duplicates | Arm A interventions | Arm B interventions |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 958 | 430 | 1 | 0 | 1 | 0 |
| 2 | 986 | 431 | 1 | 0 | 1 | 0 |
| 3 | 983 | 440 | 1 | 0 | 1 | 0 |
| 4 | 939 | 412 | 1 | 0 | 1 | 0 |
| 5 | 1023 | 425 | 1 | 0 | 1 | 0 |
| 6 | 940 | 417 | 1 | 0 | 1 | 0 |
| 7 | 926 | 415 | 1 | 0 | 1 | 0 |
| 8 | 935 | 412 | 1 | 0 | 1 | 0 |
| 9 | 942 | 407 | 1 | 0 | 1 | 0 |
| 10 | 927 | 407 | 1 | 0 | 1 | 0 |
| 11 | 936 | 416 | 1 | 0 | 1 | 0 |
| 12 | 945 | 402 | 1 | 0 | 1 | 0 |
| 13 | 932 | 405 | 1 | 0 | 1 | 0 |
| 14 | 950 | 408 | 1 | 0 | 1 | 0 |
| 15 | 932 | 427 | 1 | 0 | 1 | 0 |
| 16 | 948 | 419 | 1 | 0 | 1 | 0 |
| 17 | 937 | 412 | 1 | 0 | 1 | 0 |
| 18 | 942 | 412 | 1 | 0 | 1 | 0 |
| 19 | 941 | 408 | 1 | 0 | 1 | 0 |
| 20 | 943 | 415 | 1 | 0 | 1 | 0 |
| 21 | 942 | 410 | 1 | 0 | 1 | 0 |
| 22 | 937 | 404 | 1 | 0 | 1 | 0 |
| 23 | 941 | 409 | 1 | 0 | 1 | 0 |
| 24 | 939 | 408 | 1 | 0 | 1 | 0 |
| 25 | 965 | 412 | 1 | 0 | 1 | 0 |
| 26 | 931 | 406 | 1 | 0 | 1 | 0 |
| 27 | 926 | 399 | 1 | 0 | 1 | 0 |
| 28 | 933 | 404 | 1 | 0 | 1 | 0 |
| 29 | 934 | 413 | 1 | 0 | 1 | 0 |
| 30 | 944 | 404 | 1 | 0 | 1 | 0 |

Benefit-validation limits:
- arm A is a reduced model of the existing path: the real wake queue, claim rules, and append-only outcome store, but the deterministic responder instead of a Pi model turn.
- operator interventions are the predeclared reconcile and resubmit actions the arm's post-recovery trace requires; they are not independently executed human commands, and automatic owner restart is not counted.
- the fault lands at one effect boundary on one task per run; other fault points and interleavings are covered by the correctness matrix, not this benefit sample.
- the recovery-time threshold is derived from this lab's own run-to-run spread, so it is a local noise floor, not a production service-level objective.

## Benefit scorecard (deterministic, calibrated)

| Benefit | Metric | Arm A | Arm B | Status |
| --- | --- | --- | --- | --- |
| Reliable recovery | Correct dispositions / fleet tasks | all | all | parity |
| Safe retries | Duplicate applied effects (paired fault runs) | 30 | 0 | improved |
| Controlled ownership | Stale-owner actions | 0 | 0 | pass |
| Useful visibility | Recoverable settlements | n/a | 6 | pass |
| Reduced recovery burden | Operator interventions under the predeclared rule | 30 | 0 | improved |
| Faster recovery | Median faulted-scenario time (ms) | 940 | 412 | improved |

## Threshold calibration

Status: pass over 10 deterministic runs.
Median scenario time (ms): arm A 819, arm B 403, arm A faulted 873, arm B faulted 412.
Calibrated thresholds: at least 50% fewer manual recovery actions, at least 30% lower median faulted-scenario time, and healthy-scenario time within 15% of baseline.
Measured noise floor: 1% of the faulted baseline median.
Basis: measured over 10 deterministic runs: median absolute deviation of the faulted baseline is 1% of its median, so the recovery-time threshold is max(30%, 3x noise) and the healthy-latency tolerance is max(15%, 2x noise).
Verdicts: manual recovery actions unproven, recovery time unproven, duplicate outcomes unproven.
These verdicts apply only to the legacy proxy metrics above; the promotion gate is decided by the paired benefit validation.

## Measurement limits

- manual recovery actions count recorded faults, not operator actions.
- recovery time compares whole scenario wall-clock times whose faulted runs still include missing outcomes.
- duplicate outcomes are compared by subtracting total outcome counts between arms; equal totals do not establish the absence of duplicates.

| Run | Arm A (ms) | Arm B (ms) | Arm A faulted (ms) | Arm B faulted (ms) |
| --- | --- | --- | --- | --- |
| 1 | 824 | 402 | 864 | 410 |
| 2 | 809 | 401 | 864 | 411 |
| 3 | 819 | 409 | 875 | 425 |
| 4 | 830 | 402 | 876 | 409 |
| 5 | 817 | 403 | 875 | 417 |
| 6 | 811 | 406 | 874 | 413 |
| 7 | 818 | 403 | 871 | 410 |
| 8 | 816 | 405 | 870 | 409 |
| 9 | 820 | 403 | 871 | 414 |
| 10 | 830 | 410 | 886 | 416 |

## Raw evidence

The machine-readable per-run records are in [`eval-results.json`](eval-results.json).
Each arm records the outcome rows, adapter operation records, effects, faults, and notes.

## Honest limitations

- Arm A is not a full Pi AgentSession: the wake is answered by the deterministic responder instead of a Pi model turn, so the extension's model-side behavior is not exercised; the wake queue, claim rules, and outcome store it drives are the real ones.
- The deterministic responder returns fixture truth, so this harness measures execution durability, not model judgment.
- F09 is exercised against the real store: a routine note has no durable idempotent record, so a failed cursor write re-presents the already-delivered row. The limitation is pinned by the targeted test and tracked as follow-up `fm-pi-routine-delivery-idempotency-followup-r1`.
- The outcome sink is keyed by the operation identity with an atomic append-or-return-existing, so two distinct operations with identical text no longer collide; the paired benefit validation measures duplicate applied effects directly with the non-idempotent ledger, and arm A's operation-key-less append duplicates on the post-effect fault while arm B replays without a second effect.
- The recreate container runs in its own pid namespace, so the recorded owner pid is not a reliable liveness signal there and the lane reclaims the stale ownership lock explicitly before starting it.
- The container lane is a container and process boundary, not an OS reboot: it proves the store reopens and the recorded authority reconciles after a teardown + recreate, not that a kernel or filesystem failure is survivable.
- The pilot's answers vary between runs, so its disposition match count is one sample rather than a rate.
- The real-model pilot asks one shared set of model answers and replays them through both arms, so it isolates execution durability rather than measuring per-arm model variance; independent per-arm model calls remain the fuller form the design describes.
- The pilot drives the pinned provider directly because the durable conversation seam does not carry the session-affinity header the provider requires, so it does not exercise the prototype's execution seam end to end.
- F16 injects a registered provider with no configured credential and the dispatch refuses with PROVIDER_UNAVAILABLE without invoking the registered fallback executor; F17 is a container process/store restart whose boundary is a container restart, not a host kernel reboot; F18 restores a copy of the adapter store into a different home and the owner refuses to open it (HOME_MISMATCH). F16 and F18 now pass; F17 stays a known-gap because no host reboot is exercised.
- The milestone verification drives two successive wakes, an execution crash with resume, and an ownership replacement through the extension's durable-branch path and the real sidecar; it verifies exactly one outcome per accepted operation, no stale append, and distinct identities. Socket-dependent tests are environment-sensitive (the reviewer's environment blocked Unix-socket listeners with listen EPERM).
- Token and cost comparison and the operator diagnosis study from the design remain out of scope for this pass.
- The calibrated thresholds are derived from this lab's own run-to-run spread, and the deterministic arms are byte-identical workloads, so a measured recovery-time improvement would have to exceed several times the noise floor before it counts as proven.
