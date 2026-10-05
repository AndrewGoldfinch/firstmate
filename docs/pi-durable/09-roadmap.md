# Pi Durable roadmap

Two layers, named apart from now on:

- **Durable Outcome** — `operation -> persisted outcome` idempotency. **Proven; frozen.**
- **Durable Delivery** — `persisted outcome -> externally delivered presentation` idempotency. **Next hypothesis.**

## Status

| Stage | State |
| --- | --- |
| Prototype 0 — Durable Outcome persistence | **Complete.** Claim proven; frozen; no further work on append dedup. |
| Spike 1 — make real-path F09 reproducible | **Complete.** See [`development.md`](development.md) "Spike 1 — real-path F09 reproduction"; the real Pi reconcile path reproduces F09 headlessly (`tests/fm-pi-branch-extension.test.sh`). |
| Prototype 1 — Durable Delivery boundary | **Verified (ADVANCE).** After five fix/verify iterations the delivery boundary is exactly-once across the documented F09 crash windows; see [`21-reservation-verify.md`](21-reservation-verify.md). |
| Phase 1 adoption | **Gate met; captain call held** (`pi-durable-phase1-promotion`). Documented residuals: free-running multi-process races untested; a committed reservation whose recorded-destination record is externally destroyed strands. |

## Prototype 1 — Durable Delivery boundary (verified)

Durable delivery identity for routine notes is opt-in (`FM_PI_DURABLE_DELIVERY`): a routine note stores its own delivery record keyed by store `seq`, so a reload finds it and delivers nothing again; a sequence match with different content fails closed; the default path is unchanged.

**Verified (ADVANCE).** Five fix/verify iterations closed the delivery-boundary defects, each found by an independent real-SDK adversarial pass: streaming persistence (`11`/`12`), home-wide identity + flush-durable guard (`14`/`15`), adoption-safe rollback (`16`/`17`), reserve-before-append (`18`/`19`), and finally a recoverable `reserved → committed` reservation (`20`). Verification `21-reservation-verify.md` returns ADVANCE: every documented crash window recovers to exactly one durable record with no loss and no duplicate, the stale-owner fence holds, concurrent reclaim is CAS-guarded, reconcile is idempotent, and the default/frozen surfaces are unchanged.

Documented residuals: free-running multi-process races are untested (the probe forces interleavings with real `SIGKILL`/`SIGSTOP`); a committed reservation whose recorded-destination record is externally destroyed strands (no duplicate/loss of a live record); legacy bare/empty markers inherit that strand.

## Prototype 0 — Durable Outcome persistence (complete)

Proven claim: durable execution prevents duplicate outcome **appends** caused by replay/retry (the replayed append commits exactly one row per logical note). The symmetric F09 lane also established the negative: durable execution does **not** prevent duplicate externally visible routine-note **delivery**, because routine presentation occurs downstream in a shared, non-idempotent consumer.

Evidence: `docs/pi-durable/06-evaluation-report.md`; verifications `08-benefit-verification.md` and `10-benefit-verification-2.md`; the symmetric lane in `06` (existing 30/30 vs durable 30/30 duplicate deliveries, one stored row on durable replay).

## Spike 1 — make real-path F09 reproducible (completed)

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

The installed SDK, extension, session files, and headless transcript renderer are now exercised directly by the [real-SDK probe](13-real-sdk-delivery-probe.md).
Its lifecycle triggers and ownership replacement are controlled by the lab; it does not establish full live-model, terminal, lock-acquisition-protocol, or host-reboot fidelity.

Design analysis: `data/pi-durable-f09-design/report.md` (FirstMate home).
