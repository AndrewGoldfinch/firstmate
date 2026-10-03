# FirstMate Pi Durable Project Guidance

Version 1.0 - 3 October 2026

## Integration and scope

This is the initial project-specific guidance for developing the optional Pi Durable supervision prototype and its evaluation harness.
The root `AGENTS.md` points contributors here before Pi Durable project work; preserve the upstream supervisor contract and contributor rules.
This file is not a wholesale replacement for the upstream file.
Loading project guidance does not turn a development worker into a fleet supervisor or grant access to a live fleet.
Follow the actual assigned role, applicable parent instructions, and current user authorization.
If a material conflict remains, describe it before taking the affected action rather than silently changing the instruction hierarchy.

## Objective

Determine whether Pi Durable can improve supervision recovery and reduce FirstMate-owned execution-recovery responsibility while preserving FirstMate's existing authority and outcome contracts.
Establish the baseline benchmark before claiming a benefit from the prototype.
Treat reliability, duplicate prevention, ownership, observability, and maintainability as separate measurable outcomes.

The current milestone is a local, opt-in Pi supervision prototype in an isolated lab home.
The first increment observes fleet state and returns structured findings through the existing FirstMate outcome path.
General crewmate migration, automatic routing, remote execution, external provider packaging, and replacing FirstMate stores belong to later phases.
Do not expand the current milestone merely because those features appear in the roadmap.

## Read before changing code

Read the current repository `AGENTS.md`, `CONTRIBUTING.md`, and any instructions scoped to the files being changed.
Consult these project documents, intended to be installed under `docs/pi-durable/`:

- `01-project-design.md` for scope, requirements, and promotion gates.
- `02-architecture.md` for ownership, protocol, recovery, and cancellation contracts.
- `03-implementation-plan.md` for P0 through P2 work packages and later phases.
- `04-evaluation-harness.md` for fixtures, failure schedules, grading, and comparison rules.

These documents live beside this guidance in `docs/pi-durable/`.
Proposed paths and interfaces in those documents are design targets; verify the pinned source before treating them as existing APIs.

## Repository workflow

Develop in the FirstMate fork on a focused experiment branch, initially `experiment/pi-durable-supervision`.
Keep the fork's default branch aligned with upstream and record the exact baseline commit before prototype edits.
Use separate worktrees for baseline and prototype runs, with independent state directories.
Preserve unrelated changes and existing branch ownership.
Keep changes small enough to review the runtime adapter, FirstMate integration, and benchmark separately.

Use the repository's current contribution and review process for upstream submissions, including its documented gate requirements.
Do not reinterpret permission to implement a change as permission to merge, deploy, or discard work.
An upstream update during evaluation creates a new comparison cohort; do not silently change the baseline.

Proposed project locations are:

| Path | Responsibility |
| --- | --- |
| `docs/pi-durable/` | Design, compatibility notes, development commands, and evaluation reports |
| `runtime/pi-durable/` | Service lifecycle, upstream API adapter, protocol, and supervision binding |
| `tests/pi-durable-eval/` | Scenario runner, fault injection, independent grader, and fixtures |

Add narrow directory-level guidance only when needed, and keep common rules here.
Check the pinned repository's layout and documentation conventions before adding these directories.

## Architecture invariants

- FirstMate owns task intent, wake eligibility, posture, claims, generations, operational leases, decisions, outcomes, acknowledgements, and workspace lifecycle.
- Pi Durable owns execution records and recovery for conversations explicitly assigned to it.
- Preserve the existing execution path as the default and verify behavior with the prototype disabled.
- Keep upstream Durable API calls behind a small typed adapter.
- Never infer runtime state by querying internal SQLite tables.
- Never equate a completed model response, an idle conversation, or a disconnected service with a successful FirstMate task.
- Keep Treehouse allocation and release in FirstMate's workspace path when later crewmate work begins.
- Do not make the prototype masquerade as a terminal backend or require other harnesses to use Durable.

## Recovery and authority

Persist command intent before delivery and use stable operation IDs with payload and configuration digests.
An identical retry must resolve to the original operation; a changed payload under the same ID must be refused.
An unknown acceptance state requires reconciliation, not a new executor or a new ID.
Do not silently switch accepted work to the existing provider when Durable becomes unavailable.

Treat the FirstMate and runtime stores as separate transaction domains.
Recover gaps with durable records, receipts, and idempotent sinks rather than assuming a cross-store atomic commit.
Pass candidate results through the existing FirstMate outcome and acknowledgement contracts.

Bind work to its home, accepted row set, capability profile, and logical owner generation.
Enforce current authority at the mutation boundary under the existing serialization rules.
Install authority guards before resuming persisted execution.
A service restart does not itself create a new logical owner generation.

Classify tools deliberately for replay.
Reads may qualify; arbitrary shell, edits, test commands, remote actions, and status writes are not automatically replay-safe.
An interrupted external effect must be reconciled or explicitly marked unresolved.
Cancellation is not rollback: verify owned work and child-process termination before claiming settled cancellation.
Preserve workspaces and evidence until FirstMate authorizes cleanup.

## Lab isolation and capabilities

Set `FM_HOME` explicitly for every lab operation and verify it resolves to the intended disposable home.
Do not default to an existing user fleet, operational checkout, credentials, or real recipient.
Keep fixture repositories and simulated services isolated from production systems.
Run process-kill and reboot tests only against the designated test processes or disposable VM.
The runner and evidence ledger must survive the injected failure.

Start the supervisor with narrow typed observation and result tools.
Test-only effect tools must stay confined to the lab and must not introduce production privileges.
Do not grant arbitrary shell as a shortcut around a missing typed operation.
Tool selection alone does not establish operating-system isolation.

Do not commit credentials, live fleet state, runtime databases, personal transcripts, or unredacted test output.
Preserve reproducible fixture definitions and redacted result manifests.

## Evaluation integrity

Run the same version of the scenarios and grader against both checkouts.
Keep model settings, semantic prompts, capability sets, resource limits, and simulated delays matched; record unavoidable differences.
Run the prototype checkout with Durable disabled as a compatibility check.
Do not let a harness adapter repair, deduplicate, or fabricate outcomes for the evaluated system.

Keep fixture truth outside the evaluated agent's workspace.
Grade effects and raw records independently of the adapter's own success report.
Verify the grader with corrupted traces that contain dropped work, duplicate effects, invalid ownership, and false completion.
Use named failure boundaries and retain failed runs in the results.

Freeze scenarios, grading rules, and calibrated thresholds before scored runs.
Changing a threshold or fixture requires a new version and rerunning the affected comparison for both arms.
Report arm-specific conformance cases separately from genuinely comparable A/B cases.
Use deterministic model responses first, then a bounded real-model pilot.
Record versions, seeds or schedules, sample counts, timeouts, interventions, and limitations.

Never offset lost work, stale-owner actions, conflicting outcomes, or blind unsafe replays with a favorable speed score.
Do not claim production guarantees or universal exactly-once effects from a passing lab suite.
Report the known routine-note delivery limitation separately from operation and effect deduplication.

## Validation and implementation order

First verify source revisions, supported dependencies, and actual FirstMate entry points.
Record exact reproducible setup, build, lint, and test commands in `docs/pi-durable/development.md` once verified.
Do not invent commands or assume the new TypeScript package already exists.
Keep current upstream lint, documentation, and test gates applicable to the change.

Build the smallest baseline experiment first: one accepted supervision task, one execution-owner crash, restart, and independently graded outcome delivery.
Then make the durable path pass that same experiment before expanding the fault matrix.
Add focused behavioral coverage for meaningful runtime changes and run the relevant existing contract tests.
Use evidence from concrete failures to guide additional tests rather than adding broad unrelated work.

Do not claim a test passed unless it ran successfully against the stated revision.
Clearly distinguish a test specification, a mocked result, a real integration result, and a real-model result.

## Completion and handoff

A completed change includes the intended behavior, relevant validation evidence, updated documentation where behavior changed, and any remaining limitations.
A handoff records the branch and commit, changed files, exact checks and outcomes, unresolved issues, and the next smallest useful step.
Keep implementation status and proposed future work visibly separate.

Prototype promotion requires the agreed correctness cases, existing-provider compatibility, measured operational benefit, and an honest inventory of recovery responsibility removed and added.
If benefits remain unproven, report that result and continue only the targeted experiment needed to resolve it.
