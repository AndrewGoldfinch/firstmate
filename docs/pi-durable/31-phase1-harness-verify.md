# Phase 1 pilot harness fix — independent adversarial re-verification

- Verified commit: `4f2963873b3692f92d141bf67fe07e41fbd56717` (detached; parent `f09520fa`). `git status --porcelain` is empty: no repository code was modified.
- Issue under test: I1 from `docs/pi-durable/30-phase1-pilot-verify.md` (pre-Phase-1 byte-for-byte baseline gate swallowed by `try/catch`), plus I2 (soak dedup metric).
- Environment: Pi `1.0.4`, Node `v22.21.1`, Linux. Scratch labs under `/tmp/verify-phase1/`, not committed.
- Method: read the fix diff (`f09520fa..4f296387`) and the probe end to end; rebuilt the guard's exact lab by hand; ran the probe with a genuine baseline, a mutated baseline, a syntactically broken baseline, and the pre-fix probe; re-ran every shipped suite; demonstrated the old-vs-new duplicate metric synthetically.

## Verdict summary

The fix does what its message claims: with a baseline provided, the byte-for-byte comparison is now outside the `try` and a body mismatch fails the run with a named mismatch; the soak counts raw durable entries and gates `totalDeliveries == cyclesCompleted` and `totalRecords == totalDeliveries`. I independently reproduced the mutated-baseline failure (exit 1) and confirmed the old gate was defeatable (pre-fix probe with the same mutated baseline exits 0 with `verdict=PASS`), so the shipped negative control is non-vacuous. All four shipped suites pass.

One brief expectation is falsified: a **genuine baseline load/import failure is not tolerated** — it is recorded as a residual *and* then hard-fails via the new unconditional `assert.equal(report.baselineCompare, "identical")`. This matches the commit message ("an unloadable baseline now fails the run") but contradicts the brief's challenge 2 and the probe's own inline comment at `:510-511`. It is the safe direction (no false PASS) and is unreachable in the shipped test (the baseline is always extracted from git and loads), so it does not weaken the gate. See N1.

## Challenge table

| # | Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- | --- |
| 1 | Byte assert sits outside the `try`; `baselineCompare === "identical"` asserted after, when a baseline is provided | PASS | `tests/assets/pi-phase1-probe.mjs:509` (`try`), `:512` (load only), `:513-516` (`catch`), `:517-522` (`if (baseline !== null)` with `assert.equal` at `:518`), `:525-526` (post-`try` identity assert) | Gate enforced |
| 2 | Mutated baseline body fails the run and names the byte mismatch (independent, not the shipped control) | PASS | Mutated baseline run: `exit=1`, no PASS verdict, `AssertionError ... the flag-off body must be byte-identical to the pre-Phase-1 baseline extension: "⛵MUTATED fixture: PHASE1_ROUTINE_NOTE"` thrown at `pi-phase1-probe.mjs:518:16`; `report-mut.json` `verdict=PROBE_FAILED` | Gate enforced |
| 3 | Shipped negative control is not vacuous | PASS | `sed` changes the rendered body (`⛵MUTATED ...`); pre-fix probe (`git show f09520fa:tests/assets/pi-phase1-probe.mjs`) with the same mutated baseline: `exit=0`, `verdict=PASS`, `baselineCompare="unavailable: the flag-off body must be byte-identical..."` — exactly what the control's `exit 0 || PASS` check fails on (`tests/fm-pi-phase1-pilot.test.sh:70-83`) | Not vacuous |
| 4 | Genuine baseline load/import failure still tolerated (residual, not hard failure) | **FAIL (falsified)** | Broken baseline file: `exit=1`, `verdict=PROBE_FAILED`, residual recorded (`baseline-extension-compare: could not load the pre-Phase-1 extension in this lab`) **and** hard failure from `assert.equal(report.baselineCompare, "identical")` at `pi-phase1-probe.mjs:525-526` (`baselineCompare=unavailable: worker exited 1/null: ... ParseError: Missing semicolon`) | Over-strict vs brief; safe direction; unreachable in shipped test (N1) |
| 5 | Soak counts raw durable entries and asserts delivery/record invariants | PASS | `pi-phase1-probe.mjs:580-583` (`homeDeliveryEntries` for duplicate/loss, `totalDeliveries += homeDeliveryEntries`), `:602-605` (`totalDeliveries == cyclesCompleted`, `totalRecords == totalDeliveries`); live run `totalRecords=2 totalDeliveries=2 cyclesCompleted=2 duplicates=0 losses=0` | Metric honest |
| 6 | Same-identity duplicate the old metric would hide | Demonstrated synthetically; unreachable via the shipped extension | `oldHomeRecords=1` vs `newHomeDeliveryEntries=2` on two entries sharing `seq:deliveryId`; extension makes a repeat append a no-op (`fm-branch-supervision.ts:1414` returns `appended:false` for an already-durable identity; `deliveryId = reservedId ?? randomUUID()` at `:1416`) | Detection strengthened; not reachable in lab |
| 7 | Flag-off body byte-identical to pre-Phase-1 baseline | PASS | `defaultPresentation.sha256 == baselinePresentation.sha256 == 8d9343e869b028cf8cb38491de196d55d1def9f8adc92b2b329e441d7ed860cd`; `baselineCompare="identical"`; hard-coded `EXPECTED_PLAIN_BODY` assert at `:501-502` | Default unchanged |
| 8 | Default path unchanged; frozen append untouched | PASS | `git diff-tree --no-commit-id --name-status -r 4f296387` = only `docs/pi-durable/29-phase1-pilot.md`, `tests/assets/pi-phase1-probe.mjs`, `tests/fm-pi-phase1-pilot.test.sh`; `.pi/extensions/fm-branch-supervision.ts` and `bin/fm-branch-outcome.sh` blobs identical `f09520fa`→`4f296387` (`27bd3d13…`, `959f96aa…`) | No runtime change |
| 9 | Shipped suites re-run green | PASS | see table below | No regressions |

### Shipped suites (re-run on `4f296387`)

| Suite | Command | Result |
| --- | --- | --- |
| Phase 1 pilot (incl. negative control) | `FM_PI_PHASE1_PILOT=1 bin/fm-test-run.sh tests/fm-pi-phase1-pilot.test.sh` | `FM_TEST_SUMMARY total=1 failed=0`, `exit=0`, 84.2 s; `ok - ... the byte-for-byte baseline gate fails on a mutated baseline` |
| Live e2e | `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` | `F09_PROBE_COMPLETE verdict=PASS`, `FM_TEST_SUMMARY total=1 failed=0`, `exit=0`, 42.4 s |
| Extension | `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` | `FM_TEST_SUMMARY total=1 failed=0`, `exit=0`, 77.8 s |
| Runtime unit tests | `(cd runtime/pi-durable && npm ci && npm test)` | `npm-ci exit=0`; `# tests 81 / # pass 81 / # fail 0`, `exit=0` |

## Per-question findings

**1. Gate is real — PASS.**
`try` now wraps only `captureDefaultPresentation(...)` (`:509-516`). The byte comparison (`assert.equal` at `:518-519`) and the `baselineCompare="identical"` assignment (`:520-521`) sit inside `if (baseline !== null)`, and the post-`try` `assert.equal(report.baselineCompare, "identical", ...)` at `:525-526` makes a passing verdict impossible unless the comparison actually ran and proved identical. Independent reproduction (not the shipped control):

```
$ FM_PHASE1_BASELINE_PLUGIN=.../fm-branch-supervision-baseline-mutated.ts FM_PHASE1_CYCLES=1 node tests/assets/pi-phase1-probe.mjs
exit=1
AssertionError [ERR_ASSERTION]: the flag-off body must be byte-identical to the pre-Phase-1 baseline extension: "⛵MUTATED fixture: PHASE1_ROUTINE_NOTE"
false !== true
    at scheduleLifecycleDefault (tests/assets/pi-phase1-probe.mjs:518:16)
```

`report-mut.json`: `verdict=PROBE_FAILED`, `baselineCompare=null` (the throw happens before it is set), i.e. the failure is **not** swallowed. The guard's negative control (`tests/fm-pi-phase1-pilot.test.sh:64-84`) mutates `MERGE_NOTE_BOAT` and requires non-zero exit plus the named mismatch; it is non-vacuous because the same mutated baseline drives the pre-fix probe to `exit=0 / verdict=PASS / baselineCompare="unavailable: ..."`, which its `exit 0 || PASS` branch fails on. (`sed` mutation verified to differ from the source: `cmp -s` non-zero.)

**2. No false failure — FAIL (falsified).**
A genuine load/import failure is caught (`:513-516`) and a residual is pushed, but it is **not** tolerated: `baseline` stays `null`, so the byte block is skipped and the unconditional `assert.equal(report.baselineCompare, "identical")` at `:525-526` fails the run. Evidence with a syntactically broken baseline file (`ParseError: Missing semicolon`):

```
exit=1
report-broken.json: verdict=PROBE_FAILED
  baselineCompare="unavailable: worker exited 1/null: ... ParseError: Missing semicolon ..."
  residuals=["baseline-extension-compare: could not load the pre-Phase-1 extension in this lab"]
error: "baseline comparison must be proven identical when a baseline is provided (baselineCompare=unavailable: ...)"
```

So the catch is correctly narrowed (it no longer swallows the comparison assertion), but its stated tolerance is nullified by the following assert. This contradicts the probe's own comment at `:510-511` ("Only a genuine load/import failure ... is tolerable here") and the brief, but matches the commit message ("a body mismatch or an unloadable baseline now fails the run"). The narrowed catch does not over-catch the comparison (proven by #1) and does not under-catch load errors (they are caught and reported). Net: no false PASS; a possible false failure only if the baseline cannot load, which the shipped test cannot trigger because it always extracts `1f3e7696:.pi/extensions/fm-branch-supervision.ts` and that file loads.

**3. Duplicate metric — PASS.**
The soak now uses `observed.homeDeliveryEntries` (raw `isDurableNote` count, `:246`) for both duplicate (`>1`) and loss (`<1`) detection (`:580-581`), accumulates it into `soak.totalDeliveries` (`:583`), and asserts `soak.totalDeliveries === soak.cyclesCompleted` (`:602-603`) and `soak.totalRecords === soak.totalDeliveries` (`:604-605`). `homeRecords` remains the deduplicated `${seq}:${deliveryId}` set size (`:218, :245`). Live run: `totalRecords=2 totalDeliveries=2 cyclesCompleted=2 duplicates=0 losses=0`.

Same-identity duplicate: I constructed the exact fixture the old metric hides (two durable notes sharing `seq:deliveryId`): `oldHomeRecords=1` vs `newHomeDeliveryEntries=2`. The new soak would set `duplicates += 1` and also fail `totalRecords == totalDeliveries`. I could **not** reach such a duplicate through the shipped extension: `deliveryId` is `reservedId ?? randomUUID()` (`fm-branch-supervision.ts:1416`) and an already-durable identity short-circuits to `appended:false` (`:1414`), so the new metric is defense-in-depth against a class of bug the extension currently prevents.

**4. Flag-off body / default path / frozen append — PASS.**
Both rendered bodies hash to `8d9343e8…`; `baselineCompare="identical"`; the hard-coded `EXPECTED_PLAIN_BODY` (`⛵ fixture: PHASE1_ROUTINE_NOTE`) is asserted at `:501-502`; the flag-off home never creates `state/.branch-outcomes-delivered` (`:503-505`). The fix commit touches only the doc, the probe, and the test — the extension, `bin/fm-branch-outcome.sh`, and `runtime/pi-durable/src/` are byte-identical to the pre-fix commit `f09520fa`.

**5. Shipped suites — PASS.** Table above; all four green.

## New issues

**N1 — A genuine baseline load/import failure hard-fails, contradicting the inline comment and brief challenge 2 (documentation/intent mismatch; safe direction).**
`tests/assets/pi-phase1-probe.mjs:510-511` says a genuine load failure "is tolerable here", but `:525-526` asserts `baselineCompare === "identical"` unconditionally whenever a baseline is provided, so a load failure becomes a hard failure. The commit message for `4f296387` explicitly states "an unloadable baseline now fails the run", so the behavior is intentional and the comment is the stale part. Impact: no false PASS; a possible false failure only when the baseline cannot be loaded, which the shipped guard cannot hit. Recommendation: either correct the comment at `:510-511` to say an unloadable baseline is fatal, or (if tolerance is the requirement) guard the final assert with `if (baseline !== null)` while keeping the residual — the former preserves the stronger gate.

The two backlog records disagree on the intended behavior, which is why this is surfaced as a captain call rather than a resolved recommendation. The fix task (`pi-durable-phase1-harness-fix`, backlog line 246) explicitly instructed "narrow the catch to genuine load/import errors and assert `baselineCompare==='identical'` after it when a baseline path is provided", and the commit message states "an unloadable baseline now fails the run" — both match the shipped code. This verification task (`pi-durable-phase1-harness-verify`, backlog line 4) instead requires that a genuine baseline load/import failure "must still be tolerated (not falsely fail)", which the shipped code does not do. The fix is faithful to its own instruction; the two requirements are mutually exclusive and one must be retired.

**N2 — Gate (and its negative control) are silently skipped when the baseline blob is absent (pre-existing residual, not introduced by this fix).**
The block is entered only when `FM_PHASE1_BASELINE_PLUGIN` is set *and* `fs.existsSync(...)` (`:506-507`), and `tests/fm-pi-phase1-pilot.test.sh:45-50` sets `baseline_plugin=""` when `git cat-file -e 1f3e7696:...` fails. In that case both the byte gate and the negative control are skipped and the suite still passes. This is an env-gated design inherited from the pilot, not a regression of `4f296387`.

## What remains uncovered

- I3 (unchanged by this fix): `pausePoint` and `handoverOrder` are both keyed on `i % 2` (`pi-phase1-probe.mjs:546,548`), so only 2 of the 4 pause-point × handover-order combinations are exercised.
- N2: baseline-absent silently disables the byte gate and its negative control.
- Same-identity durable duplicate: proven detectable by the new metric, but not reachable through the shipped extension; only the synthetic fixture demonstrates the divergence.
- The two schedules the doc already scopes out (free-running multi-process reclaim with no lock change; same-generation reclaim where two processes both resolve the lock as owned).
- Reclaim while the owner is alive but has lost the lock (liveness residual); filesystem without atomic `linkSync`/`renameSync`; cross-device marker directories; PID reuse; non-Linux `ps`; ancestry depth > 8.
- No CI wiring: the pilot remains an opt-in run (`rg -n 'phase1|PHASE1' .github/` is empty), so this is a point-in-time verification, not a standing regression guard.

ADVANCE
