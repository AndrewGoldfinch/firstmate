# Pi Durable Phase 1 plan

Status: **conditional**. Phase 1 is approved only if the corrected-experiment adversarial verifier returns `ADVANCE`; this file records the captain's approval text and the first milestone so the call can be enacted immediately when it clears.

## Captain's conditional approval (verbatim)

> APPROVE Phase 1. The prototype has demonstrated a concrete correctness benefit against the documented existing-path failure mode: routine-note delivery can be duplicated after delivery-before-cursor-persist failure, while durable execution prevents duplicate externally visible outcomes across the tested adversarial interleavings. Independent effect observation, a non-vacuous stale-owner challenge, and the dedup-disabled causal control support the result. Full Pi execution-path fidelity remains unvalidated in the prototype environment and is a mandatory Phase 1 validation item before broader adoption.

## Mechanical decision rule (this verification round)

- Arm B duplicate found under any legitimate interleaving -> `HOLD - IMPLEMENTATION`
- Delivery observation depends on implementation metadata, or misrepresents F09 -> `HOLD - EVIDENCE`
- Stale owner can perform an accepted action -> `HOLD - IMPLEMENTATION`
- Dedup-disabled control fails to recreate the duplicate -> `HOLD - EVIDENCE`
- All of those pass -> `ADVANCE` to Phase 1.

Latency, operator burden, and any new benefit criteria are out of scope for this round.

## First Phase 1 milestone (narrow)

Wire the real Pi path just far enough to reproduce the same delivery-failure scenario and confirm the invariant survives outside the lab:

1. Drive the real Pi branch extension (or its report tool) through a live model turn far enough to deliver a routine note.
2. Inject the delivery-before-cursor-persist failure and restart, exactly as the lab fault does.
3. Confirm the durable path delivers the logical note once and the existing path can deliver it twice, using observation independent of either implementation's self-report.
4. Only after that: broaden into integration, ergonomics, rollout, or performance work.

## Residual risk

Full Pi execution-path fidelity has not been empirically validated because the live SDK cannot be exercised in the prototype environment. The first Phase 1 milestone above is the mandatory validation of that risk before broader adoption.

## Evidence of record

- Corrected benefit experiment and Decision: `docs/pi-durable/06-evaluation-report.md`.
- Prior verification (HOLD - EVIDENCE): `docs/pi-durable/08-benefit-verification.md`.
- Corrected-experiment verification: `data/pi-durable-eval-verify/report.md` (firstmate home; archived to `docs/pi-durable/` once its verdict is final).
