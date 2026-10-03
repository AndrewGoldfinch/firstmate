# FirstMate Pi Durable Design Package

Version 1.2 • 3 October 2026

This package formalizes an optional Pi Durable execution provider for FirstMate. Initial delivery is the Pi supervision prototype in an isolated home. Later runtime integration, durable crewmates, routing, remote execution, and provider packaging are gated future work.

Read in order:

1. [Project design](01-project-design.md) - decision, scope, requirements, success criteria, risks, phases, and roadmap.
2. [Architecture](02-architecture.md) - ownership, topology, service protocol, identities, cross-store recovery, capabilities, events, and cancellation.
3. [Implementation plan](03-implementation-plan.md) - source verification, prototype work packages, fault matrix, evaluation, rollback, and later rollout.
4. [Evaluation harness](04-evaluation-harness.md) - controlled fleet problem, shared test environment, independent grading, A/B protocol, and benefit scorecard.
5. [Project agent guidance](AGENTS.md) - project-specific guidance linked from the fork's root agent instructions.

FirstMate-facing interfaces and file additions are proposals. The package does not claim repository implementation, full source audit, or executed prototype tests. Pin and verify current FirstMate and Pi dependencies during P0.
