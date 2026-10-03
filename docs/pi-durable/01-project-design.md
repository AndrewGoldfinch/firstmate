# FirstMate Pi Durable Integration Project Design

Version 1.1 • 3 October 2026 • Status: proposed design, prototype scope selected

## Decision and purpose

Start with an opt-in prototype that runs FirstMate's Pi supervision conversation through Pi Durable. Preserve FirstMate's wake eligibility, leases, generation ownership, outcome records, delivery rules, and acknowledgements. Use the experiment to establish whether durable execution can simplify conversation recovery without weakening the control plane.

This document defines the project, scope, requirements, milestones, and decision gates. [The architecture document](02-architecture.md) defines the boundaries and failure semantics. [The implementation document](03-implementation-plan.md) specifies the prototype work and the later rollout. The request authorizes preparation of these documents; no repository implementation or deployment has occurred.

FirstMate owns durable intent and operational authority. Pi Durable owns execution records for the Pi conversations assigned to it. The integration remains optional and preserves FirstMate's ability to dispatch other harnesses.

## Problem and opportunity

Long-running agent work can outlive a terminal session, a model request, or a host process. FirstMate already coordinates work and recovery across these boundaries. The proposed integration moves Pi conversation execution and checkpoint recovery into a dedicated runtime while leaving FirstMate's domain decisions in FirstMate.

The immediate question is deliberately narrow: can a Pi Durable supervision conversation recover interrupted work and return a valid result through the existing FirstMate outcome contract? A successful prototype establishes a reusable execution boundary. It does not establish that every worker should use Pi Durable or that a general runtime abstraction is ready for production.

## Evidence and design status

The supplied architectural discussion is the project's design input. This package formalizes that recommendation and adds proposed correctness contracts. Current upstream documentation was checked on 3 October 2026; neither repository was cloned or exhaustively audited during preparation of this package. Exact release versions, commits, signatures, and test commands remain implementation prerequisites.

The FirstMate supervision documentation identifies a Pi-only branch, an existing dispatch handshake, lease guards, and an outcome store. It also records a routine-note delivery deduplication limitation. This project preserves the existing contract and records that limitation rather than promising end-to-end exactly-once delivery [S1]. FirstMate's architecture describes session providers and worktree ownership separately [S2].

Pi Durable is described as experimental. Its documentation describes persistent execution, submission deduplication, tool replay declarations, and one process owning a store [S3]. These are upstream descriptions, not prototype test results. Every FirstMate-facing interface in this package is a proposed contract unless explicitly identified as existing.

## Goals

1. Recover interrupted supervision execution without losing the claimed work or duplicating a committed outcome.
2. Prevent an old owner from mutating FirstMate after its authority expires or changes.
3. Keep task identity, routing, decisions, review, merge authority, and worktree ownership in FirstMate.
4. Produce enough evidence to compare the prototype against the existing supervision path.
5. Establish a reversible path toward durable Pi crewmates, runtime-aware routing, and remote execution.

## Initial scope

The prototype includes a local TypeScript sidecar, a persistent store for one isolated FirstMate home, one supervision conversation, a small FirstMate extension, a narrow bridge to the existing branch dispatcher, and fault-injection tests. It must use a disposable lab home before any real fleet evaluation.

The first milestone uses observation and structured outcome generation. Existing FirstMate code accepts and applies the outcome through its current guards. Broader supervision actions can be enabled only after generation checks and idempotency have been demonstrated. The prototype keeps the supervision branch's current role and posture eligibility rules; it cannot independently enlarge its authority.

Normal crewmates, broad `fm-spawn` changes, automatic routing, external runtime packages, production remote execution, and replacement of FirstMate state stores are deferred. This scope does not require a rewrite of `fm-watch` or the terminal backends.

## Requirements

| ID | Requirement | Evidence required |
| --- | --- | --- |
| R1 | Existing supervision remains the default | Flag-off behavior and current relevant regressions pass |
| R2 | Durable supervision is explicitly selected per home | Unsupported configurations fail clearly before acceptance |
| R3 | Work eligibility remains FirstMate-owned | Main-only and posture-dependent cases retain their existing behavior |
| R4 | Delivery retries preserve execution identity | Repeated identical operation IDs return the same submission |
| R5 | A conflicting retry is refused | Reusing an operation ID with different payload or configuration fails |
| R6 | Old generations cannot mutate or acknowledge current work | Tests expire or replace authority at each mutation boundary |
| R7 | Runtime completion does not imply delivery completion | Crash after execution and before FirstMate persistence is recoverable |
| R8 | Accepted work does not silently fall back to a second executor | Timeout and lost-response tests reconcile the original operation |
| R9 | Interrupted unsafe effects remain unresolved until reconciled | No automatic repeated mutation in fault tests |
| R10 | Cancellation retains work and artifacts until authority is settled | Delayed tools and missing acknowledgements are handled explicitly |
| R11 | Existing acknowledgements retain exact sequence and owner checks | Baseline contract tests run through both execution paths |
| R12 | Recovery never runs under missing or stale authority | Startup fences all mutating tools before resuming execution |

## Success criteria

The [evaluation harness design](04-evaluation-harness.md) defines the common fleet problem, baseline and prototype arms, independent grader, fault schedules, and benefit scorecard. Use it to conduct the comparison; its numeric improvement thresholds are provisional until calibrated and frozen during P0.

Advance beyond the prototype only when every required fault case passes reproducibly, both paths satisfy the same FirstMate outcome and acknowledgement contract, and service outages produce an explicit recoverable state. Record duplicates, lost work, stale mutations, unresolved effects, recovery time, model/tool counts, and operator interventions.

The first four correctness metrics must remain zero in the defined controlled suite: lost eligible rows, conflicting committed outcomes, unauthorized stale-generation mutations, and blind replays of unsafe operations. This is a test acceptance condition, not a claim about all possible failures.

Set latency and cost budgets after measuring the existing path with the same fixtures and model settings. Record sample size and configuration; avoid treating a small synthetic test as evidence of production performance. Promotion also requires a maintainable adapter and a demonstrated reduction in conversation-recovery responsibility, even if some FirstMate reconciliation necessarily remains.

## Delivery sequence

The prototype precedes the general runtime extraction. The wider phases retain the earlier roadmap, but the ordering now reflects the decision to learn from supervision first.

| Milestone | Scope | Exit gate |
| --- | --- | --- |
| P0 | Verify pinned APIs and baseline supervision contract | Compatibility notes, fixtures, and invariant inventory |
| P1 | Supervision prototype in an isolated home | Correct submission, settlement, outcome persistence, and acknowledgement |
| P2 | Recovery and cancellation evaluation | Fault matrix and rollback exercise pass |
| Phase 1 | Introduce a shared execution interface over existing sessions | Existing backend behavior and default selection remain compatible |
| Phase 2 | Opt-in durable Pi crewmates | Treehouse ownership, launch, observation, and cancellation verified |
| Phase 3 | Event integration and broader crash testing | Recoverable event delivery and fleet reconciliation demonstrated |
| Phase 4 | Role capabilities and supervision graduation | Authority and posture parity demonstrated for enabled operations |
| Phase 5 | Runtime-aware dispatch and telemetry | Routing decisions and outcomes can be attributed and evaluated |
| Future | Remote environments and external provider packaging | Separate design review and explicit operational readiness gates |

No calendar commitment or staffing estimate is implied. Estimate work after P0 identifies the current upstream APIs and repository change surface.

## Risks and mitigations

| Risk | Mitigation | Gate |
| --- | --- | --- |
| Experimental APIs change | Pin dependencies and keep upstream calls behind a small adapter | P0 and every dependency update |
| FirstMate and runtime stores disagree | Durable command records, deterministic IDs, reconciliation, idempotent outcome sink | P1 and P2 |
| Recovery resumes a stale owner | Generation fencing before execution and at each effect | P2 |
| Timeout causes two executors | Treat acceptance as unknown until reconciled; never switch automatically | P2 |
| General shell bypasses role restrictions | Omit arbitrary shell from the initial supervisor; use guarded typed operations | P1 |
| Cancellation leaves external processes running | Verify process-group termination and retain an unresolved state when uncertain | P2 |
| Dependency cannot reproduce required behavior | Keep current path available; pause promotion and document incompatibility | Every gate |
| Existing routine-note delivery can duplicate | Preserve and measure existing behavior; track deduplication as distinct work | Prototype evaluation |
| Broader runtime design becomes unnecessary abstraction | Extract only operations proven by the prototype and actual call sites | Phase 1 |

## Alternatives and decisions

Retaining the current branch is the baseline and the rollback path. A fake terminal adapter would preserve the current backend shape but conceal structured execution state. Replacing FirstMate control records with Durable Documents would enlarge the migration and couple operational authority to one harness. A general external runtime plugin is attractive after a stable provider contract exists; introducing it before the prototype would add packaging work before the semantics are proven.

The selected option is an in-tree experimental provider behind a narrow supervision seam. It minimizes the initial change surface while allowing the eventual session and durable implementations to share a proven contract.

## Future direction

Durable Pi crewmates should remain explicitly selected until measured outcomes justify automatic routing. Dispatch can eventually consider harness, runtime, model, effort, environment, and capability profile. Routing must first filter for compatibility and authority; cost and performance preferences operate only within the eligible set.

Remote tools may execute in a Proxmox VM or container while the conversation service remains elsewhere. That work requires independent designs for authenticated transport, path mapping, credentials, resource limits, network failures, and orphan cleanup. Tool selection alone is not a sandbox.

An `execution-runtime/1` extension contract is a future proposal. Its packaging can reuse FirstMate's trust practices after installation, capability negotiation, versioning, and state migration are specified. Existing terminal clients can remain interfaces for session workers; structured clients can attach to durable workers without owning their lifecycle.

## References

- S1: [FirstMate Pi supervision branch](https://github.com/kunchenguid/firstmate/blob/main/docs/pi-supervision-branch.md), reviewed 3 October 2026.
- S2: [FirstMate architecture](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md), reviewed 3 October 2026.
- S3: [Pi Durable design](https://earendil.com/posts/pi-durable/), published 1 October 2026, reviewed 3 October 2026.
- Implementation verification targets: [FirstMate configuration](https://github.com/kunchenguid/firstmate/blob/main/docs/configuration.md) and [Pi source repository](https://github.com/earendil-works/pi). Pin exact revisions before coding.
