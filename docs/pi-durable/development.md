# Pi Durable development and verification commands

Verified on 2026-10-03 against the pinned baseline and experiment head (see `05-p0-source-verification.md`).
This file records only commands that were actually run; add new verified commands here as P0 completes.

## Checkout and pins

The prototype develops in the FirstMate fork on `experiment/pi-durable-supervision`, with the fork's default branch kept aligned to upstream.

| Item | Value |
| --- | --- |
| Upstream remote | `upstream` = `https://github.com/kunchenguid/firstmate` |
| Fork remote | `origin` = `git@github.com:AndrewGoldfinch/firstmate.git` |
| Experiment branch | `experiment/pi-durable-supervision` |
| Baseline branch | `origin/experiment/pi-durable-baseline` |
| Baseline commit | `1f3e769616fdf9f31f85f4c3e6a9f71606634238` (equals upstream `main` at P0 start) |
| Experiment head at P0 start | `a40b9e375330773e61fcf19bdb894e31ed96d3eb` (design docs only) |

```sh
git clone git@github.com:AndrewGoldfinch/firstmate.git <dir>
git -C <dir> remote add upstream https://github.com/kunchenguid/firstmate
git -C <dir> fetch --all --prune
git -C <dir> checkout -B experiment/pi-durable-supervision origin/experiment/pi-durable-supervision
```

## Toolchain

| Tool | Version observed | Notes |
| --- | --- | --- |
| Node | v22.21.1 (nvm) | runs the Pi extensions |
| `pi` | 1.0.0 | installed at `/home/andy/.nvm/versions/node/v22.21.1/bin/pi` |
| `@earendil-works/pi-coding-agent` | 1.0.0 | global npm install |
| `@earendil-works/pi-durable` | 1.0.1 | the Durable runtime library (not a `pi` subcommand) |
| `@earendil-works/pi-ai` / `@earendil-works/chord` | 1.0.1 / 1.0.1 | Durable dependencies |
| ShellCheck | 0.11.0 | `bin/fm-lint.sh --required-version`; installed at `~/.local/bin/shellcheck` |
| actionlint | 1.7.12 | `bin/fm-lint-workflows.sh --required-version`; installed at `~/.local/bin/actionlint` |
| Upstream Pi commit (durable/ai/chord) | `a7229ddc21810d6245105978033b7df645ecc2f7` | `gitHead` of all three 1.0.1 packages |
| Node engine floor | `>=22.19.0` | declared by `@earendil-works/pi-durable` |

There is no repository build step: FirstMate is bash `bin/` scripts plus TypeScript Pi extensions under `.pi/` that the Pi runtime loads directly.

## Lint

```sh
bin/fm-lint.sh                 # single owner of the lint definition (ShellCheck + workflows + backend purity)
bin/fm-lint.sh --required-version
bin/fm-lint-workflows.sh --required-version
```

## Tests

```sh
bin/fm-test-run.sh tests/<subject>.test.sh        # one subject, timed
bin/fm-test-run.sh tests/<a>.test.sh tests/<b>.test.sh
bin/fm-test-run.sh --changed                      # changed-file-informed, bounded concurrency
bin/fm-test-run.sh --all                          # deliberate full regression (not the gate Test step)
```

`CONTRIBUTING.md` and `docs/fm-test-portable-shards.md` own the full runner contract.

## Baseline capture (2026-10-03)

Pinned supervision-branch tests, run from the experiment checkout:

```sh
bin/fm-test-run.sh tests/fm-branch-supervision.test.sh tests/fm-pi-branch-extension.test.sh
```

Result: `FM_TEST_SUMMARY total=2 failed=0`, ~94 s wall (2026-10-03T23:16Z). Both subjects passed.

Lint:

```sh
bin/fm-lint.sh
```

Result: passes in changed-file mode (ShellCheck 0.11.0, actionlint 1.7.12; 3 workflow files valid). Full-suite (`--all`) capture is an open P0 item.

Durable probe lab (throwaway, outside this repo):

```sh
mkdir -p ~/dev/pi-durable-lab && cd ~/dev/pi-durable-lab
npm init -y && npm install @earendil-works/pi-durable@1.0.1 @earendil-works/pi-ai@1.0.1 @earendil-works/chord@1.0.1
```

See `05-p0-source-verification.md` for the probe results.

## Deterministic Durable tests (faux model)

No real model or credentials are needed: use Pi's faux provider.

```js
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall("my_tool", {})], { stopReason: "toolUse" }), fauxAssistantMessage("final")]);
```

Note: a turn that calls a tool must set `{ stopReason: "toolUse" }`. With the default `"stop"`, the harness treats the message as the final answer and never runs the tool (observed directly).

## P1A through P1D sidecar (`runtime/pi-durable`)

The P1A service, protocol, and single-owner store lock live in `runtime/pi-durable/`.
It is a Node package with pinned dependencies and no compile step, because Node 22.21.1 runs the TypeScript directly through type stripping.
The service opens the upstream Durable SQLite conversation store through `provider.ts`, keeps its own acceptance and identity store, and binds a private Unix-domain socket per canonical `FM_HOME`.
It is opt-in: the existing Pi supervision path stays the default, and `config/supervision-execution` selects the durable sidecar at the branch execution seam.

P1B adds the durable supervisor binding: conversation identity, a pinned configuration digest over model, thinking level, instructions, cwd, and capability profile, and the current FirstMate authority generation, wake claim, and row set.
`ensureSupervisor` creates or reattaches a dedicated conversation with an explicit narrow agent grant (`extensions` and `tools` empty) instead of adopting the reserved root conversation, so an unrelated root configuration cannot widen it.
`resume` is a guarded mutation: the authority check runs before the harness resume call, and a stale, unknown, conflicting, or out-of-scope binding is refused.
The wire protocol version is 2.

P1C adds the dispatch and outcome bridge: `dispatch` executes one accepted supervision operation on the pinned conversation under current authority and returns its candidate result; `receipt` records the mirrored outcome sequence.
`src/bridge.ts` validates the candidate result, routes it through the existing outcome store (`bin/fm-branch-outcome.sh`), and returns a recorded receipt on a settled repeat instead of appending a conflicting outcome.
`src/selection.ts` reads `config/supervision-execution`; absent or empty selects the existing path, and an unknown value is refused.
`src/bridge-cli.ts` is the subprocess entry point the Pi extension can spawn across the package boundary.
The Pi extension reads the same config value once per session (`.pi/extensions/lib/fm-execution-provider.ts`) and, when it selects `pi-durable`, runs the bridge CLI in place of the in-process branch prompt; the default `existing` path is byte-identical.

P1D adds bounded observation: a durable adapter outbox with `accepted`, `settlement`, and `unresolved` observations, exposed through `observe` (a cursor page) and `observeAck` (a monotonic cursor).
The queue is bounded per home and pruning drops transient observations before settlements; a cursor behind the retained window is refused as a gap; and the cursor cannot advance past a settlement whose delivery receipt is not committed.
A snapshot (`inspect`) or an accepted-but-unsettled operation is never a settlement observation.

```sh
cd runtime/pi-durable
npm ci                 # uses the committed package-lock.json; npm install also works
npm run typecheck      # tsc --noEmit -p tsconfig.json
npm test               # node --test tests/*.test.ts
```

Result on 2026-10-04: `npm run typecheck` exits 0, and `npm test` reports 74 tests, 74 pass, 0 fail.
The suite covers the P1A acceptance gate: two owner processes cannot open one store (in-process and cross-process), a wrong home or an incompatible protocol is refused, a repeated operation ID returns the original acceptance without a new execution, a changed payload or configuration under the same ID is refused, no secret reaches the store file, diagnostics, or a reply, and the message-size and outstanding-operation bounds hold.
It also covers the P1B gate: restart returns to the original operation and conversation, stale work cannot execute a guarded mutation, and a fresh conversation is pinned to the narrow capability profile and cannot inherit an unrelated root configuration.
It also covers the P1C bridge: a malformed candidate result is refused before any outcome is appended, a settled repeat with a receipt appends nothing, a sidecar refusal surfaces as a diagnosable bridge error, the provider selection defaults to the existing path, and an end-to-end dispatch through a real sidecar and the real outcome store appends exactly one outcome.
The pinned Pi extension tests pass with the seam in place, including a `pi-durable` selection that routes one wake through the bridge into the existing outcome sink without running the in-process branch prompt.
It also covers the P1D gate: a subscriber reconnects after missed observations and recovers every undelivered settlement, a snapshot or an accepted-but-unsettled operation is never a settlement, a duplicate settled result produces one observation, and the cursor refuses to advance past a settlement without its receipt.

P2 adds the evaluation harness under `runtime/pi-durable/eval/`: the controlled six-task fleet with fixture truth, a scenario runner for both arms with barrier-based fault injection, an independent grader with four negative controls, the F01-F18 deterministic fault matrix, a disposable-container restart lane, a bounded real-model pilot, threshold calibration, and a report generator.

```sh
cd runtime/pi-durable
npm run eval           # runs the fleet, the F-matrix, the container restart lane, the real-model pilot, and the threshold calibration; writes docs/pi-durable/06-evaluation-report.md and eval-results.json
```

Result on 2026-10-04: `npm test` reports 74 tests, 74 pass, 0 fail, including the harness end-to-end test and the reviewer's milestone verification (`tests/milestone.test.ts`).
`npm run eval` records F01-F18 as 14 pass, 0 fail, 1 not-covered, and 3 known-gap (F16/F17/F18, which exercise credential reachability, a container process/store restart, and a wrong-home refusal rather than the failure their titles once claimed), plus a passing disposable-container restart lane for F11 and F17, a passing bounded real-model pilot, and calibrated improvement thresholds whose benefit verdicts stay unproven.
Both arms pass the no-fault fleet; a fault at one task makes the reduced existing-path arm silently lose that task while the durable arm keeps it unresolved and receipt-gated.
The four grader negative controls are all rejected.
F05, F09, F11, F12, F16, and F17 are explicitly not covered (no read-tool boundary, no cancellation operation, no real credential provider, no VM or reboot boundary); F07 is a known reconciliation gap.
The full results and limitations are in [`06-evaluation-report.md`](06-evaluation-report.md).

## Spike 1 — real-path F09 reproduction (2026-10-05)

Spike 1 retires the real-Pi-fidelity residual risk for F09: the exact sequence `routine note delivered -> cursor write fails -> note stays unread -> re-presented on retry` is driven through the real Pi supervision extension (`.pi/extensions/fm-branch-supervision.ts`, `reconcileUnreadOutcomes` -> `deliverRoutineOutcome` -> `mark-read`), not the `runtime/pi-durable/eval/` reduced model.
The Pi SDK is stubbed at the message boundary exactly as every case in `tests/fm-pi-branch-extension.test.sh` already does; the extension, `bin/fm-branch-outcome.sh`, and the reconcile/deliver/mark-read logic all run for real.
The fault is injected at the one boundary that owns it: a `PATH` shim for `bash` that fails the armed `fm-branch-outcome.sh` subcommand (`mark-read`) once.
No extension production behavior changes and no Prototype 1 durable delivery identity is introduced.

Two cases pin the sequence.
The pre-existing `test_mark_read_failure_keeps_routine_redelivery_and_captain_deduplication` covers the default in-process path: a routine note is delivered once, the cursor write fails leaving the row unread, and the next reconciliation delivers the same logical note again before the cursor advances and the duplication window closes; a captain row stays deduplicated.
The new `test_f09_durable_committed_routine_row_is_re_presented_across_cursor_failure` covers the durable-committed arm that the corrected benefit verification left unmodeled (`10-benefit-verification-2.md`, clause 5): a routine row is committed first through the durable outcome sink (`runtime/pi-durable/src/outcome-sink.ts` uses the same `bin/fm-branch-outcome.sh`) before any presentation, and the shared reconcile consumer re-presents it after the cursor write fails.
That shows the F09 duplicate is a property of the shared presentation consumer, not of the append mechanism, so a durable-committed row is subject to it exactly like an existing-path row.

Commands and observed result (worktree root, 2026-10-05):

```sh
bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh
```

```
FM_TEST_BEGIN 2026-10-05T05:34:14Z tests/fm-pi-branch-extension.test.sh family=standalone expected_gate_skip=none
...
ok - a failed cursor write re-delivers a routine note exactly once more while a captain outcome stays deduplicated
ok - a durable-committed routine row is re-presented once across a failed cursor write, then stays read
FM_TEST_END 2026-10-05T05:35:15Z tests/fm-pi-branch-extension.test.sh exit=0 duration_ms=61858 gate_skip=false
```

Both subjects pass (`exit=0`, 53 subjects, ~62 s wall).
The real Pi path is therefore drivable headlessly, so there is no reduced-model blocker and Prototype 1's promotion gate can be evaluated against this signal.

## Prototype 1 - durable delivery identity (2026-10-05)

The opt-in durable delivery identity is selected by `FM_PI_DURABLE_DELIVERY=1`.
Under it a routine note is delivered exactly like a captain outcome: a sequence-keyed record appended synchronously as a session entry (`VISIBLE_ROUTINE_ENTRY_TYPE`), found again by store sequence on reload, and rendered by a registered entry renderer.
Because the record is written before `mark-read`, the read cursor can only cross a delivery that is already durable.

Independent adversarial verification of commit `3d8cf6c4` returned **HOLD - IMPLEMENTATION** (the report was delivered separately and is not part of this branch).
The first implementation stored the record in the `details` of the custom message that performed the delivery.
On the real Pi path `pi.sendMessage(..., { deliverAs: "nextTurn" })` only queues that message in `_pendingNextTurnMessages`; the `custom_message` session entry is written when the next prompt flushes the queue.
Every `turn_end` reconcile runs while main is still streaming, so `ensureRoutineOutcome` could not see the queued record, delivered a second copy, and advanced `mark-read` over an in-memory delivery.
A crash after the successful `mark-read` and before the flush then lost the note.
The shipped fixture persisted synchronously for every `sendMessage`, so it could not observe any of this.

The fix mirrors the captain path: the routine delivery record is now a synchronous `pi.appendEntry` custom entry rather than a deferred `custom_message` `details` payload, and `ensureRoutineOutcome` verifies it is persisted before returning true.
A changed routine record for the same sequence still fails closed; a silent routine outcome records its identity without rendering.
The default (flag-off) presentation path is byte-identical: the same `fm-branch-merge` custom message with no `details`.

`tests/fm-pi-branch-extension.test.sh` now models Pi's deferral: a `deliverAs: "nextTurn"` message is queued in memory and persisted only by `flushPendingNextTurn()`, so the streaming half of the F09 window is observable.
`test_f09_durable_delivery_identity_streaming_neither_duplicates_nor_loses` runs the whole scenario with `mainStreaming` true: delivery succeeds, the `mark-read` persistence fails, replay does not duplicate, a queue flush changes nothing, recovery advances the cursor, and a genuinely new main session neither re-presents an acknowledged note (it was already delivered) nor drops an unread one (it is re-presented there).
The F09 exactly-once and replay/takeover cases also run with main streaming.

```sh
bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh
```

```
FM_TEST_BEGIN 2026-10-05T06:26:44Z tests/fm-pi-branch-extension.test.sh family=standalone expected_gate_skip=none
...
ok - durable delivery identity makes a committed routine note exactly once while the existing path duplicates
ok - durable delivery identity keeps one delivery across repeated ack failure, replay, and takeover, and separates sequences
ok - streaming durable delivery stays exactly once across a failed ack, a queue flush, and a new session
FM_TEST_END 2026-10-05T06:27:47Z tests/fm-pi-branch-extension.test.sh exit=0 duration_ms=63080 gate_skip=false
```
