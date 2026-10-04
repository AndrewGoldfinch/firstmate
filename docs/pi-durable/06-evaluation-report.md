# Pi Durable evaluation report (P2)

Generated 2026-10-04T13:59:06.894Z.

## Environment and scope

Node v22.21.1; local Linux host; no VM or reboot boundary; deterministic faux model
No real VM or reboot boundary exists in this environment, so machine-recovery cases are recorded as not-covered, never faked.
Arm A is a reduced model of the existing in-process path: it uses the real outcome store and wake semantics but not the full Pi supervision extension.
Arm B is the real durable sidecar, bridge, and outcome sink with a deterministic faux model.

## Grader scorecard

| Arm | Result | Failed checks |
| --- | --- | --- |
| A existing (no fault) | pass | none |
| B pi-durable (no fault) | pass | none |
| A existing (fault at T3) | fail | every accepted task has an outcome, no lost accepted row |
| B pi-durable (fault during model) | fail | every accepted task has an outcome |

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
| F02 | after acceptance, before reply | pass | state=accepted retry=RECONCILE_REQUIRED |
| F03 | conversation identity across restart | pass | conversationId=2 recovered=2 |
| F04 | during a model response | pass | state=accepted outcomes=0 |
| F05 | during a declared safe read | not-covered | the prototype has no read-tool boundary to rerun |
| F06 | after unsafe effect, before receipt commit | pass | replay=RECONCILE_REQUIRED outcomes=1 |
| F07 | after runtime settlement, before FirstMate outcome commit | known-gap | the settled candidate is replayable, but the adapter cannot prove the outcome effect is absent, so it refuses a blind append and requires reconciliation |
| F08 | after outcome commit, before adapter receipt | pass | replayed=true seq=1/1 outcomes=1 |
| F09 | after delivery, before acknowledgement | not-covered | the existing routine-note delivery limitation is documented, not re-tested here |
| F10 | stale generation cannot mutate | pass | code=AUTHORITY_STALE |
| F11 | service crash with valid generation | not-covered | covered by F02/F04 recovery; a real process crash needs the VM lane |
| F12 | cancellation during tool execution | not-covered | the prototype has no cancellation operation |
| F13 | second owner refused | pass | refused=true |
| F14 | observer reconnect recovers settlement | pass | settlements=1 |
| F15 | changed payload under repeated ID | pass | code=CONFLICT |
| F16 | missing credentials or incompatible dependency | not-covered | a real credential provider is unavailable; the unknown-capability refusal is covered by the P1B suite |
| F17 | disposable host reboot | not-covered | no VM or reboot boundary exists in this environment |
| F18 | store restored into a different home | pass | code=HOME_MISMATCH |

## Benefit scorecard (deterministic, provisional)

| Benefit | Metric | Arm A | Arm B | Status |
| --- | --- | --- | --- | --- |
| Reliable recovery | Correct dispositions / fleet tasks | all | all | parity |
| Safe retries | Duplicate outcomes after a fault | 5 outcomes for 6 tasks | 5 outcomes for 6 tasks | unproven |
| Controlled ownership | Stale-owner actions | 0 | 0 | pass |
| Useful visibility | Recoverable settlements | n/a | 6 | pass |
| Reduced recovery burden | Manual recovery actions on the faulted fleet | 1 | 1 | not worse |

## Raw evidence

The machine-readable per-run records are in [`eval-results.json`](eval-results.json).
Each arm records the outcome rows, adapter operation records, effects, faults, and notes.

## Honest limitations

- Arm A is a reduced model, not the full pinned Pi supervision extension; it demonstrates the durability gap of an in-process owner without durable acceptance, and does not exercise the extension's own recovery.
- The faux model returns fixture truth, so this harness measures execution durability, not model judgment.
- F05, F09, F11, F12, F16, and F17 are not covered here: no read-tool boundary, no cancellation operation, no real credential provider, and no VM or reboot boundary.
- F08 is a known cross-store gap: a receipt lost between the outcome append and the adapter record can duplicate on retry, which the design requires reconciling.
- The operator diagnosis study, real-model pilot, token/cost comparison, and maintainability inventory from the design are out of scope for this deterministic environment.
- The improvement thresholds are not calibrated here; the deterministic runs are a conformance pilot, not evidence of a performance difference.
