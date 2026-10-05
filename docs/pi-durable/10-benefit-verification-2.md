# Independent adversarial verification of the corrected pi-durable benefit result

Task: `pi-durable-eval-verify` (scout). Deliverable: report only, no repository change.
Commit under test: `5f2cb653` (`fix(pi-durable): observe benefit deliveries independently and target the F09 delivery fault`), checked out detached on a clean default branch of a disposable worktree.

Method: read the corrected harness, then re-ran typecheck, the full test suite, and the benefit
harness directly. Most effort went into trying to falsify each correction. The headline result is
that the correction fixed four of the four prior HOLD clauses, but the fifth (wrong phenomenon
measured) is only half fixed: arm A now models the documented routine-note re-presentation, while
arm B is still observed at the store-row-commit boundary and is never subjected to the documented
F09 fault at all. Under the documented F09 fault the durable arm duplicates an externally visible
delivery exactly like the existing arm, so the promotion gate's duplicate-delivery claim is not
supported by the evidence.

Final verdict: **HOLD - IMPLEMENTATION** (see final line). Applying firstmate's exact mechanical rule: an arm-B duplicate exists under a legitimate interleaving (the documented F09 failed-cursor re-presentation applied to a durable-committed row), which maps to HOLD - IMPLEMENTATION. The second clause (delivery observation misrepresents F09) also applies, but the arm-B-duplicate clause is the stronger, first-listed trigger.

## Environment and commands run

```
$ git fetch origin && git checkout 5f2cb653
HEAD is now at 5f2cb653 fix(pi-durable): observe benefit deliveries independently and target the F09 delivery fault
$ node --version        # v22.21.1
$ npm install --no-audit --no-fund   # worktree node_modules was incomplete (missing typescript, chord, pi-durable); added 85 packages
$ npm run typecheck     # tsc --noEmit -> exit 0
$ npm test              # tests 81, pass 81, fail 0
$ node eval/scratch-benefit.ts   # runBenefit(30) directly, committed-evidence untouched
$ node eval/scratch-trace.ts     # one durable faulted scenario, full trace
$ node eval/scratch-f09.ts       # falsification: durable committed row under the F09 fault
```

**Unix sockets work here.** All 81 tests pass, including the sidecar socket tests, and
`runDurableScenario` starts a real `DurableSidecar` over a Unix socket for every run. This differs
from the prior reviewer environment noted in `docs/pi-durable/06-evaluation-report.md` ("listen
EPERM"). Scratch scripts are untracked and were not committed or pushed.

Benefit re-run (30 paired runs, `node eval/scratch-benefit.ts`):

```
promotionGate {"duplicateReduction":true,"durablePrevented":true,"staleOwnerVerified":true,
               "recoveryParity":true,"causalControlRecreated":true,"verdict":"advance"}
staleOwner    {"attempts":30,"accepted":0,"nonVacuous":true,"verdict":"pass"}
causalControl {"withOperationKey":1,"withoutOperationKey":2,"recreated":true}
duplicateDeliveries: existing 30/30 (rate 1, CI 88.65%-100%), durable 0/30 (rate 0, CI 0%-11.35%)
existingTotal=30 durableTotal=0 difference.lower=0.83946
existingDeliveries={7} durableDeliveries={6}; existingStaleAttempts=0 durableStaleAttempts=1
```

This reproduces the committed numbers in `docs/pi-durable/06-evaluation-report.md` (30/30 vs 0/30,
30 stale attempts / 0 accepted, 1 vs 2 rows).

## 11-challenge table

| # | Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- | --- |
| 1 | Arm A fidelity and F09 target (arm A) | PASS | `runner.ts:429-444` models the real loop: read unread rows, `deliveries.push({note:row.task})`, and a faulted `mark-read` returns without advancing the cursor; `reconcile()` runs again and re-presents. `benefit.ts:135-144` groups by logical `delivery.note`, not by row count. Matches the real extension at `.pi/extensions/fm-branch-supervision.ts:1158-1195`. | Arm A now measures the documented limitation, not a second store row. |
| 2 | Arm B fault equivalence and F09 target (arm B) | **FAIL** | Arm B's fault is `crashAfterSettleTask` (`benefit.ts:224`), not the failed-cursor re-presentation. Arm B has no presentation loop at all: `reconcile`/`mark-read` exist only in the existing arm (`runner.ts:429-444`); arm B `deliveries` are store-row deltas (`runner.ts:154-160`) and `trace.effects` are the outcome rows themselves (`runner.ts:276`). The real extension presents all unread rows regardless of arm (`.pi/extensions/fm-branch-supervision.ts:1158-1195`). Scratch `eval/scratch-f09.ts` drives one durable-committed row through the F09 fault and gets two presentations of T3. | The 0/30 durable result is an artifact of the observable, not evidence that durable prevents duplicate deliveries; `durablePrevented` cannot fail. |
| 3 | Independent observation (prior ledger gating) | PASS | `runner.ts:382,411,456` uses `EffectLedger` only in the existing arm. Arm B records no ledger; it observes the real store via `readOutcomeStore` (`runner.ts:155`, `outcomeScript=bin/fm-branch-outcome.sh`). `result.replayed` appears only inside note strings (`runner.ts:186,210`), never in observation logic. `scratch-trace.ts` reports `effects=6 outcomes=6 storeRows=6`; the old `effects=5/storeRows=6` under-count is gone. | Prior HOLD clause 3 resolved. |
| 4 | Arm B identity->effect crash | PASS (no duplicate) | Append is operation-keyed at `service.ts:904` (`sink.appendOrGet(request.operationId, ...)`) and `outcome-sink.ts:66-78` passes `--operation-key` to `bin/fm-branch-outcome.sh`; the store is append-or-return-existing (`fm-branch-outcome.sh:548-551`). Unit test `tests/outcome-sink.test.ts:35` ("same operation key ... appends once"). | No duplicate row. |
| 5 | Arm B effect->completion crash / partial-ledger replay | PASS (no duplicate) | `tests/bridge.test.ts:111` ("settled repeat without a receipt appends-or-gets exactly once") and `:95` ("settled repeat with a receipt appends nothing"); matrix F07/F08 pass. Same operation key on replay -> one row. | No duplicate row. |
| 6 | New-owner takeover / ack-owner change | PASS (refused) | `tests/bridge.test.ts:126`, `tests/dispatch.test.ts:258`, matrix F10/F13. In the benefit run the real attempt is refused with `AUTHORITY_STALE` (`scratch-trace.ts`). | No duplicate; stale owner refused. |
| 7 | Concurrent retry | PASS (no duplicate) | Ownership lock plus per-generation authority (`service.ts:558-575,864-870`); `tests/dispatch.test.ts:109,318`. Same key cannot produce two rows. | No duplicate row. |
| 8 | Non-vacuous stale-owner | PASS | `runner.ts:231-266`: a real second generation is ensured, then the superseded `staleTransport` (old `ownerGeneration`) calls `appendOutcome`; the result is recorded as `accepted`/`code`. Re-run: `{attempts:30, accepted:0, code:"AUTHORITY_STALE", nonVacuous:true}`. Gate predicate `staleOwnerVerified = staleNonVacuous && staleAccepted === 0` (`benefit.ts:283`) can now fail; grader negative control "accept a stale-owner action" is rejected. | Prior HOLD clause 4 resolved. |
| 9 | Dedup-disabled causal control | PASS | `runDedupCausalControl` (`runner.ts:472-500`) runs against the real store: with `--operation-key` 1 row, without it 2 rows; re-run `{1,2,recreated:true}`. Predicate `benefit.ts:186`. | Prior HOLD clause 10 resolved. |
| 10 | Statistics and operator burden | PASS | Re-computed Wilson (z=1.96) independently: 30/30 -> [0.8864829, 1], 0/30 -> [0, 0.1135171]; Newcombe lower = 0.8394626, matching the harness. `promotionGate` (`benefit.ts:280-288`) is `duplicateReduction && durablePrevented && staleOwnerVerified && recoveryParity && causalControlRecreated`; operator burden is absent (only in `limits`, `benefit.ts:329`). | Prior HOLD clause "operator burden recount" resolved. |
| 11 | Actual Pi-path trials | UNDRIVABLE (residual) | The live branch extension needs the live SDK; the benefit arms use the deterministic responder. Not exercised end-to-end. Carried as the explicit Phase 1 residual risk recorded in `06-evaluation-report.md`. | Not confidence; no gate impact. |

## Per-question findings

### 1. Independent delivery observation

PASS for the prior defect. Arm B no longer derives anything from `result.replayed` or from an
implementation self-report. `runDurableScenario` reads the real store through
`readOutcomeStore` (`runner.ts:155`) and computes per-task row deltas
(`runner.ts:154-160`). Its `trace.effects` are the outcome rows (`runner.ts:276`), so
`effects === outcomes` by construction. `scratch-trace.ts` confirms `deliveries=6 effects=6
outcomes=6` and the notes `T3: seq=3 replayed=false`, `T3: recovered seq=3 replayed=true` with no
second row. The `effects=5/storeRows=6` under-count from the prior run is gone.

What the observer still cannot see: an applied effect that does not create a store row. If the
durable sink re-applied a presentation without appending, arm B would not record it, because arm B
has no presentation observable. This is the same boundary problem as question 2.

### 2. F09 target

Arm A: PASS. The fault is now the documented routine-note re-presentation. `reconcile`
(`runner.ts:429-444`) presents each unread row, and on the fault task it pushes a delivery and
returns before `mark-read`; the second `reconcile` re-presents the still-unread row. The duplicate
count groups by logical note (`benefit.ts:135-144`), so the assertion is logical-note ->
delivered count for arm A.

Arm B: FAIL. The durable arm is not exposed to the F09 fault. Its fault is `crashAfterSettleTask`
(`benefit.ts:224`) and its delivery observable is a new store row (`runner.ts:154-160`), i.e.
append -> store-row count. It never runs the presentation loop, so it cannot re-present and its
duplicate count is structurally zero.

This is not just a modeling choice: the real extension that performs delivery reads the same store
for both paths and re-presents on a failed cursor write. `.pi/extensions/fm-branch-supervision.ts`
lines 1158-1195:

```
1158  const unread = await runOutcomeScript(["unread"]);
...
1177  // KNOWN PRE-EXISTING LIMITATION, unchanged by moving this work off Pi's
1178  // render thread and tracked as
1179  // fm-pi-routine-delivery-idempotency-followup-r1: if the mark-read
1180  // below fails after a ROUTINE note was already delivered, the row stays
1181  // unread and the next reconciliation sends that note a second time ...
1191  if (row.verdict === "captain") { ... } else { deliverRoutineOutcome(row); }
1195  if (!(await runOutcomeScript(["mark-read", "--through", String(row.seq)])).ok) return false;
```

The durable sidecar writes its outcomes into that same store (`outcome-sink.ts:1-13`,
`bin/fm-branch-outcome.sh`), so its committed routine rows are delivered by this same loop and are
subject to the same re-presentation. The harness never models that for arm B.

Concrete falsification (`eval/scratch-f09.ts`): run one durable faulted scenario (which commits one
row per task), then run the branch's own presentation loop with the cursor write failing on T3.
Result:

```
presentations ["T1","T2","T3","T3","T4","T5","T6"]
duplicates    [["T3",2]]
```

The durable arm produces exactly the duplicate externally visible delivery (one duplicate) that the
existing arm produces. The benefit harness reports `durableDuplicateDeliveries=0` for the same path
only because it stops counting at the commit and never presents.

Not a harness artifact: the store-level F09 case in `matrix.ts:641-670` independently confirms that
an unread routine row stays unread and is re-presented, and that a successful `mark-read` clears it
(`unreadAfterAck=0`). The re-presentation is a real property of the shared delivery loop, not of the
deterministic responder.

### 3. Arm B counterexamples

No duplicate store row found in any interleaving, consistent with the prior verifier and with the
unit tests: identity->effect (row 4), effect->completion and partial-ledger replay (row 5),
new-owner takeover and ack-owner change (row 6, refused `AUTHORITY_STALE`), concurrent retry (row
7). The structural reasons stand: operation-keyed append-or-return-existing, operation settled
before append, receipt short-circuit, ownership lock plus per-generation authority.

However, a legitimate arm-B duplicate **delivery** does exist once the documented F09 fault is
applied to a durable-committed row (question 2). It is a duplicate presentation, not a duplicate
row. The harness's row-based observable cannot see it.

### 4. Non-vacuous stale-owner

PASS. `runner.ts:231-266` performs a genuine owner replacement (`generation += 1`,
`ensureSupervisor`) and then the superseded owner attempts the append. Re-run result:
`{attempts:30, accepted:0, code:"AUTHORITY_STALE", nonVacuous:true}`. The gate predicate
`staleOwnerVerified = staleNonVacuous && staleAccepted === 0` (`benefit.ts:283`) is falsifiable:
acceptance would set `accepted=1` and the verdict to fail, and the grader's negative control
"accept a stale-owner action" is rejected. The prior hardcoded `allowedOwners:["branch"]` vacuity is
gone.

### 5. Causal control

PASS. `runDedupCausalControl` (`runner.ts:472-500`) runs directly against the real store,
independently of either arm: with `--operation-key` one row, without it two rows. Re-run:
`{withOperationKey:1, withoutOperationKey:2, recreated:true}`. The failure is recreated when
deduplication is disabled.

### 6. Statistics

PASS, recomputed independently. Wilson score intervals (z=1.96):
- 30/30 -> lower 0.8864829, upper 1 (committed 88.6%-100%).
- 0/30 -> lower 0, upper 0.1135171 (committed 0%-11.4%).
Newcombe difference lower = `1 - sqrt((1-0.8864829)^2 + (0.1135171-0)^2) = 0.8394626`, matching the
harness. The gate requires `difference.lower > 0` (`benefit.ts:280`). Note the two proportions are
treated as independent even though the runs are paired; with all discordant pairs in one direction
a paired test (McNemar) would give the same directional conclusion, so this does not change the
result. The concern is not the arithmetic but what the 0/30 counts.

### 7. Operator burden

PASS. The promotion gate is
`duplicateReduction && durablePrevented && staleOwnerVerified && recoveryParity && causalControlRecreated`
(`benefit.ts:280-288`). There is no operator-burden clause; `operatorBurden` and
`interventionCount` are absent from the harness, and operator burden appears only as a stated
limit (`benefit.ts:329`, `06-evaluation-report.md:146`).

## New issues found

1. **Arm B's delivery observable is not the externally visible delivery.** Arm B counts new
   outcome rows; the externally visible routine-note delivery is the presentation performed by
   `.pi/extensions/fm-branch-supervision.ts:1158-1195`, which is shared and unchanged by the
   durable sidecar. The paired comparison in `06-evaluation-report.md` therefore compares
   presentations (arm A) with commits (arm B) under two different faults.
2. **`durablePrevented` cannot fail.** `benefit.ts:281` (`durableDuplicateRuns === 0`) is always
   true because arm B has no presentation step and the store dedups on the operation key. The gate
   clause contributes no evidence; the entire duplicate claim rests on arm A.
3. **The scorecard wording overstates the result.** `06-evaluation-report.md` reports
   "Duplicate externally visible deliveries (paired fault runs) | 30 | 0" and
   "duplicate-delivery avoidance". The corrected harness supports "the durable sink does not append
   a duplicate outcome row on replay", not "durable execution prevents duplicate externally
   visible deliveries". This is the same overstatement the prior HOLD flagged, now reduced to
   arm B.
4. **Deliveries vs effects are the same array for arm B.** `runner.ts:154-160,276` make arm B's
   `deliveries` and `effects` two projections of the same store rows, so the grader's
   "no duplicate applied effect" and the benefit's duplicate-delivery count are not independent
   observations for arm B.

## What remains uncovered

- **Real-Pi fidelity is undrivable here and is a Phase 1 residual risk.** No trial drives a live Pi
  model turn through `fm_branch_report`, then crashes and restarts it. The benefit arms use the
  deterministic responder; the live branch extension is not exercised end-to-end. This is the
  residual risk already recorded in `06-evaluation-report.md` and carried verbatim into Phase 1.
- The benefit sample exercises one fault boundary on one task (`FAULT_TASK="T3"`,
  `benefit.ts:38`); other interleavings are covered by the correctness matrix and unit tests, not
  by the paired sample.
- Store loss, operation-id reuse across homes, and home replacement are outside the model; a lost
  operation-key row would remove the dedup backstop.
- Recovery time is not in the gate and its absolute medians vary between runs; it should not be
  cited as a benefit.

## Recommendation

The correction is real on four of the five prior HOLD clauses: the arm-B ledger is now an
independent store observation, the stale-owner check is non-vacuous (`AUTHORITY_STALE`), the
dedup-disabled control recreates the failure against the real store, operator burden is out of the
gate, and the statistics recompute exactly. Arm A now targets the documented F09 re-presentation.

The remaining defect is a concrete implementation gap in the harness, and the fix is clear: the
durable arm is measured at the row commit and is never subjected to the documented F09 delivery
fault, so its 0/30 is structural, and under that fault a durable-committed row is re-presented just
like the existing path (`eval/scratch-f09.ts`: T3 delivered twice). Give arm B the same
presentation/reconcile observable and the same failed-cursor fault as arm A, and state the narrow
supported claim ("no duplicate outcome append on replay") separately from the broad claim ("no
duplicate externally visible delivery"). This is an implementation change to `runner.ts` /
`benefit.ts` and their evidence, not a new experiment design, so it maps to HOLD - IMPLEMENTATION
under firstmate's mechanical rule. The unresolved captain call (accept the narrow claim or require
the corrected arm-B lane) is firstmate's to hold; this report is evidence only.

HOLD - IMPLEMENTATION
