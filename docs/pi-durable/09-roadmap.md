# Pi Durable roadmap

Two layers, named apart from now on:

- **Durable Outcome** — `operation -> persisted outcome` idempotency. **Proven; frozen.**
- **Durable Delivery** — `persisted outcome -> externally delivered presentation` idempotency. **Next hypothesis.**

## Status

| Stage | State |
| --- | --- |
| Prototype 0 — Durable Outcome persistence | **Complete.** Claim proven; frozen; no further work on append dedup. |
| Spike 1 — make real-path F09 reproducible | **Complete.** See [`development.md`](development.md) "Spike 1 — real-path F09 reproduction"; the real Pi reconcile path reproduces F09 headlessly (`tests/fm-pi-branch-extension.test.sh`). |
| Prototype 1 — Durable Delivery boundary | **HOLD - IMPLEMENTATION (targeted hardening).** The reservation-recovery loss is fixed, but a source review found the ADVANCE claims exceed the evidence: the takeover test does not forbid a stale append, reclaim is a read-compare-write (not atomic CAS), and a crash inside a marker write can leave an empty marker that strands a note. |
| Phase 1 adoption | **Held.** Gate not met: the milestone's full live-model/terminal/lock-acquisition/host-reboot fidelity is not established, and the three hardening checks above are pending. |

## Prototype 1 — Durable Delivery boundary (HOLD, targeted hardening)

Durable delivery identity for routine notes is opt-in (`FM_PI_DURABLE_DELIVERY`): a routine note stores its own delivery record keyed by store `seq`, so a reload finds it and delivers nothing again; a sequence match with different content fails closed; the default path is unchanged.

**Status: HOLD - IMPLEMENTATION.** Five fix/verify iterations closed real defects, and the reservation-recovery loss is fixed (pre-fix falsification `0 !== 1`; `21-reservation-verify.md` returns ADVANCE on the tested schedules). A subsequent source review found the ADVANCE claims exceed that evidence, and the targeted hardening checks are now required before promotion:
- **stale-owner append:** the takeover test asserts ownership changed, not that a stale owner is forbidden to append — make the assertion enforce the original invariant, and fix the code if a stale append is possible;
- **reclaim atomicity:** `reclaimReservation` reads, compares, then separately overwrites the marker (not atomic CAS); make it atomic or lock-serialized, with a probe forcing takeover between the compare and the overwrite;
- **marker-write crashes:** markers are written with a direct `writeFileSync`; a crash between creation/truncation and the JSON write can leave an empty marker that strands the note. Make marker writes atomic (temp + rename) or repair empty markers, with a deterministic crash probe.

Documented residuals (unchanged): free-running multi-process races untested; a committed reservation whose recorded-destination record is externally destroyed strands; legacy bare/empty markers inherit that strand.

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
