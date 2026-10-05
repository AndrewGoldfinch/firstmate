# Real-SDK routine delivery probe

Decision: **HOLD - IMPLEMENTATION** under the six end-to-end delivery invariants.
The same-file F09 recovery mechanism works under normal persistence, but no-loss and stale-owner safety do not hold in the controlled cases below.
This supersedes the conditional promotion recommendation in [verification 12](12-delivery-verification-2.md), without changing the frozen durable implementation.

## Scope and method

Verified 5 October 2026 against FirstMate `8c68eaa8`, Pi coding-agent `1.0.0`, Node `v22.21.1`, Linux, and a non-root user.
The probe extends the existing [live-SDK suite](../../tests/fm-pi-branch-live-e2e.test.sh) with a [controller and consumer helper](../../tests/assets/pi-f09-probe.mjs).
The suite's fixture also needed its missing `fm-execution-provider.ts` dependency copied before the current extension could load.

Every consumer uses the real `DefaultResourceLoader`, `ExtensionRunner`, `AgentSession`, disk-backed `SessionManager`, and headless `InteractiveMode` transcript renderer.
The unchanged FirstMate extension performs reconciliation and invokes the real outcome scripts.
The controller independently reads session JSONL, outcome JSONL, and the read cursor; consumer snapshots report memory records and actual rendered text separately.
Reopening an existing presentation is not counted as a new delivery merely because it is rendered again after restart.

One routine note is committed directly through the real outcome store before each experiment.
Repeating its operation-keyed append returns the same sequence, and every observation confirms exactly one stored outcome row.
This exercises the delivery consumer of a committed note; it does not run a durable sidecar or a model to produce that note.
The real branch extension receives `session_start` through SDK binding and a deterministic `turn_end` retry through the real extension runner.
No model is selected for a request, no model is prompted, and the probe rejects `fetch` calls.

The parent controller survives each consumer's `SIGKILL` and verifies the process exit signal before starting recovery.
A one-shot executable shim returns failure for the real `mark-read` invocation after delivery, leaving the cursor unchanged.
The write-failure case changes only its initialized temporary session file to read-only and observes an actual `EACCES` from the SDK's append.
No production persistence or delivery function is replaced.

## Observed results

All rows below retain one stored outcome.
"Disk copies" counts presentation records across the destination session files, not outcome rows or SDK send calls.

| Case | Observation before restart or takeover | Observation after recovery | Result |
| --- | --- | --- | --- |
| Default delivery, failed cursor write, same-file restart | 1 disk copy, 1 rendered copy, unread = 1 | 2 disk copies, 2 rendered copies, unread = 0 | Original F09 duplicate reproduced |
| Durable delivery, failed cursor write, same-file restart | 1 disk copy, 1 rendered copy, unread = 1 | 1 disk copy, 1 rendered copy, unread = 0 | Same-file F09 recovery confirmed |
| Durable delivery on a fresh session without conversation | 1 memory record and rendered copy, 0 disk copies, cursor = 1 | After SIGKILL: 0 disk copies, 0 rendered copies, unread = 0 | Acknowledged presentation disappears on restart |
| Durable delivery after session-file write denial | EACCES; 1 memory record, 0 disk copies, 0 rendered copies, unread = 1 | Permissions restored; retry acknowledges without writing; restart has 0 disk or rendered copies and unread = 0 | Committed note is never rendered and is no longer recoverable through unread reconciliation |
| Durable delivery, failed cursor write, replacement session | Original session has 1 disk and rendered copy, unread = 1 | New session receives 1 more disk and rendered copy; aggregate disk copies = 2 | Duplicate for a home-wide logical delivery; destination-change policy remains unresolved |
| Ownership replaced while old consumer is stopped before its session-file append | Replacement writes and renders 1 copy; cursor = 1 | Resumed old consumer writes another copy and renders it despite no longer owning the lock | Stale delivery and concurrent double-delivery reproduced |

The takeover case first checks a non-vacuous refusal control: with the replacement already owning the lock, starting the old consumer produces no presentation and leaves the note unread.
For the adversarial schedule, the controller assigns the old consumer ownership, stops it immediately before the actual session-file append, verifies its stopped process state, assigns ownership to the replacement, and waits for the replacement's delivery before resuming the old process.
The filesystem hook only supplies this pause; the SDK performs both appends.
The observed stale consumer PID differs from the independently read current lock PID when its second record and rendered note appear.

Both consumers share the same destination file in that case.
Each live consumer renders one copy, and the file contains two custom records for the same outcome sequence.
This does not claim two copies will render after reopening that branched session tree.
The experiment injects replacement by changing the isolated home's authority record; it does not prove that the production lock-acquisition command permits takeover of a stopped live owner.

## What the passing command means

This is a characterization probe that asserts the current positive control and counterexamples.
Exit 0 means the experiment completed and reproduced its expected observations, **not** that the delivery invariants pass.
The machine-readable result and final output say `HOLD`.
An unexpected result produces `PROBE_FAILED`, retaining partial observations when an output file was requested.
When a future repair changes these outcomes, its acceptance expectations must replace the affected characterization assertions rather than preserve the bug as desired behavior.

The script header owns command options.
The focused invocation is:

```sh
FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 \
  FM_PI_F09_OUTPUT=/tmp/pi-f09-observations.json \
  bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh
```

The result records the source commit, hashes of the extension and probe, SDK/Node versions, timestamp, PIDs, process termination signals, per-stage disk/memory/render counts, cursor, and fault observations.
The live-suite temporary home is removed after the run; use the output option to retain the observations.
The explicit opt-in is inherited from the surrounding live-SDK suite.
The permission fault intentionally fails its assertions if the runner can bypass Unix file permissions, such as a root process.

Validation performed:

- Focused real-SDK probe completed with `verdict=HOLD`; an independent reviewer reran it and reproduced every counterexample.
- Full live-SDK suite completed with exit 0 and no gate skips, including its existing provider, model/effort, rendering, streaming, and retry tests.
- Shell syntax, Node syntax, and pinned ShellCheck passed.

## Smallest delivery mechanism to investigate next

The source outcome already acts as a durable pending-delivery record while its cursor is behind.
Keep that append/idempotency path unchanged.
The destination's rendered custom entry can remain the delivery record; an additional acknowledgement table alone would leave the same effect-before-receipt uncertainty.

Three obligations remain at that boundary:

1. **Prove destination persistence before acknowledging.**
   Do not infer it from `getEntries()`.
   A failed or deferred append must leave the note recoverable, and a poisoned in-memory entry must not suppress a required write or render.
   Simply holding the cursor forever on a fresh session avoids loss but does not provide eventual delivery; the mechanism needs a supported persistence/retry path.
   Apply the shared persistence correction to routine and captain entries where their contracts overlap.
2. **Keep delivery identity and destination stable through recovery.**
   Bind the outcome's home/store identity and sequence to an explicit presentation target that survives consumer replacement.
   Decide whether a new conversation is a different intended recipient or a new view of the same delivered note; the current session-only lookup cannot silently satisfy both interpretations.
3. **Enforce authority and uniqueness at the destination commit.**
   A pre-write generation check and an in-process queue are insufficient when a process pauses after the check.
   Serialize destination lookup/append with owner replacement, or use a destination that enforces a fencing generation and idempotency key atomically.
   The new takeover probe must reject the old consumer's append and render while preserving the replacement's one recoverable presentation.

These are requirements for the next design, not changes implemented by this probe.
No Phase 1 work, production delivery fix, or runtime adapter edit is included.

## Limits

There is no live model turn or terminal session in the focused probe.
Its renderer is the actual SDK renderer exercised headlessly; its lifecycle events and failure schedule are controlled by the test.
It does not test fresh-session streaming, arbitrary external notification services, host power loss, filesystem corruption, or the complete production ownership handover protocol.
The controller's counts distinguish persisted records, live presentation, and cursor state; they do not imply a human actually read the note.
The runtime append mechanism remains source-identical and is not re-proven by a full runtime-suite run here.
