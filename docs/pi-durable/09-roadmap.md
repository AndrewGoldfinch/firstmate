# Pi Durable roadmap

Two layers, named apart from now on:

- **Durable Outcome** — `operation -> persisted outcome` idempotency. **Proven; frozen.**
- **Durable Delivery** — `persisted outcome -> externally delivered presentation` idempotency. **Next hypothesis.**

## Status

| Stage | State |
| --- | --- |
| Prototype 0 — Durable Outcome persistence | **Complete.** Claim proven; frozen; no further work on append dedup. |
| Spike 1 — make real-path F09 reproducible | **Complete.** See [`development.md`](development.md) "Spike 1 — real-path F09 reproduction"; the real Pi reconcile path reproduces F09 headlessly (`tests/fm-pi-branch-extension.test.sh`). |
| Prototype 1 — Durable Delivery boundary | **Implemented, HOLD - IMPLEMENTATION.** Durable delivery identity landed (`3d8cf6c4`), but independent verification (`11-delivery-verification.md`) found the streaming defect below; fix in progress. |
| Phase 1 adoption | Gated on adversarial real-path F09 elimination. |

## Prototype 1 — Durable Delivery boundary (implemented; under fix)

Durable delivery identity for routine notes is opt-in (`FM_PI_DURABLE_DELIVERY`): a routine note stores its own delivery record keyed by store `seq`, so a reload finds it and delivers nothing again; a sequence match with different content fails closed; the default path is unchanged.

**HOLD - IMPLEMENTATION (streaming).** Independent verification (`11-delivery-verification.md`) found that on the real Pi path a reconcile during main's streaming turn uses `pi.sendMessage(..., { deliverAs: "nextTurn" })`, which queues the message in memory until the next prompt flush. The session entry is therefore not yet persisted, `ensureRoutineOutcome` cannot see it, re-delivers, and then advances `mark-read` — duplicating the note and, on a crash after the ack, losing it. The shipped fixture persisted synchronously so it could not observe this.

Fix in progress: make the routine delivery record durable **before** the cursor advances (synchronous append keyed by `seq`, or refuse to advance `mark-read` while the delivery is only queued), and extend the fixture to model `nextTurn` deferral and re-run F09 with `mainStreaming` true.

## Prototype 0 — Durable Outcome persistence (complete)

Proven claim: durable execution prevents duplicate outcome **appends** caused by replay/retry (the replayed append commits exactly one row per logical note). The symmetric F09 lane also established the negative: durable execution does **not** prevent duplicate externally visible routine-note **delivery**, because routine presentation occurs downstream in a shared, non-idempotent consumer.

Evidence: `docs/pi-durable/06-evaluation-report.md`; verifications `08-benefit-verification.md` and `10-benefit-verification-2.md`; the symmetric lane in `06` (existing 30/30 vs durable 30/30 duplicate deliveries, one stored row on durable replay).

## Spike 1 — make real-path F09 reproducible (next)

Before changing any contract, reproduce the exact sequence through the **real Pi extension**:

```
routine note delivered -> cursor write fails -> note stays unread -> re-present on retry
```

If this cannot be driven headlessly, **stop and document why** rather than building around another reduced model. This retires the real-Pi-fidelity residual risk and is the precondition for Prototype 1.

## Prototype 1 — Durable Delivery boundary (conditional)

Only if Spike 1 succeeds. Introduce **durable delivery identity** — something like `(outcomeSeq, destination/presentation target)` with a durable state transition — so the system knows a particular external delivery already happened independently of whether the read cursor advanced. Keep the proven append durability unchanged.

Re-run the exact symmetric F09 experiment. Promotion criterion:

- existing path: duplicate delivery under the injected fault;
- new durable-delivery path: exactly one externally visible delivery;
- no lost delivery; no stale-owner delivery;
- replay/restart/takeover preserve those invariants.

Then adversarially attack the new boundary: delivery started -> crash; delivery succeeds -> ack persistence fails; concurrent consumers; takeover; partial ledger recovery; ack-owner change.

## Phase 1 gate

Advance only when the real Pi path demonstrates that a committed routine note is externally delivered **at most once** across the documented F09 failure window, while preserving at-least-once recovery and authority correctness. ("At most once" alone can be achieved by dropping messages; the target is exactly-once observable behavior for this delivery path, built from durable identity and recovery semantics.)

## Residual risk carried forward

Full Pi integration fidelity has not been empirically validated because the live SDK cannot be exercised in the prototype environment; Spike 1 is the mandatory validation of that risk before Prototype 1.

Design analysis: `data/pi-durable-f09-design/report.md` (FirstMate home).
