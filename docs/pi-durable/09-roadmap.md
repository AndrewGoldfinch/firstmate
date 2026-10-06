# Pi Durable roadmap

Two layers, named apart from now on:

- **Durable Outcome** — `operation -> persisted outcome` idempotency. **Proven; frozen.**
- **Durable Delivery** — `persisted outcome -> externally delivered presentation` idempotency. **Next hypothesis.**

## Status

| Stage | State |
| --- | --- |
| Prototype 0 — Durable Outcome persistence | **Complete.** Claim proven; frozen; no further work on append dedup. |
| Spike 1 — make real-path F09 reproducible | **Complete.** See [`development.md`](development.md) "Spike 1 — real-path F09 reproduction"; the real Pi reconcile path reproduces F09 headlessly (`tests/fm-pi-branch-extension.test.sh`). |
| Prototype 1 — Durable Delivery boundary | **Complete.** Loss/duplicate safety is structural and verified (both create and reclaim fenced by exclusive-create); the option-2 stale-delivery relaxation is accepted. See [`27-reclaim-claim.md`](27-reclaim-claim.md) / [`28-reclaim-claim-verify.md`](28-reclaim-claim-verify.md). |
| Phase 1 adoption | **Approved — bounded, opt-in Phase 1 pilot under option 2.** Pilot run (`29`) and independently verified (`30`): real `ps`-walked lock handover and a 60-cycle concurrent soak show 0 duplicates / 0 losses; flag-off path byte-identical. Harness gate defect I1 fixed and re-verified (`31`): the byte-for-byte gate now fails on a mismatch, the negative control is non-vacuous, and a same-identity duplicate is visible. Broader adoption waits on real-session use. |

## Prototype 1 — Durable Delivery boundary (resolved at an option-2 contract)

Durable delivery identity for routine notes is opt-in (`FM_PI_DURABLE_DELIVERY`): a routine note stores its own delivery record keyed by store `seq`, so a reload finds it and delivers nothing again; a sequence match with different content fails closed; the default path is unchanged.

**Status: loss/duplicate safety structural; option-2 stale-delivery relaxation.** The destructive stale-owner cleanup is removed (no code path deletes a durable record a replacement is adopting). Both **creation** and **reclaim** are fenced by exclusive-create (`linkSync`): creation via the marker, reclaim via a per-sequence `<seq>.claim` whose link *is* the publish, so no takeover can interleave. Verified across the doc-26 counterfactual and adversarial claim attacks — exactly one durable home-wide record and one visible delivery, no reachable duplicate or loss. The recorded **option-2 contract** still permits an already-authorized in-flight delivery to finish and be adopted after takeover, so the "a superseded owner cannot deliver" invariant is **not** met. Residuals: free-running multi-process reclaim untested; an externally corrupted `.claim` stalls a row (liveness-only, unreachable via the extension's own writes); a live-but-replaced owner stalls its row until it exits; a committed reservation whose record lives only in a different destination defers there. See [`27-reclaim-claim.md`](27-reclaim-claim.md) / [`28-reclaim-claim-verify.md`](28-reclaim-claim-verify.md).

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

## Prototype 1 — Durable Delivery boundary (promotion criterion — met)

Introduce **durable delivery identity** — something like `(outcomeSeq, destination/presentation target)` with a durable state transition — so the system knows a particular external delivery already happened independently of whether the read cursor advanced. Keep the proven append durability unchanged.

Re-run the exact symmetric F09 experiment. Promotion criterion:

- existing path: duplicate delivery under the injected fault;
- new durable-delivery path: exactly one externally visible delivery;
- no lost delivery; no stale-owner delivery;
- replay/restart/takeover preserve those invariants.

Then adversarially attack the new boundary: delivery started -> crash; delivery succeeds -> ack persistence fails; concurrent consumers; takeover; partial ledger recovery; ack-owner change.

## Phase 1 — bounded, opt-in pilot (approved)

The captain promoted Prototype 1 to a **bounded, opt-in Phase 1 pilot under option 2** on 2026-10-05, with the documented residuals accepted. Consolidates the former `pi-durable-phase1-final` / `pi-durable-phase1-contract` / `pi-durable-phase1-promotion` holds into one promotion decision.

- Delivery stays opt-in (`FM_PI_DURABLE_DELIVERY`); the default flag-off path is unchanged.
- **Option 2 stands:** an already-authorized in-flight delivery may finish and be adopted after takeover; the "superseded owner cannot deliver" invariant is **not** met.
- The no-loss/no-duplicate claim is scoped to the verified schedules (the lab-interleaved F09 schedules in `28`), not to free-running multi-process reclaim.
- Phase 1 must validate, before broader adoption: **real lock handover**, **normal session lifecycle**, and a **concurrent soak**.

The former gate text: advance only when the real Pi path demonstrates that a committed routine note is externally delivered **at most once** across the documented F09 failure window, while preserving at-least-once recovery and authority correctness. ("At most once" alone can be achieved by dropping messages; the target is exactly-once observable behavior for this delivery path, built from durable identity and recovery semantics.) The bounded pilot measures this on the real path; broader adoption follows only on its evidence.

**Pilot outcome (2026-10-05).** The bounded pilot (`29`) and its independent verification (`30`) confirm the runtime result on the real path: the extension's real `ps`-walked ancestry owns the lock (not a depth-0 self-pid), an in-flight handover under option 2 yields one visible delivery with no loss, and a 60-cycle concurrent soak shows **0 duplicates / 0 losses**; the flag-off body is byte-identical to the pre-Phase-1 extension (`8d9343…`). The harness gate defect found by `30` (the byte-for-byte baseline gate swallowed by a `try/catch`) was fixed and re-verified in `31`: a mutated baseline now fails the run and names the mismatch, the shipped negative control is non-vacuous, the soak counts raw durable entries, and an unloadable baseline is fatal rather than a passing residual. The lock/delivery logic was unchanged throughout. Broader adoption waits on real-session use.

## Residual risk carried forward

The installed SDK, extension, session files, and headless transcript renderer are now exercised directly by the [real-SDK probe](13-real-sdk-delivery-probe.md).
Its lifecycle triggers and ownership replacement are controlled by the lab; it does not establish full live-model, terminal, lock-acquisition-protocol, or host-reboot fidelity.

Design analysis: `data/pi-durable-f09-design/report.md` (FirstMate home).
