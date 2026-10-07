# Adversarial verification — startup-replay durable-delivery fix

Scout: `pi-durable-startup-replay-fix-verify`. Date: 2026-10-07.
Subject: commit `548fe337` ("fix(pi-durable): keep startup-replay from consuming durable-presentable rows"), merged as `ba75125b` on `experiment/pi-durable-supervision`. Follow-up to `docs/pi-durable/37-attended-pilot-rerun-review.md` (option 1) and `docs/pi-durable/38-startup-replay-durable-fix.md`.
Method: read the landed diff, the extension's durable gate, and the new test; then falsified each claim with direct `bin/fm-branch-outcome.sh` invocations against the post-fix script and a byte-identical copy of the pre-fix script (`git show 548fe337^:bin/fm-branch-outcome.sh`), plus the four requested test suites. Repository code was not modified; the only artifacts are this report and untracked scratch under `.scratch/`.

**Verdict: ADVANCE.** The fix is correct and complete for the stated contract. No row is consumed or stranded beyond the documented residual risk below.

## Challenge table

| # | Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- | --- |
| 1 | Cursor logic: all-silent run advances through the whole run | PASS | matrix A post: digest empty, cursor `2`, unread empty | none |
| 1 | Cursor logic: silent-then-non-silent advances only through the silent row | PASS | matrix B post: cursor `1`, unread `2` (pre-fix: cursor `2`, unread empty — the bug) | none |
| 1 | Cursor logic: non-silent-then-silent does not advance | PASS | matrix C post: cursor `(none)`, unread `1,2` (pre-fix: cursor `2`) | none |
| 1 | Cursor logic: leading captain row bars the whole replay set | PASS | matrix D post: digest empty, cursor `(none)`, unread `1,2` | none |
| 1 | Cursor logic: first row non-silent → no advance | PASS | matrix E post: cursor `(none)`, unread `1` (pre-fix: cursor `1`) | none |
| 1 | Cursor logic: silent,silent,non-silent,silent stops at the non-silent | PASS | matrix F post: cursor `2`, unread `3,4` (pre-fix: cursor `4`) | none |
| 1 | Cursor never moves past a non-silent routine row under durable delivery | PASS | all six cases above; the jq slice is `.[0:$stop]` where `$stop` is the first `silent != true` index | none |
| 2 | `durable_delivery_in_use` reads the same signal the extension gates on | PASS | shell `case` at `bin/fm-branch-outcome.sh:186-192` vs `/^(1\|true\|yes)$/i` at `.pi/extensions/fm-branch-supervision.ts:173`; 17-value matrix all MATCH | none |
| 2 | Signal fixed at launch, not racing extension activation | PASS | extension const is module-scope (`:173`), shell reads process env at call time; env is set by the launcher before session start (`bin/fm-live-lab.sh:564`) | none |
| 2 | Case-insensitive forms and empty/unset | PASS | `1,true,TRUE,True,tRuE,yes,YES,Yes,yEs` durable; `0,false,no,2,truex," true","true ",empty,unset` non-durable; all MATCH the TS regex | none |
| 3 | Non-durable path byte-for-byte unchanged | PASS | pre vs post stdout and cursor `diff` both IDENTICAL on a silent,silent,non-silent,silent store | none |
| 4 | No stranding: extension renders and marks read | PASS (with residual risk) | `.pi/extensions/fm-branch-supervision.ts:1716` reads `unread`, `:1770` `ensureRoutineOutcome` under durable, `:1781` `mark-read --through`; `:2462` session-start call | residual risk below |
| 5 | Frozen append mechanism untouched | PASS | `git diff 548fe337^ 548fe337 -- bin/fm-branch-outcome.sh` has only the helper insertion and the `startup-replay` `if/else`; no `append` hunk | none |
| 5 | `runtime/pi-durable/src/` untouched | PASS | `git diff --stat 548fe337^ 548fe337` = `bin/fm-branch-outcome.sh`, `docs/pi-durable/38-...md`, `tests/fm-branch-supervision.test.sh` only | none |
| 5 | Default flag-off presentation path unchanged | PASS | challenge 3; `bin/fm-session-start.sh:789` call site unchanged | none |
| 6 | Failing-first: pre-fix durable assertion fails, post-fix passes | PASS | `.scratch/repro.sh pre` → `MODE=pre FAIL: durable startup replay consumed a non-silent row`; `post` → `MODE=post PASS` | none |
| 6 | `tests/fm-branch-supervision.test.sh` | PASS | 35 `ok -`, 0 `not ok`, exit 0; new test at `:312-347` listed | none |
| 6 | `tests/fm-pi-branch-extension.test.sh` | PASS | 58 `ok -`, 0 `not ok`, exit 0 | none |
| 6 | `FM_PI_BRANCH_LIVE_E2E=1 tests/fm-pi-branch-live-e2e.test.sh` | PASS on retry | run 1 flaked at "pinned watcher-owned main delivery"; run 2 exit 0, 8 `ok -`, 0 `not ok` | flake, not regression |
| 6 | `(cd runtime/pi-durable && npm ci && npm test)` | PASS | `npm ci` exit 0; `npm test` 81 pass / 0 fail | none |

## Detailed findings

### 1. Cursor logic

`REPLAYABLE` (`bin/fm-branch-outcome.sh:811-817`) is the unread rows up to the first `captain` verdict, so a leading captain row yields an empty replay set and the captain row is never in scope. The durable `LAST` (`bin/fm-branch-outcome.sh:825-830`) is:

```jq
([.[] | .silent == true] | index(false)) as $stop
| (if $stop == null then . else .[0:$stop] end)
| last
| if . == null then empty else .seq end
```

`index(false)` is the first non-silent index; `.[0:$stop]` contains only indices below it, so every row it can select is silent. `null` (all-silent) selects the whole run. `$stop == 0` (first row non-silent) selects the empty slice and `last` is `null` → `empty` → `LAST` empty → `advance_cursor` is not called (`:834`). This is exactly the required behavior. Pre-fix, the durable assertion fails because the old `LAST=$(record_seq "$(printf '%s\n' "$REPLAYABLE" | tail -n 1)")` took the last row of the whole replay set.

Post-fix matrix (`flag=1`), reproduced with the landed script:

```
=== A-all-silent (flag='1') ===        cursor: 2      unread seqs:
=== B-silent-then-nonsilent (flag='1') cursor: 1      unread seqs: 2
=== C-nonsilent-then-silent (flag='1') cursor: (none) unread seqs: 1,2
=== D-leading-captain (flag='1')       cursor: (none) unread seqs: 1,2
=== E-first-nonsilent (flag='1')       cursor: (none) unread seqs: 1
=== F-silent-silent-nonsilent-silent   cursor: 2      unread seqs: 3,4
=== G-nondurable (flag unset)          cursor: 2      unread seqs:
```

Pre-fix matrix for the same stores:

```
=== B-silent-then-nonsilent (flag='1') cursor: 2      unread seqs:      <-- consumed seq 2
=== C-nonsilent-then-silent (flag='1') cursor: 2      unread seqs:
=== E-first-nonsilent (flag='1')       cursor: 1      unread seqs:
=== F-silent-silent-nonsilent-silent   cursor: 4      unread seqs:
```

### 2. Signal robustness

Shell (`bin/fm-branch-outcome.sh:186-192`):

```sh
durable_delivery_in_use() {
  case "${FM_PI_DURABLE_DELIVERY:-}" in
    1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss]) return 0 ;;
  esac
  return 1
}
```

Extension (`.pi/extensions/fm-branch-supervision.ts:173`, module scope):

```ts
const durableDeliveryEnabled = /^(1|true|yes)$/i.test(process.env.FM_PI_DURABLE_DELIVERY ?? "");
```

Behavioral signal matrix (cursor `1` = durable, `2` = non-durable), each compared to the TS regex evaluated by node:

```
value=1        cursor=1 shell_durable=1 ts_regex=1 MATCH
value=true     cursor=1 shell_durable=1 ts_regex=1 MATCH
value=TRUE     cursor=1 shell_durable=1 ts_regex=1 MATCH
value=True     cursor=1 shell_durable=1 ts_regex=1 MATCH
value=tRuE     cursor=1 shell_durable=1 ts_regex=1 MATCH
value=yes      cursor=1 shell_durable=1 ts_regex=1 MATCH
value=YES      cursor=1 shell_durable=1 ts_regex=1 MATCH
value=Yes      cursor=1 shell_durable=1 ts_regex=1 MATCH
value=yEs      cursor=1 shell_durable=1 ts_regex=1 MATCH
value=0        cursor=2 shell_durable=0 ts_regex=0 MATCH
value=false    cursor=2 shell_durable=0 ts_regex=0 MATCH
value=no       cursor=2 shell_durable=0 ts_regex=0 MATCH
value=2        cursor=2 shell_durable=0 ts_regex=0 MATCH
value=truex    cursor=2 shell_durable=0 ts_regex=0 MATCH
value=" true"  cursor=2 shell_durable=0 ts_regex=0 MATCH
value="true "  cursor=2 shell_durable=0 ts_regex=0 MATCH
value=''       cursor=2 shell_durable=0 ts_regex=0 MATCH
```

Unset is the `G-nondurable` case above (cursor `2`). The extension evaluates its constant once at module import; the shell reads the process env at call time. `FM_PI_DURABLE_DELIVERY` is exported by the launcher (`bin/fm-live-lab.sh:564` `primary_env=(FM_PI_DURABLE_DELIVERY=1)`), so the value is fixed for the life of the session and the decision is order-independent.

### 3. Non-durable path unchanged

The diff's `else` branch (`bin/fm-branch-outcome.sh:832`) is the exact pre-fix line. Ran the pre-fix and post-fix scripts against the same `silent,silent,non-silent,silent` store with no flag:

```
=== diff stdout ===  STDOUT IDENTICAL
=== diff cursor ===  CURSOR IDENTICAL
```

Both printed the `BRANCH OUTCOMES` digest with `seq:3` and advanced the cursor to `4`.

### 4. No stranding / residual risk

Intended follow-on is present. `reconcileUnreadOutcomes` (`.pi/extensions/fm-branch-supervision.ts:1716`) reads `bin/fm-branch-outcome.sh unread`, and under `durableDeliveryEnabled` routes a routine row through `ensureRoutineOutcome` (`:1770`) and then `mark-read --through <seq>` (`:1781`). It is invoked from the `session_start` handler behind `actingAsOwner` (`:2462`) and from `turn_end` (`:2414`, `present=false`). Because startup-replay no longer consumes the non-silent row, the extension finds it unread regardless of whether startup-replay or extension activation runs first.

Residual risk: the fix depends on the extension actually running. If `FM_PI_DURABLE_DELIVERY` is truthy but the branch extension never activates (load failure, non-Pi host, or a home that exports the flag without the extension), the leading non-silent routine row stays unread indefinitely. It is not lost — `VISIBLE` is still printed into the digest at `bin/fm-branch-outcome.sh:816-819` on every startup — but that digest is a tool result (the pilot showed it compressed into a tool artifact), so it is not a qualifying rendered presentation and `unread` never drains. This is strictly better than pre-fix (which consumed the row with no rendered entry either) and is inherent to the durable-delivery design; it is worth a sentence in doc 38 but is not a defect in this change.

### 5. Boundaries

`git diff --stat 548fe337^ 548fe337`:

```
 bin/fm-branch-outcome.sh                         | 39 +++++++++++++++++++++++-
 docs/pi-durable/38-startup-replay-durable-fix.md | 25 +++++++++++++++
 tests/fm-branch-supervision.test.sh              | 38 +++++++++++++++++++++++
 3 files changed, 101 insertions(+), 1 deletion(-)
```

No `append` code is touched; `runtime/pi-durable/src/` is untouched; `.pi/extensions/` is untouched. The default (flag-off) presentation path is byte-identical (challenge 3).

### 6. Failing-first and test suites

Focused reproduction of the new test body against both revisions:

```
--- PRE ---  MODE=pre FAIL: durable startup replay consumed a non-silent row   (exit 1)
--- POST --- MODE=post PASS                                                    (exit 0)
```

Test runs (all in the detached scratch worktree at `548fe337`):

- `bash tests/fm-branch-supervision.test.sh` → exit 0, 35 `ok -`, 0 `not ok`; new test `test_outcome_startup_replay_is_durable_delivery_aware` (`tests/fm-branch-supervision.test.sh:312`) passes.
- `bash tests/fm-pi-branch-extension.test.sh` → exit 0, 58 `ok -`, 0 `not ok`.
- `FM_PI_BRANCH_LIVE_E2E=1 bash tests/fm-pi-branch-live-e2e.test.sh` → run 1 exit 1 with `timeout waiting for pinned watcher-owned main delivery` at the model-pin probe; run 2 exit 0, 8 `ok -`, 0 `not ok`.
- `(cd runtime/pi-durable && npm ci && npm test)` → `npm ci` exit 0; `npm test` 81 pass / 0 fail.

The live-e2e run-1 failure is a timing flake, not a regression: it passed on retry, the test does not set `FM_PI_DURABLE_DELIVERY` (grep of `tests/fm-pi-branch-live-e2e.test.sh` for the flag = no matches), the fix does not touch `.pi/extensions/`, and the only changed runtime file's non-durable `startup-replay` path is byte-identical to pre-fix. The failure occurred in the model-pin probe, unrelated to outcome cursors.

## New issues

None material. The only observation is the residual stranding risk in challenge 4, which is a pre-existing property of durable delivery rather than something this fix introduces.

## What remains uncovered

- No live pilot run with `FM_PI_DURABLE_DELIVERY=1`: the startup-replay → `reconcileUnreadOutcomes` handoff was verified at the unit/behavior level and through the extension and live-SDK suites, but not reproduced in a full attended session with the flag on.
- The pre-fix live-e2e failure was not re-run at `548fe337^`; the "not a regression" conclusion rests on code identity (extension unchanged, non-durable path byte-identical, flag unset in that test) plus the flake-on-retry result.
- The extension-never-runs stranding scenario was reasoned from the code, not exercised end to end.

## Recommendation

Ship as-is. Optionally add one sentence to `docs/pi-durable/38-startup-replay-durable-fix.md` naming the residual risk that a non-silent row stays unread if durable delivery is signalled but the extension never activates. No code change is required.

ADVANCE
