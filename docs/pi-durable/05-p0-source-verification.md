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
| ShellCheck / actionlint | 0.11.0 / 1.7.12 |

Pi Durable upstream source (`github.com/earendil-works/pi`) and the design post (`earendil.com/posts/pi-durable/`) are **not yet pinned**; see "Pi Durable capability checks".

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

## Pi Durable capability checks

**Top finding (potential blocker):** the installed `pi` 1.0.0 CLI exposes no `durable` command or documented Durable surface (`pi --help` and `pi durable --help` show none).
The Durable API named by the design (persistent execution, submission deduplication, tool replay declarations, one owner per store) must be located and pinned in the upstream Pi source before P1 can be specified.

Still open (from `03-implementation-plan.md` P0), each needing a small deterministic experiment against the pinned revision:

- persistent store reopen and exclusive single-owner lock;
- conversation find/create and the create/find mapping across a crash;
- submission request-ID retry and conflicting-payload behaviour;
- tool configuration persistence across restart;
- interrupt/recovery semantics;
- cancellation of foreground and background ownership (process-group termination);
- observation/reconnect/cursor/snapshot APIs;
- SQLite durability settings and supported JS runtime.

## Baseline test capture

`bin/fm-test-run.sh tests/fm-branch-supervision.test.sh tests/fm-pi-branch-extension.test.sh` -> `total=2 failed=0` (2026-10-03).

## Open P0 items

1. Pin the upstream Pi Durable source revision (and confirm the installed `pi` exposes the required API; escalate if not).
2. Run the deterministic Durable capability experiments listed above.
3. Record full-suite (`--all`) and lint baseline results in `development.md`.
4. Confirm the P1C configuration syntax against `docs/configuration.md` conventions.
5. Decide which of R4/R5/R9/R10 need adapter-owned contracts versus upstream guarantees.

## Honest status

Verified: entry-point existence and roles, the existing outcome/lease/prompt/dispatch contracts, toolchain pins, and the two named supervision-branch tests.
Not verified: any Pi Durable API, any prototype code, and any executed Durable integration test.
