# P0 source verification and compatibility note

Status: **in progress** - first pass recorded 2026-10-03.
Owner: the Pi Durable project guidance (`AGENTS.md`); plan in `03-implementation-plan.md` (P0).

This note records what was verified against the pinned baseline and experiment head, what is a proposed (not existing) interface, and what remains open.
It makes no claim of prototype implementation or of executed Durable integration tests.

## Source pins

| Item | Pin |
| --- | --- |
| Baseline commit | `1f3e769616fdf9f31f85f4c3e6a9f71606634238` (upstream `main` at P0 start) |
| Experiment head at P0 start | `a40b9e375330773e61fcf19bdb894e31ed96d3eb` (design docs only) |
| `pi` | 1.0.0 |
| `@earendil-works/pi-coding-agent` | 1.0.0 |
| `@earendil-works/pi-durable` | 1.0.1 (repository `github.com/earendil-works/pi`) |
| `@earendil-works/pi-ai` / `@earendil-works/chord` | 1.0.1 / 1.0.1 |
| Upstream Pi source commit (all three) | `a7229ddc21810d6245105978033b7df645ecc2f7` |
| Node engine requirement | `>=22.19.0` (running Node 22.21.1) |
| ShellCheck / actionlint | 0.11.0 / 1.7.12 |

The upstream source commit inside `github.com/earendil-works/pi` is pinned above (`a7229ddc`).

## Entry-point verification

Every entry point named in `03-implementation-plan.md` exists at the pinned baseline. Roles below are read from each file's own header.

| Entry point | Exists | Role (verified from source) |
| --- | --- | --- |
| `.pi/extensions/fm-primary-pi-watch.ts` | yes | dispatcher: offers actionable wakes to the branch |
| `.pi/extensions/lib/fm-branch-dispatch.ts` | yes | offer handshake and row eligibility; grants ownership of the branch-eligible rows |
| `.pi/extensions/fm-branch-supervision.ts` | yes | the branch itself: creates a second Pi `AgentSession`, serializes wakes, mirrors dialog, merges outcomes |
| `bin/fm-branch-prompt.sh` | yes | emits the branch system prompt; prefix-stability contract (pure function of tracked files) |
| `bin/fm-branch-outcome.sh` | yes | durable append-only outcome store `$STATE/branch-outcomes.jsonl` + read cursor + processed marker |
| `bin/fm-lease-lib.sh` and `bin/fm-lease.sh` | yes | per-task supervision lease between actors `main` and `branch`; inspection/mutation serialized by a home-local lock |

### Execution seam for P1C

The existing "provider" is Pi's own in-process `AgentSession`, created inside `.pi/extensions/fm-branch-supervision.ts` (imports from `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`).
That extension is where a provider selection (`existing | pi-durable`) would be inserted before accepting work.
The plan's proposed `supervision.execution` key is not an existing configuration convention; `docs/configuration.md` currently uses presence-file/one-line keys under `config/` (for example `config/supervision-branch-model`, `config/supervision-host`). Confirm and match that style in P1C.

## Baseline invariant inventory (R1-R12)

The prototype must preserve these existing mechanisms; each row names the current owner that already implements the FirstMate side.

| Requirement | Existing owner/evidence |
| --- | --- |
| R1 existing path default | supervision is default-on with no grant file; provider selection must preserve this |
| R2 explicit per-home selection | current convention: local gitignored `config/` presence files |
| R3 eligibility stays FirstMate-owned | `.pi/extensions/lib/fm-branch-dispatch.ts` offer handshake + `bin/fm-watch.sh` scope rules |
| R4 repeat ID returns original | proposed (adapter); no existing equivalent in the branch path |
| R5 conflicting retry refused | proposed (adapter) |
| R6 stale generation cannot mutate/ack | `bin/fm-lease-lib.sh` actors + generation/lock checks in the extension |
| R7 runtime completion != delivery | `bin/fm-branch-outcome.sh` store + sequence-keyed visible record on main |
| R8 no silent second executor | watcher retains delivery ownership on branch failure (existing documentation) |
| R9 interrupted unsafe effects unresolved | no existing equivalent for durable effects; adapter's `reconcile` |
| R10 cancellation retains work | no existing durable-cancellation equivalent |
| R11 acknowledgements keep sequence/owner checks | `bin/fm-branch-outcome.sh` processed marker; watcher-continuity per-actor ack |
| R12 recovery fenced before resume | session-lock/generation checks in the extension (submission-time); mutation-boundary fencing is proposed |

## Pi Durable API mapping (verified)

**Correction to the first pass:** Pi Durable is not a `pi` subcommand. It is a separate npm library, `@earendil-works/pi-durable` (1.0.1), that a sidecar program imports. This matches the architecture's "local TypeScript sidecar"; the earlier "the installed `pi` CLI exposes no Durable surface" was expected, not a blocker.

Confirmed imports (published design post and the probe below):

- `@earendil-works/pi-durable` - `Harness`, `createRegistry`, `defineTool`, `defineExtension`, `defineTask`, `defineDoc`, `hook`, `section`, `wrapTool`, plus entry/doc/task types and `StorageRejected` / `ConversationBusy`.
- `@earendil-works/pi-durable/storage/sqlite/node` - `openNodeSqliteStorage`; also `/storage/jsonl` and `/storage/memory`.
- `@earendil-works/pi-durable/env/node` - `NodeExecutionEnv`.
- `@earendil-works/pi-durable/tools` - coding tools; `/testing` - test helpers.
- `@earendil-works/chord/context` - `BACKGROUND_CONTEXT` (the cancellation context every call takes).
- `@earendil-works/pi-ai` - `createModels` and provider/model types.

Call shape: `Harness.open(storage, { models, registry, env }, context)`; `harness.resume()`; `await harness.root(context, { agent: { model, cwd } })`; `conversation.submit({ type: "input", content, requestId }, context)`; `harness.close(context)` (close requires the context).

### Deterministic probe results (2026-10-03)

Lab: `/home/andy/dev/pi-durable-lab` (throwaway, not committed to the experiment branch).

| Check | Result |
| --- | --- |
| Install `pi-durable` + `pi-ai` + `chord` 1.0.1 | ok |
| SQLite storage open (`openNodeSqliteStorage`) | ok, with Node `ExperimentalWarning: SQLite is an experimental feature` |
| `Harness.open` + `harness.root(...)` with no model call | ok, fully offline |
| `harness.resume` present | yes (function) |
| Cross-process exclusive store ownership | **NOT enforced by default**: a second process opened the same SQLite store concurrently and succeeded |

**Consequence:** the architecture's requirement to "acquire a store-owner lock before opening the harness; a second owner must refuse startup" is the adapter's responsibility. The default SQLite storage does not provide it, so P1A must implement the lock itself and a test must prove the second owner is refused.

### Faux-model experiments (2026-10-03)

Run with Pi's faux provider (`fauxProvider` + `fauxAssistantMessage`), so no real model or credentials were involved. Scripts in the lab: `exp-dedup.mjs`, `exp-reopen.mjs`.

| Check | Result |
| --- | --- |
| Same `requestId`, same payload, same process | returns the same submission (`dedup_same_id: true`) |
| Submission settles against the faux model | `settled_status: done` |
| Same `requestId`, **different** payload | **ALLOWED, not refused**: returns the original submission and ignores the new content (`id_equals_original=true`) |
| Reopen the SQLite store, `harness.resume()` | ok; `resume` is callable |
| Root conversation identity across restart | stable |
| `requestId` dedup across restart | returns the original submission |
| Tool with `replay: "safe"`, SIGKILL mid-tool, reopen + `resume()` | tool **reran** (marker 1 line -> 2) |
| Tool with no `replay`, SIGKILL mid-tool, reopen + `resume()` | tool did **not** rerun (marker stayed at 1 line); the model is told the call was interrupted |
| Ungraceful SIGKILL, then reopen + `resume()` | continuation works; the interrupted run completes |

**Consequence for R5:** Durable's `requestId` dedup does **not** refuse a changed payload under the same ID — it silently returns the original. The adapter must store and compare a payload/configuration digest and refuse a mismatch itself.

### Cancellation, observation, and storage (2026-10-03)

| Check | Result |
| --- | --- |
| `root.abort(context)` during an in-flight tool | the tool's `Context` received an abort signal and the submission settled `unanswered` with reason `aborted` |
| Cancellation is cooperative | abort reaches the tool through `context.abortSignal`; a raw child process must be terminated by the tool/adapter, not implied by abort |
| `viewState()` snapshot | keys `conversation, entries, docs`; live `subscribe` delivered updates across a submit |
| Reconnect to the view | a fresh `viewState()` returns the committed transcript as a snapshot (no retained replay needed) |
| SQLite durability (documented) | single file, WAL, `synchronous = NORMAL`: commits survive process crashes, the newest may be lost on power or host failure |
| SQLite options | `walAutoCheckpointPages` (default 1000), `busyTimeoutMs` (default 5000) |
| Cross-process ownership | none by design: "One process owns a storage at a time; there is no cross-process locking" - so the adapter's store-owner lock is required |
| JS runtime | Node `>=22.19.0`; uses built-in `node:sqlite` (emits `ExperimentalWarning`); 22.21.1 works |

**Consequences:** cancellation is context-cooperative, so the adapter must verify owned process termination itself. Observation is snapshot-plus-operations with no replay log (matching the design's warning), so the adapter's own outbox/receipts must carry settlement across gaps. Storage is durable across process crashes but not power loss (`synchronous = NORMAL`) and offers no cross-process lock.

No P0 experiment items remain open.

## Baseline test capture

`bin/fm-test-run.sh tests/fm-branch-supervision.test.sh tests/fm-pi-branch-extension.test.sh` -> `total=2 failed=0` (2026-10-03).

## Open P0 items

1. Record the full-suite (`--all`) baseline result in `development.md` (running at the time of writing; lint passes in changed-file mode and the two named tests pass).
2. Confirm the P1C configuration syntax against `docs/configuration.md` conventions.
3. Decide which of R4/R5/R9/R10 need adapter-owned contracts versus upstream guarantees (R5 conflict-refusal and the store-owner lock are confirmed adapter work).

The upstream source commit is pinned; the deterministic Durable experiments are complete.

## Honest status

Verified: entry-point existence and roles; the existing outcome/lease/prompt/dispatch contracts; toolchain pins; the two named supervision-branch tests pass; the Pi Durable library API surface, offline `Harness.open` + root creation, `resume` presence, the absence of a default exclusive store lock, `requestId` dedup within and across a restart, graceful reopen with stable root identity, tool `replay` behavior across an ungraceful SIGKILL (safe reruns, unsafe is not rerun and is reported interrupted), continuation after that crash, cooperative cancellation via `root.abort`, snapshot observation with reconnect, SQLite durability settings, the Node runtime floor, and the fact that a changed payload under a reused `requestId` is **not** refused by Durable.
Not verified: no prototype code or Durable integration test has been written or run; the full-suite baseline is still running.

P1A-P1D and P2 update (2026-10-04): the sidecar service, protocol, single-owner store lock, durable operation acceptance, the P1B conversation identity and authority binding, the P1C dispatch and outcome bridge, and the P1D bounded observation outbox are implemented under `runtime/pi-durable/`, and the P2 evaluation harness runs deterministically under `runtime/pi-durable/eval/` with results in `06-evaluation-report.md`; see `development.md` for the verified commands.
