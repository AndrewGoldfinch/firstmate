# Pi Durable evaluation report (P2)

Generated 2026-10-05T15:27:01.784Z.

## Decision

Decision: HOLD - SCOPE / IMPLEMENTATION. The prototype successfully validates durable/idempotent outcome persistence, but that mechanism does not address the documented duplicate-delivery failure because routine-note presentation occurs downstream in a shared non-idempotent consumer.
Scope: this report is the Durable Outcome lab artifact. The live Durable Delivery status and the Phase 1 gate are owned by docs/pi-durable/09-roadmap.md, 13-real-sdk-delivery-probe.md, and 14-delivery-boundary-fix.md; the real-SDK probe (tests/assets/pi-f09-probe.mjs) supersedes this harness for the delivery question.

Decision rule: advance to Phase 1 if and only if independent observation shows the existing path can produce duplicate externally visible outcomes under the tested fault, durable execution prevents them across the adversarial interleavings, the stale-owner test is non-vacuous, and the dedup-disabled control still recreates the failure. Operator burden is not part of the gate. Recovery time is an observation, not a claimed benefit.
Residual risk carried forward verbatim: "full Pi integration fidelity has not been empirically validated because the live SDK cannot be exercised in the prototype environment; Phase 1 must validate this against the real execution path before broader adoption."

## Environment and scope

Node v22.21.1; local Linux host; deterministic responder for both arms; arm A drives the real wake queue, claim rules, and append-only outcome store; disposable-container teardown lane (SIGKILL, remove, recreate with its own namespaces) for the process-crash and store-reopen boundaries; bounded real-model pilot when a provider credential is reachable
A disposable-container restart lane provides the process-crash and store-reopen boundaries; no real VM or OS reboot boundary exists, and every case this environment cannot exercise is recorded as not-covered, never faked.
Arm A is the real pinned existing Pi supervision path as far as this environment allows: it drives the real wake queue and lease/claim rules (bin/fm-wake-lib.sh, bin/fm-branch-dispatch.mjs) and the real append-only outcome store (bin/fm-branch-outcome.sh).
Arm B is the real durable sidecar, bridge, and outcome sink with the same deterministic responder.
A full Pi AgentSession cannot be driven headlessly here, so arm A's wake is answered by the deterministic responder rather than a Pi model turn; the wake queue, claim rules, and outcome store it drives are the real ones.
Correctness criteria are met for every fault class this environment can execute; the corrected benefit experiment clears the promotion gate in the reduced model, with the residual full-Pi-fidelity risk below.
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
| accept a stale-owner action | yes |

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
docker run -d --name <lane> --rm --user 1000:1000 -e FM_HOME=/home -v /home/andy/dev/firstmate:/repo:ro -v <workdir>/home:/home -w /repo/runtime/pi-durable fm-pi-durable-lane:local node eval/docker-lane-container.ts serve /home /repo/bin/fm-branch-outcome.sh
```

```sh
docker run --rm --user 1000:1000 -e FM_HOME=/home -v /home/andy/dev/firstmate:/repo:ro -v <workdir>/home:/home -w /repo/runtime/pi-durable fm-pi-durable-lane:local node eval/docker-lane-container.ts verify /home /repo/bin/fm-branch-outcome.sh
```

## Bounded real-model pilot

Status: pass.
Provider opencode-go, model muse-spark-1.3-contributor; 6 calls in 18163 ms with 0 timeouts.
Both arms ran against the same real model answers, so the arms differ only in execution durability; arm A completed=true, arm B completed=true.
The model matched the fixture's required disposition on 6 of 6 tasks, so a real model does not simply reproduce the fixture.

| Task | Verdict | Latency | Answer |
| --- | --- | --- | --- |
| T1 | routine | 3113 ms | disposition=ready_for_review; tests pass, awaiting review |
| T2 | routine | 3351 ms | disposition=surface_failure; worker claims completion but CI has failing case |
| T3 | routine | 3839 ms | disposition=working; heartbeat shows progress |
| T4 | captain | 1373 ms | disposition=escalate_decision; needs captain-owned decision |
| T5 | captain | 4590 ms | disposition=recover_or_escalate; worker exit with incomplete result needs recovery |
| T6 | routine | 1896 ms | disposition=preserve_state; duplicate and late older event ignored idempotently |

## Benefit validation (promotion gate)

Status: pass over 30 paired runs. Predeclared N: 30.
Scenario: six-task fleet, fault after the routine note on T3 is delivered and before its cursor write.
Fault: both arms: crash after the routine note on T3 is delivered, before its cursor write; pi-durable additionally loses its owner after settlement on T3 so the settled append is replayed.

| Experiment | Arm A existing | Arm B pi-durable | Difference (A - B) | Verdict |
| --- | --- | --- | --- | --- |
| Duplicate externally visible delivery | 30 duplicates in 30/30 runs (100%, 95% CI 88.6%-100%) | 30 duplicates in 30/30 runs (100%, 95% CI 88.6%-100%) | 0% points, 95% CI -11.4%-11.4% | unproven |
| Recovery time (observation, not a claimed benefit) | median 1161 ms (range 1115-1257) | median 731 ms (range 718-1148) | durable arm median recovery was 731 ms vs 1161 ms for the existing-path model; performance benefit is not claimed because the experiment was designed for correctness rather than latency measurement | observation |

Promotion gate (reduced-model lab result): duplicate externally visible delivery no, durable arm prevented duplicates no, durable replay appends exactly one row yes, stale-owner refusal verified yes, recovery parity yes, dedup-disabled control recreates the failure yes -> not cleared, keep the HOLD decision.
Dedup-disabled causal control (same real store): with an operation key 1 row(s); without one 2 row(s).
Claim status: PROVEN - durable execution prevents duplicate outcome appends caused by replay/retry (arm B's replayed append commits exactly one row per logical note in every run). NOT PROVEN (and currently false for F09) - durable execution prevents duplicate externally visible routine-note delivery (arm B re-presents the same note after the failed cursor write, exactly like arm A).
Stale-owner check: 30 superseded-owner attempt(s), 0 accepted.

| Run | Arm A faulted (ms) | Arm B faulted (ms) | Arm A deliveries | Arm B deliveries | Arm A duplicate deliveries | Arm B duplicate deliveries |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 1142 | 723 | 7 | 7 | 1 | 1 |
| 1 | 1170 | 763 | 7 | 7 | 1 | 1 |
| 2 | 1176 | 738 | 7 | 7 | 1 | 1 |
| 3 | 1134 | 722 | 7 | 7 | 1 | 1 |
| 4 | 1116 | 723 | 7 | 7 | 1 | 1 |
| 5 | 1185 | 727 | 7 | 7 | 1 | 1 |
| 6 | 1115 | 718 | 7 | 7 | 1 | 1 |
| 7 | 1129 | 719 | 7 | 7 | 1 | 1 |
| 8 | 1161 | 831 | 7 | 7 | 1 | 1 |
| 9 | 1210 | 771 | 7 | 7 | 1 | 1 |
| 10 | 1176 | 723 | 7 | 7 | 1 | 1 |
| 11 | 1125 | 733 | 7 | 7 | 1 | 1 |
| 12 | 1168 | 865 | 7 | 7 | 1 | 1 |
| 13 | 1226 | 729 | 7 | 7 | 1 | 1 |
| 14 | 1148 | 721 | 7 | 7 | 1 | 1 |
| 15 | 1164 | 739 | 7 | 7 | 1 | 1 |
| 16 | 1176 | 772 | 7 | 7 | 1 | 1 |
| 17 | 1180 | 767 | 7 | 7 | 1 | 1 |
| 18 | 1164 | 1148 | 7 | 7 | 1 | 1 |
| 19 | 1218 | 749 | 7 | 7 | 1 | 1 |
| 20 | 1150 | 728 | 7 | 7 | 1 | 1 |
| 21 | 1145 | 721 | 7 | 7 | 1 | 1 |
| 22 | 1150 | 730 | 7 | 7 | 1 | 1 |
| 23 | 1144 | 722 | 7 | 7 | 1 | 1 |
| 24 | 1161 | 718 | 7 | 7 | 1 | 1 |
| 25 | 1257 | 793 | 7 | 7 | 1 | 1 |
| 26 | 1175 | 744 | 7 | 7 | 1 | 1 |
| 27 | 1150 | 759 | 7 | 7 | 1 | 1 |
| 28 | 1138 | 721 | 7 | 7 | 1 | 1 |
| 29 | 1131 | 732 | 7 | 7 | 1 | 1 |

Benefit-validation limits:
- arm A is a reduced model of the existing path: the real wake queue, claim rules, and append-only outcome store, plus the branch's unread-row delivery loop, but the deterministic responder instead of a Pi model turn.
- both arms record a delivery at each presentation from the store's unread rows and take the same failed-cursor fault, so both count the externally visible routine-note delivery at the shared delivery boundary.
- arm B's replayed append commits one outcome row per logical note, so the durable append path is observed as idempotent independently of delivery.
- the fault lands once per run on one task; other fault points and interleavings are covered by the correctness matrix, not this benefit sample.
- operator burden is deliberately not measured here and is not part of the gate; a real operator-burden study belongs to Phase 1.
- the recovery-time threshold is derived from this lab's own run-to-run spread, so it is a local noise floor, not a production service-level objective.

## Benefit scorecard (deterministic, calibrated)

| Benefit | Metric | Arm A | Arm B | Status |
| --- | --- | --- | --- | --- |
| Reliable recovery | Correct dispositions / fleet tasks | all | all | parity |
| Duplicate-delivery avoidance | Duplicate externally visible deliveries (paired fault runs) | 30 | 30 | unproven |
| Controlled ownership | Accepted stale-owner actions | 0 | 0 | pass |
| Useful visibility | Recoverable settlements | n/a | 6 | pass |
| Recovery time (observation, not a claimed benefit) | Median faulted-scenario time (ms) | 1161 | 731 | observation |

## Threshold calibration

Status: pass over 10 deterministic runs.
Median scenario time (ms): arm A 1119, arm B 693, arm A faulted 1172, arm B faulted 710.
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
| 1 | 1120 | 704 | 1187 | 710 |
| 2 | 1148 | 696 | 1215 | 729 |
| 3 | 1148 | 715 | 1194 | 706 |
| 4 | 1118 | 689 | 1166 | 700 |
| 5 | 1108 | 686 | 1170 | 709 |
| 6 | 1145 | 703 | 1176 | 728 |
| 7 | 1136 | 690 | 1167 | 725 |
| 8 | 1112 | 691 | 1164 | 703 |
| 9 | 1107 | 688 | 1158 | 696 |
| 10 | 1118 | 702 | 1175 | 711 |

## Raw evidence

The machine-readable per-run records are in [`eval-results.json`](eval-results.json).
Each arm records the outcome rows, adapter operation records, effects, faults, and notes.

## Honest limitations

- Arm A is not a full Pi AgentSession: the wake is answered by the deterministic responder instead of a Pi model turn, so the extension's model-side behavior is not exercised; the wake queue, claim rules, and outcome store it drives are the real ones.
- The deterministic responder returns fixture truth, so this harness measures execution durability, not model judgment.
- F09 is exercised against the real store: a routine note has no durable idempotent record, so a failed cursor write re-presents the already-delivered row. The limitation is pinned by the targeted test and tracked as follow-up `fm-pi-routine-delivery-idempotency-followup-r1`.
- The corrected benefit validation records each externally visible routine-note delivery at the delivery boundary, never from a replay flag: the existing-path model duplicates a delivery under the delivery-before-ack fault while the operation-keyed durable sink delivers once, and the dedup-disabled control appends the same note twice with no key to recreate the duplicate.
- The recreate container runs in its own pid namespace, so the recorded owner pid is not a reliable liveness signal there and the lane reclaims the stale ownership lock explicitly before starting it.
- The container lane is a container and process boundary, not an OS reboot: it proves the store reopens and the recorded authority reconciles after a teardown + recreate, not that a kernel or filesystem failure is survivable.
- The pilot's answers vary between runs, so its disposition match count is one sample rather than a rate.
- The real-model pilot asks one shared set of model answers and replays them through both arms, so it isolates execution durability rather than measuring per-arm model variance; independent per-arm model calls remain the fuller form the design describes.
- The pilot drives the pinned provider directly because the durable conversation seam does not carry the session-affinity header the provider requires, so it does not exercise the prototype's execution seam end to end.
- F16 injects a registered provider with no configured credential and the dispatch refuses with PROVIDER_UNAVAILABLE without invoking the registered fallback executor; F17 is a container process/store restart whose boundary is a container restart, not a host kernel reboot; F18 restores a copy of the adapter store into a different home and the owner refuses to open it (HOME_MISMATCH). F16 and F18 now pass; F17 stays a known-gap because no host reboot is exercised.
- The milestone verification drives two successive wakes, an execution crash with resume, and an ownership replacement through the extension's durable-branch path and the real sidecar; it verifies exactly one outcome per accepted operation, no stale append, and distinct identities. Socket-dependent tests are environment-sensitive (the reviewer's environment blocked Unix-socket listeners with listen EPERM).
- Token and cost comparison and the operator diagnosis study from the design remain out of scope for this pass.
- The calibrated thresholds are derived from this lab's own run-to-run spread, and the deterministic arms are byte-identical workloads, so a measured recovery-time improvement would have to exceed several times the noise floor before it counts as proven.
