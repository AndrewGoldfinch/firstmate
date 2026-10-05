# Independent adversarial verification of the pi-durable benefit-validation result

Task: `pi-durable-benefit-verify`. Scope: verify the promotion-gate claim landed in commit
`3fde7863` (`feat(pi-durable): measure duplicate-outcome and operator benefit against the
promotion gate`). Deliverable: this report. No repository code was modified; the two added files
(`runtime/pi-durable/eval/benefit-rerun.ts`, `runtime/pi-durable/eval/verify-lanes.ts`) are scratch
harnesses in a disposable worktree and were not committed.

Claim under test (from `docs/pi-durable/06-evaluation-report.md:93-150` and
`docs/pi-durable/eval-results.json`):

- Duplicate avoidance: arm A (existing) 30 duplicates in 30/30 runs; arm B (durable) 0 in 0/30.
- Operator burden: arm A 30 interventions / 30 commands in 30/30 runs; arm B 0/0 in 0/30.
- Recovery time: 940.5 ms -> 411.6 ms, 56.23% lower.
- Gate: duplicate reduction yes, operator reduction yes, recovery parity yes, zero stale-owner
  actions yes -> CLEARED / advance.

## Commands run

```
git fetch origin && git checkout 3fde7863          # detached scratch worktree
cd runtime/pi-durable && npm ci                     # installed missing deps (91 packages)
npm run typecheck                                   # exit 0
npm test                                            # 81 pass / 0 fail
node --test tests/eval.test.ts                      # 1 pass / 0 fail (FM_PI_DURABLE_BENEFIT_RUNS=2)
BENEFIT_RUNS=10  node eval/benefit-rerun.ts         # independent 10-run replay
BENEFIT_RUNS=30  node eval/benefit-rerun.ts         # independent 30-run replay
node eval/verify-lanes.ts                           # store control, barrier lanes, concurrency, takeover, forensic
node -e '<independent Wilson/Newcombe recompute>'   # cross-check intervals
node -e '<read docs/pi-durable/eval-results.json>'  # committed numbers
```

`node eval/main.ts` was **not** run to completion: its own honest-limitations section states the
pilot's answers vary between runs (`runtime/pi-durable/eval/main.ts:336`), so the full entry point is
non-deterministic and would also rewrite the committed tracked evidence files. The task's stated
fallback ("otherwise re-run the benefit harness directly") was used instead.

Unix sockets **do work** in this environment: every arm-B run starts `DurableSidecar` on a Unix
socket and serves `ensureSupervisor`/`dispatch`/`appendOutcome`; the 30-run replay and all barrier
lanes completed. No `listen EPERM`.

Independent 30-run replay (my run, different absolute timings, same result):

```
SUMMARY runs=30 dupEx=30/30 dupDur=0/30 dupDiff=1.0000[0.8395,1.0000]
 opEx=30/30 opDur=0/0 opDiff=1.0000[0.8395,1.0000]
 recEx=1097.0 recDur=479.2 redPct=56.32 noise=1 thresh=30 recVerdict=improved
 stale=0/0 gate={"duplicateReduction":true,"operatorReduction":true,"recoveryParity":true,
 "zeroStaleOwnerActions":true,"verdict":"advance"}
```

10-run replay:

```
SUMMARY runs=10 dupEx=10/10 dupDur=0/10 dupDiff=1.0000[0.6075,1.0000]
 opEx=10/10 opDur=0/0 opDiff=1.0000[0.6075,1.0000]
 recEx=1095.8 recDur=476.8 redPct=56.49 noise=3 thresh=30 recVerdict=improved
 stale=0/0 gate={... "verdict":"advance"}
```

Committed `docs/pi-durable/eval-results.json` (for comparison):

```
runs=30 dupEx=30/30 dupDur=0/30 dupDiffLo=0.8395
opEx=30/30 opDur=0/0 opDiffLo=0.8395
medEx=940.5 medDur=411.6 noise=1 thresh=30 redPct=56.23 staleEx=0 staleDur=0
gate={"duplicateReduction":true,"operatorReduction":true,"recoveryParity":true,
"zeroStaleOwnerActions":true,"verdict":"advance"}
```

## Required verification table

| # | Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- | --- |
| 1 | Arm A fidelity | PASS (append boundary), scope caveat | `bin/fm-branch-report.sh:120` and `.pi/extensions/fm-branch-supervision.ts:1255` both append with no `--operation-key`; `runner.ts:268,296,329` drives that same real script and records the effect unconditionally; `.pi/extensions/fm-branch-supervision.ts:58` confirms a mid-handling death re-presents the wake row, so the restarted branch re-runs and re-appends. `verify-lanes PART5 existing`: `dup=1 t3Effects=[T3>outcome:T3,T3>outcome:T3] t3StoreRows=2`. Caveat: the *documented* routine-note limitation is delivery re-presentation (`.pi/extensions/fm-branch-supervision.ts:1178-1195`, `docs/pi-durable/06-evaluation-report.md:52`), which this arm does not model. | Append duplication is real, but the measured phenomenon is not the documented delivery limitation; the "duplicate outcome" wording covers a different, though real, defect. |
| 2 | Fault equivalence | PASS | Arm A appends then crashes before prune (`runner.ts:329-336`), leaving the wake queued. Arm B settles (`service.ts:668-670`), the harness records the effect (`runner.ts:145`), then crashes and retries. `PART5 durable` notes show `replayed=false` on the first effect then `replayed=true` on retry, i.e. the effect was committed before the crash in both arms. | Comparison is on the same effect-before-acknowledgement boundary. |
| 3 | Ledger accuracy | FAIL | For arm B the non-idempotent ledger is gated on the implementation's own replay flag: `if (!result.replayed) ledger.apply(...)` (`runner.ts:145,167`). Barrier `appendOutcome.commit` (effect applied, receipt not yet stored) produced `storeRows=6` but `effects=5`: an applied effect was **not** recorded. Also `operatorBurden.commands = interventionCount` (`benefit.ts:324`) and `interventions.reconcile = duplicateEffectCount` (`benefit.ts:165`), so the two gate clauses are the same number. | Ledger is not observation-only for arm B and can hide a duplicate the implementation self-reports as replayed; the operator-burden clause is not independent evidence. |
| 4 | Identity->effect crash | PASS | Barrier `appendOutcome.before` (`service.ts:897`, before `sink.appendOrGet` at `:904`): `dup=0 effects=5 storeRows=6`; retry appends once. | No arm-B duplicate. |
| 5 | Effect->completion crash | PASS | Barrier `appendOutcome.commit` (`service.ts:913`, after append, before `recordReceipt` at `:914`): `dup=0 effects=5 storeRows=6`; retry hits the operation-key dedup (`fm-branch-outcome.sh:549-551`) and writes nothing new. | No arm-B duplicate (but see row 3 under-count). |
| 6 | New-owner takeover | PASS | `PART4`: ensure generation 2 then re-append the same operation -> `refused sidecar refused the outcome append: AUTHORITY_STALE rows=1` (`service.ts:864-870`). | No duplicate; a stale/new owner is refused, so an orphaned effect is lost rather than duplicated. |
| 7 | Concurrent retry | PASS | `PART3`: two concurrent `appendOutcome` calls for one operation -> `seqs=1,1 rows=1 keys=fm:...:T3:1`. | No duplicate; the outcome lock plus operation-key make it atomic. |
| 8 | Partial-ledger replay | PASS | `appendOutcome.commit` then retry (same as row 5): `dup=0`, one store row. `dispatch.settle.after` (`service.ts:670`): `dup=0 storeRows=6`. | No duplicate. |
| 9 | Ack-owner change | PASS | Same takeover lane as row 6; receipt/append is authority-guarded by `ownerGeneration` (`service.ts:558-575, 864-870`). | No duplicate; the ack path refuses a replaced generation. |
| 10 | Dedup-disabled control | PASS (causal) | `PART1 store-causal`: with operation key -> `seqs=1,1 rows=1`; without key -> `seqs=1,2 rows=2`. Arm A (no key) duplicates 30/30. | Confirms the benefit comes from the operation-identity dedup, not runner differences. |
| 11 | Actual Pi-path trials | UNDRIVABLE | The real Pi branch extension requires the live SDK; the opt-in live guard points `PI_CODING_AGENT_DIR` at an empty directory so the branch reads no credentials and its first prompt rejects settlement, i.e. it never performs an outcome append (`tests/fm-pi-branch-live-e2e.test.sh` header, `fm_live_gate opt-in FM_PI_BRANCH_LIVE_E2E`). The extension unit test stubs the Pi SDK and models no crash between append and wake handling (`tests/fm-pi-branch-extension.test.sh` header). | Not confidence. Carried as explicit residual risk into Phase 1 (see below). |

## Detailed findings per original question

### 1. Fault equivalence
Equivalent. Both arms reach the same externally visible effect (the outcome append) and die before
the logical acknowledgement: arm A appends at `runner.ts:329` and crashes before `wakePrune`
(`runner.ts:336-346`); arm B commits the effect and then the harness manufactures the restart
(`runner.ts:145-153`). `PART5 durable` shows the first attempt `replayed=false` (real first effect)
and the retry `replayed=true`, proving the effect preceded the crash. No bias toward B on this axis.

### 2. Arm A fidelity
Faithful at the append/queue boundary, but not a model of the *documented* limitation. The real
report surfaces call `fm-branch-outcome.sh append` with no operation key
(`bin/fm-branch-report.sh:120`; `.pi/extensions/fm-branch-supervision.ts:1255`), and the store only
deduplicates when `--operation-key` is present (`bin/fm-branch-outcome.sh:82,549-551`;
`runtime/pi-durable/src/outcome-sink.ts:77`). The wake row is intentionally durable until the drain
acknowledges, so a mid-handling death re-presents the row
(`.pi/extensions/fm-branch-supervision.ts:58`), and the restarted branch re-runs and re-appends. The
forensic trace shows arm A producing two store rows for T3. So the re-append is the real path's
behaviour, not an artefact invented by the runner.

The gap: the limitation that the project actually documents is routine-note *delivery*
re-presentation after a failed cursor write (`.pi/extensions/fm-branch-supervision.ts:1178-1195`;
`docs/pi-durable/06-evaluation-report.md:52`; follow-up `fm-pi-routine-delivery-idempotency-followup-r1`).
Arm A measures a *second store row*, a distinct (and arguably worse) effect. The gate's "duplicate
outcome" claim therefore demonstrates real append non-idempotency but not the documented delivery
limitation.

### 3. Ledger accuracy
Two problems. (a) The ledger is honest in `effects.ts` (every `apply` recorded) but the harness
decides *whether* to call `apply` for arm B from the implementation's own replay flag
(`runner.ts:145,167`), so it is not an independent observation endpoint: a durable sink that
re-applied an effect while reporting `replayed=true` would be invisible. The `appendOutcome.commit`
lane makes the under-count concrete (`effects=5` vs `storeRows=6`). (b) For the measured scenario it
does not manufacture duplicates, and arm A's side is recorded unconditionally (`runner.ts:329`), so
the 30/30 vs 0/30 duplicate result is not fabricated.

### 4. Operator-burden independence
Not independent. `interventions.reconcile = duplicateEffectCount`
(`benefit.ts:163-168`), `resubmit = lostOutcomeTasks` (0 here), `restart = 0`, and
`existingCommands: interventionCount` (`benefit.ts:322-324`). Therefore
`operatorReduction` (`:372`) uses the same per-run predicate as `duplicateReduction` (`:371`), and
the interval/difference is numerically identical (both `0.8395`). The gate's two clauses are one
phenomenon counted twice. Additionally `zeroStaleOwnerActions` can never fail: both traces hardcode
`allowedOwners: ["branch"]` (`runner.ts:205,362`) and every arm records owner `"branch"`.

### 5. Statistics
Correct. An independent Wilson/Newcombe implementation reproduced the report exactly:

```
n=30 A=100.0%[88.65,100.00] B=0.0%[0.00,11.35] diff=100.0pt[83.95,100.00]
n=10 A=100.0%[72.25,100.00] B=0.0%[0.00,27.75] diff=100.0pt[60.75,100.00]
```

This matches `benefit.ts:121-139` and `docs/pi-durable/06-evaluation-report.md:106-110`. No
arithmetic issue.

### 6. Arm B counterexamples
None found. I attempted every interleaving the captain listed and could not force an arm-B
duplicate (rows 4-9). The reason is structural: the append is keyed by the operation identity
(`service.ts:904`; `fm-branch-outcome.sh:549-551`), the operation is `settled` before any append
(`service.ts:670`), the receipt short-circuits a second `appendOutcome` (`service.ts:880-882`), and
the ownership lock plus per-generation authority refuse concurrent or stale writers
(`service.ts:558-575, 864-870`). A duplicate would require losing the store row while keeping the
operation pending, or two distinct operation ids for one logical operation — neither is in the
failure model. Arm A can avoid a duplicate only where the crash lands before the append, in which
case it instead loses the outcome and needs a resubmit; that boundary is not in the 30-run sample.

### 7. Recovery time
Not load-bearing. `recoveryTime` is computed and reported (`benefit.ts:353-356,417`) but is **not**
part of the promotion gate (`benefit.ts:374`). Its absolute medians are unstable between runs
(committed 940.5/411.6 ms vs my replay 1097.0/479.2 ms, ~17% apart) even though the ratio stayed
~56%. The lab itself notes the threshold is a local noise floor and warns a measured improvement
must exceed several times the noise (`runtime/pi-durable/eval/main.ts:339`). Treat it as noise, not
a selling point.

### Forensic trace (ask 5)
```
PART5 existing: dup=1 t3Effects=[T3>outcome:T3,T3>outcome:T3] owners=[branch x7] t3StoreRows=2
 faults=existing owner lost T3 after its outcome was appended
 notes=T3: effect applied, wake row left queued after the crash | T3: recovered on the restarted owner
PART5 durable:  dup=0 t3Effects=[T3>outcome:T3] owners=[branch x6] t3StoreRows=1 t3Ops=settled:3
 faults=pi-durable owner lost T3 after settlement
 notes=T3: seq=3 replayed=false | T3: settled; the retry must replay without a second effect
       | T3: recovered seq=3 replayed=true
```
One operation id, end to end: arm A executes it twice at the effect boundary; arm B replays it once.

## What remains uncovered / residual risk

- **Actual Pi-path trials (row 11): UNDRIVABLE here.** No trial drove the real Pi
  `fm_branch_report` tool through a live model turn and then crashed/restarted it, so the exact
  timing of the real extension between append and wake acknowledgement is not exercised
  end-to-end. This is an explicit residual risk carried into Phase 1, not confidence. The
  mechanism is confirmed only at the layer the runner can drive (real store, real queue/claim,
  deterministic responder). `docs/pi-durable/06-evaluation-report.md` already acknowledges this
  reduction.
- The benefit sample exercises one fault boundary on one task (`FAULT_TASK = T3`,
  `benefit.ts:31`). Other interleavings are covered, if at all, by the correctness matrix.
- Store loss / operation-id reuse / home replacement are outside the model; a lost
  operation-key row would remove the dedup backstop.
- `zeroStaleOwnerActions` is vacuous and should be redesigned before it counts as gate evidence.
- Recovery time is not in the gate and is noisy; do not cite it as a benefit.

## Recommendation

The underlying duplicate-avoidance mechanism is real: the store-level causal control passes
(with key -> 1 row, without key -> 2 rows), and no tested interleaving made arm B duplicate. If the
captain's only claim is "the durable sink prevents append duplication at the post-effect boundary",
that single claim is supported.

The promotion gate as reported, however, is **overstated as evidence**: the operator-burden clause
is a recount of the duplicate clause, `zeroStaleOwnerActions` cannot fail, recovery time is not in
the gate and is noisy, the arm-B ledger is gated on the implementation's self-report (and demonstrably
under-records an applied effect), the documented routine-note limitation is not the phenomenon
measured, and the real Pi path was not exercised. Redesign the experiment to observe effects
independently of arm B's replay flag, to measure operator burden independently, to make the
stale-owner check non-vacuous, to target the documented delivery limitation directly, and to drive
or acceptably substitute for the real Pi path.

HOLD - EVIDENCE
