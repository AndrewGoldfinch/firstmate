# FirstMate Pi Durable Integration Implementation Plan

Version 1.1 • 3 October 2026 • Status: prototype plan ready for source verification

## Initial delivery

Implement the Pi supervision prototype first, in a disposable FirstMate home, behind an explicit opt-in configuration. Keep the existing dispatcher, scope eligibility, lease checks, outcome sink, delivery, and acknowledgement paths authoritative. The first runnable increment returns structured supervision findings and does not expose arbitrary shell or fleet mutations.

This is an implementation document, not an implementation report. No source changes, runtime installation, test execution against a repository, or deployment are included in this documentation task. [The project design](01-project-design.md) supplies the goals and gates; [the architecture](02-architecture.md) supplies the contracts that the work must satisfy.

## P0 source verification and baseline

Create an isolated checkout using the repository's current contributor workflow. Read its current `AGENTS.md`, identify the actual supported Pi versions, and record immutable FirstMate and Pi commits plus resolved package versions and lockfile. Dependency installation must not rely on an unpinned `latest` package.

Trace these documented FirstMate entry points against the pinned source. Names below come from the current upstream supervision documentation; implementation must verify their present signatures and callers.

| Entry point | Question to answer |
| --- | --- |
| `.pi/extensions/fm-primary-pi-watch.ts` | Where is wake delivery dispatched and owned? |
| `.pi/extensions/lib/fm-branch-dispatch.ts` | What accepts a claim, and what happens if acceptance is uncertain? |
| `.pi/extensions/fm-branch-supervision.ts` | What is execution plumbing versus FirstMate outcome policy? |
| `bin/fm-branch-prompt.sh` | Which instructions, scope, and posture must the prototype preserve? |
| `bin/fm-branch-outcome.sh` | What uniquely identifies an outcome and its acknowledgement? |
| `bin/fm-lease-lib.sh` and `bin/fm-lease.sh` | Which generation and serialization checks guard each effect? |

Inventory current tests for branch eligibility, leases, supervision outcomes, recovery, and routine delivery. The upstream docs name `tests/fm-branch-supervision.test.sh` and `tests/fm-pi-branch-extension.test.sh`; confirm they still exist and use the repository's test runner. Record baseline results and any failures before adding the adapter.

Verify the following upstream Pi Durable capabilities with small deterministic experiments: persistent storage reopen; conversation find/create; request-ID retry and conflicting payload behavior; tool configuration persistence; interrupt/recovery treatment; cancellation of foreground and background ownership; supported observation/reconnect APIs; and exclusive store ownership. If upstream permits conflicting retries, enforce conflicts in the adapter.

P0 outputs are a compatibility note, exact source pins, the baseline invariant inventory, and a confirmed API mapping. An incompatibility can revise the adapter design or stop promotion; it must not be hidden behind a simulated durable implementation.

## P1 prototype construction

The proposed in-tree structure is intentionally small. Adapt it to the repository's build conventions after P0; paths are recommendations, not existing files.

| Proposed file | Responsibility |
| --- | --- |
| `runtime/pi-durable/package.json` and lockfile | Exact dependencies and reproducible build |
| `runtime/pi-durable/src/service.ts` | Socket lifecycle, owner lock, readiness, bounded requests |
| `runtime/pi-durable/src/provider.ts` | All upstream Durable API calls |
| `runtime/pi-durable/src/protocol.ts` | Versioned schemas, digest rules, operation identities |
| `runtime/pi-durable/src/supervision.ts` | Conversation setup and pinned supervision configuration |
| `runtime/pi-durable/src/firstmate-tools.ts` | Narrow typed snapshots and authority-bound actions |
| `runtime/pi-durable/src/reconcile.ts` | Acceptance, settlement, and delivery repair |
| `runtime/pi-durable/src/observations.ts` | Normalized event or snapshot facts |
| Existing branch execution seam | Select existing or durable provider before acceptance |
| `runtime/pi-durable/tests/` | Provider contracts and deterministic fault injection |

### Work package P1A service and protocol

Build a single-owner service bound to a canonical isolated home. Validate permissions, home identity, protocol version, payload limits, and dependency compatibility before reporting ready. Persist operation acceptance with its payload and configuration digests. A repeat ID returns the original operation; a different digest fails.

Acceptance gate: two owner processes cannot open one store; a wrong home or incompatible protocol is refused; a lost reply can be reconciled without a new execution; no secret appears in recorded payloads or diagnostics.

### Work package P1B conversation identity and authority

Create or locate the logical supervision conversation and record a recoverable mapping. Configure the selected model, effort, prompt, tools, and validated cwd. Do not import a legacy Pi transcript during the initial prototype. The prototype starts fresh and uses FirstMate's existing records as supervision input.

Bind each operation to the exact accepted row set and logical owner generation. Add an authority adapter that refuses expired, superseded, or unknown bindings. Install this refusal behavior before any resume call. A service restart keeps the logical generation when FirstMate confirms it remains valid.

Acceptance gate: restart returns to the original operation and conversation; stale work cannot execute a guarded mutation; a fresh conversation cannot inherit broader tools from an unrelated root configuration.

### Work package P1C dispatch and outcome bridge

Add the narrow provider selection to the existing branch execution seam. Proposed configuration might use `supervision.execution = existing | pi-durable`; choose the actual syntax after reviewing current configuration conventions. The default is the existing path. Provider selection becomes immutable for each accepted operation.

Submit the branch's exact accepted scope through the service. Parse a schema-validated candidate result and call the existing outcome sink with the same claim, sequence, and generation semantics. Runtime settlement cannot acknowledge wake rows or mutate FirstMate's task lifecycle directly.

Acceptance gate: the existing and durable paths pass the same eligibility and outcome fixtures; a malformed result is rejected and remains diagnosable; a repeated settled result cannot create a conflicting committed outcome; routine delivery retains its documented baseline semantics.

### Work package P1D bounded observation

Expose operation inspection and normalized observations through supported APIs. Use a durable adapter outbox or snapshot reconciliation if upstream observation is not replayable. Commit delivery receipts before moving the related cursor. Bound queue size and prioritize settlement and unresolved-effect observations over progress text.

Acceptance gate: a subscriber reconnects after missed observations and recovers every undelivered settlement; a snapshot is not interpreted as task success; event duplicates do not produce duplicate fleet transitions.

## P2 recovery evaluation

Implement the [evaluation harness design](04-evaluation-harness.md) alongside P0 through P2. It supplies a controlled six-task fleet, an independent oracle, paired comparison rules, and explicit grading for the fault cases below. Compare common external behavior across both arms; provider-specific cases remain separately reported conformance checks.

Use a deterministic model stub and controllable fake tools first. Faults should trigger at explicit barriers around persistence and effect boundaries, not depend solely on timing-sensitive sleeps. Supplement with a small pinned-provider smoke run and a disposable-host restart test after the deterministic suite passes.

| Case | Injection point | Required observation |
| --- | --- | --- |
| F01 | After FirstMate intent, before runtime acceptance | Same ID can be delivered; no work lost |
| F02 | After acceptance, before reply to caller | Lookup finds the original execution; no fallback executor |
| F03 | After conversation creation, before mapping acknowledgement | Existing conversation is recovered or duplicate is quarantined |
| F04 | During a model response | Recovery behavior recorded; partial output cannot become a valid outcome |
| F05 | During a declared safe read | Read may rerun; settlement remains one logical operation |
| F06 | After unsafe effect, before receipt commit | Effect is reconciled or marked unresolved; no blind rerun |
| F07 | After runtime settlement, before FirstMate outcome commit | Candidate is recovered and committed under current authority |
| F08 | After FirstMate outcome commit, before adapter receipt | Repeat finds the existing outcome |
| F09 | After delivery, before acknowledgement | Existing sequence and cursor contract retained; known routine-note limitation measured |
| F10 | While generation changes or lease expires | Old execution cannot mutate or acknowledge current work |
| F11 | After service crash with valid generation | Same owner generation and operation resume |
| F12 | While cancellation is requested during tool execution | Cancel state persists; unresolved children or effects remain visible |
| F13 | Second service startup against same store | Second owner refused |
| F14 | Observe stream disconnect or cursor gap | Snapshot/outbox reconciliation recovers settlement |
| F15 | Repeated ID with changed payload or configuration | Conflict refused |
| F16 | Missing model credentials or incompatible dependency | Explicit unavailable state; accepted work is not rerouted silently |
| F17 | Disposable host reboot with unfinished operation | Store reopens and authority is reconciled before effects resume |
| F18 | Store restored into a different home | Home mismatch refused or isolated recovery explicitly required |

For cancellation tests, record foreground and background ownership separately. Ensure all prototype work is tracked. If a tool launches a process, verify process-group termination rather than assuming an aborted promise stopped the process. Keep workspaces and records until FirstMate settles cleanup authority.

The existing routine-note duplicate-delivery limitation is not converted into a new exactly-once guarantee. If closing that gap is required for later rollout, implement it as a separately reviewed idempotent sink change with its own regression coverage.

## Prototype evaluation and decision

Run both providers over the same fixture set and model configuration. Compare valid outcomes, eligible row handling, duplicate effects, rejected stale actions, replay behavior, interventions, recovery time, cost, and maintainability. Record exact versions, fixture counts, and untested scenarios in the evaluation report.

| Decision | Conditions | Next action |
| --- | --- | --- |
| Proceed | All required invariants pass and adapter reduces execution-recovery responsibility | Begin Phase 1 with a documented contract |
| Revise | Correctness holds but API gaps or complexity outweigh benefit | Narrow scope or improve adapter before retesting |
| Stop | Required fencing, recovery, or settlement cannot be demonstrated | Keep existing path and archive the experimental findings |

No automatic production promotion follows a successful lab test. The next concrete step after these documents is P0 source verification and the isolated prototype, not general crewmate migration.

## Operational runbook for the prototype

Before a run, verify the isolated home, dependency pins, service owner, provider selection, and model configuration. Start the service with authority checks active. Confirm health and the baseline branch fixtures before submitting controlled work.

After a failure, inspect the FirstMate command record, current generation, runtime operation, candidate result, and outcome receipt. Resolve unknown acceptance by lookup. Do not mint a new ID to bypass a timeout. Do not release a workspace because the socket is down. Escalate unresolved external effects with the evidence needed for reconciliation.

Rollback prevents new durable assignments first. For already accepted operations, reconcile, cancel, or fence them under their original provider. Only after their authority is settled may new work use the existing path. Retain the runtime store and FirstMate receipts for inspection. Disabling the flag must not create a second executor for work still accepted by Durable.

Upgrade by draining or quarantining affected operations, backing up with supported methods, and testing the new registry against an isolated copy. Refuse startup on unsupported persisted schemas. A code downgrade is not assumed to make a migrated database readable; restore or migration procedures must be explicitly verified.

## Phase 1 shared execution abstraction

Extract the provider contract from the proven supervision seam and actual worker lifecycle call sites. Wrap existing terminal backends as a session execution provider. Keep their backend commands and workspace behavior intact. Avoid a mechanical rename of `fm-backend` or a watcher rewrite.

Deliver versioned status facts, provider capability declarations, explicit unsupported-operation errors, and compatible default dispatch. Validate existing backend regressions and known verification limits; unverified backends are not claimed verified merely because the wrapper compiles.

Gate: existing workflows preserve their behavior, old configuration selects session execution, and the new provider does not require backend-specific branching throughout the control plane.

## Phase 2 durable Pi crewmates

Add explicit durable runtime selection for compatible Pi workers. FirstMate allocates and leases the worktree, records cwd and ownership, then creates the conversation. Failure after allocation retains enough metadata to clean up safely. Failure after submission reconciles that execution before retry or teardown.

Implement launch, inspect, steer, cancel, and attachment using structured operation identities. Translate chosen model and effort settings and refuse unsupported configurations. Do not claim this wraps Claude Code or Codex CLI in Pi Durable; those continue using their session execution provider.

Gate: duplicate launch, failed launch, relaunch, worktree ownership, provider outage, cancellation, and teardown cases pass in isolated homes.

## Phase 3 watcher integration and broader fault coverage

Feed durable observations into the current wake machinery and keep FirstMate's task interpretations. Integrate service health, active tasks, queued submissions, interrupted tools, and unresolved effects as distinct evidence. Include task background activity and external CI/PR state in reconciliation.

Gate: missed events, duplicate events, stale snapshots, process death, reboot, and observer reconnect do not lose accepted work or falsely complete a task. No component queries Durable's internal SQLite tables.

## Phase 4 capabilities and supervision graduation

Define versioned tool profiles for ships, scouts, reviewers, and supervisors. Every profile must state filesystem, shell, network, credential, and FirstMate privileges. Tests that can write state require an isolated environment, even when the reviewer cannot edit project sources directly.

Enable selected supervision mutations only after each operation has current-authority validation, receipt semantics, and an interruption reconciliation strategy. Preserve the existing posture rules. Retire only legacy conversation-recovery code that the evaluation proves unnecessary; FirstMate outcome delivery and acknowledgements remain.

Gate: profile and posture parity is demonstrated, denied actions cannot escape through arbitrary shell, and existing authority tests pass.

## Phase 5 routing and feedback

Extend dispatch records with runtime, capability profile, and environment identity. Define defaults for old profiles and refuse invalid combinations before assigning a task. Rules-based explicit selection precedes Jev-driven recommendations.

Capture harness, runtime, model, effort, task features, recovery events, cost, latency, tests, review outcomes, and human intervention. Separate execution completion from independently verified task success. Evaluate routing changes with recorded denominators and comparable task groups rather than raw successful-run counts.

Gate: every routing decision is explainable and attributable to a supported configuration; telemetry gaps do not change authority or trigger unsafe fallbacks.

## Future work

Remote execution needs a separate design for authenticated transport, durable remote job IDs, artifact movement, path translation, credential boundaries, resource quotas, process cleanup, and network partitions. A Proxmox lab VM or container is a suitable evaluation target after local correctness. Remote SecondMate control-plane ownership remains distinct from remote tool execution.

External provider packaging can introduce `execution-runtime/1` after the in-tree protocol stabilizes. Define installation trust, capability negotiation, digest verification, version compatibility, home binding, upgrades, and uninstall behavior before publishing a package.

Additional futures include multi-client attachment, durable steering, runtime-aware model routing, conversation retention policies, and richer dashboards. Each should consume the same operation and authority contracts rather than adding a parallel task state store.

## Completion checklist

- Record pinned revisions and verified upstream APIs.
- Preserve the existing default and branch eligibility contract.
- Implement durable operation identities and acceptance reconciliation.
- Fence effects before resume and at every mutation boundary.
- Route candidate results through the existing FirstMate outcome sink.
- Complete the fault matrix, baseline comparison, and rollback exercise.
- Document known gaps, including routine-note delivery behavior.
- Produce an evaluation decision before expanding to crewmates.
