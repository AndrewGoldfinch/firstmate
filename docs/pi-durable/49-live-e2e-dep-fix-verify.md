# Verify: live-e2e SDK dependency-resolution fix

Task: independently and adversarially verify the fix in commit `fcc27b23` (merge `a44ca357`).
Deliverable: this report. No repository code was modified.

## Verdict

**ADVANCE.** All five assigned claims confirmed against exact evidence. Every
edge case named in the spec is handled (clean fallback or actionable failure),
with two scoped caveats recorded below. One out-of-scope residual skips
silently on this host and is recommended as follow-up, not a blocker.

## Context discovered

- The worktree started at detached HEAD `1f3e7696`, the clean `origin/main`.
- The fix is **not on `main`**. `fcc27b23` and merge `a44ca357` are only on
  `experiment/pi-durable-supervision` (local and `remotes/origin/...`).
  `git merge-base --is-ancestor fcc27b23 origin/main` -> no; same for
  `a44ca357`. The verification therefore ran on a detached checkout of
  `a44ca357`, whose tree contains the five files (`tests/pi-package-helpers.sh`,
  `tests/fm-pi-package-resolve.test.sh`, `tests/fm-pi-branch-live-e2e.test.sh`,
  `tests/fm-pi-phase1-pilot.test.sh`, `tests/fm-pi-phase1-live-session.test.sh`).
  "Merged" here means merged into the experiment branch, not landed on `main`.
- Host environment (the managed-only case the fix targets):
  - `command -v pi` -> `/home/andy/.pi/agent/bin/pi`; `~/bin/pi -> ../.pi/agent/bin/pi`
    (a real symlink launcher).
  - `/home/andy/.pi/agent/install/current-version` -> `1.1.0`.
  - `npm root -g` -> `/home/andy/.nvm/versions/node/v22.21.1/lib/node_modules`,
    which contains **no** `@earendil-works` package.
  - SDK layout is **hoisted**: deps live at
    `install/releases/1.1.0/node_modules/@earendil-works/pi-ai`,
    `.../typebox`; the package has **no** nested `node_modules`.
  - `compat.js` exists only at the hoisted path.

## Bug reproduced (pre-fix)

At `20b5ec3b`, `tests/fm-pi-branch-live-e2e.test.sh:41` was:

    PI_PACKAGE_DIR=${FM_PI_PACKAGE_DIR:-"$(npm root -g)/@earendil-works/pi-coding-agent"}

On this host that path is
`/home/andy/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent`,
and `[ -f "$PI_PACKAGE_DIR/package.json" ]` is false -> the guard would print
`Pi package absent: ...` and fail. Additionally the old sibling-symlink block
pointed at `$PI_PACKAGE_DIR/node_modules/...`, which does not exist in the
hoisted layout. Both faults are exactly what the fix removes.

## Code under test (post-fix, `a44ca357`)

- `tests/pi-package-helpers.sh:20-42` — `fm_pi_package_dir`: order is
  `FM_PI_PACKAGE_DIR` (printed verbatim) -> managed install via
  `command -v pi` + `readlink -f` + `<agent>/install/current-version` ->
  `$(npm root -g)/@earendil-works/pi-coding-agent`.
- `tests/pi-package-helpers.sh:49-56` — `fm_pi_dep_node_modules`: picks the
  nested `<pkg>/node_modules` when `<pkg>/node_modules/@earendil-works/pi-ai`
  exists, else `dirname dirname <pkg>` (the layout's top level).
- `tests/fm-pi-branch-live-e2e.test.sh:41-43, 86-90, 580, 589-590` — guard
  sources the helper; links sibling deps from `pi_nm`; exports
  `FM_PI_DEP_NODE_MODULES="$pi_nm"` and imports
  `${process.env.FM_PI_DEP_NODE_MODULES}/@earendil-works/pi-ai/dist/compat.js`.
- `tests/fm-pi-phase1-pilot.test.sh:28-30, 43-46` and
  `tests/fm-pi-phase1-live-session.test.sh:28-30` — same helper sourcing and
  hoisted-aware sibling links.

## Green-run evidence (all four required commands, on `a44ca357`)

| Command | Result |
| --- | --- |
| `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` | exit 0; `FM_TEST_SUMMARY total=1 failed=0 skipped_gate=0`; 8 `ok -` assertions, **0 skips**; ran against real Pi SDK 1.1.0 |
| `bin/fm-test-run.sh tests/fm-pi-package-resolve.test.sh` | exit 0; `total=1 failed=0`; `ok - Pi SDK resolver finds the managed install...` |
| `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` | exit 0; `total=1 failed=0`; **2 skips** (see residual) |
| `(cd runtime/pi-durable && npm ci && npm test)` | `npm ci` exit 0; `npm test` exit 0; `# tests 81 / # pass 81 / # fail 0` |

The live indicator that `compat.js` resolved is the passing assertion
`ok - real Pi SDK 1.1.0 reports its own supported effort levels and applies an
explicit branch effort...` — the effort-pin probe is the node program that
imports `compat.js` via `FM_PI_DEP_NODE_MODULES`. Its failure would abort the
probe; it passed.

## Findings table

| Claim | Confirmed? | Evidence | Impact |
| --- | --- | --- | --- |
| 1. Resolution order: `FM_PI_PACKAGE_DIR`, then managed install (resolving the `pi` symlink with `readlink -f`), then `npm root -g`; guard no longer fails when `command -v pi` is a symlink | **Yes** | Code `tests/pi-package-helpers.sh:20-42`. Independent scratch run: real env (npm root empty) resolves `/home/andy/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent`; with `PATH=/home/andy/bin:$PATH` (real `~/bin/pi` symlink) same result; with a synthetic symlinked launcher same result; override printed verbatim (including trailing slash) | Managed-only hosts and symlinked launchers now resolve; the pre-fix `Pi package absent` failure is gone |
| 2. Layout handling: nested `<pkg>/node_modules` when `@earendil-works/pi-ai` is nested, else hoisted top-level `node_modules` | **Yes** | Code `tests/pi-package-helpers.sh:49-56`. Independent scratch: hoisted fixture -> `<release>/node_modules`; nested 1.0.4-style fixture -> `<pkg>/node_modules`; real 1.1.0 -> hoisted | Both layouts link the right sibling deps |
| 3. `compat.js` import uses `FM_PI_DEP_NODE_MODULES` and resolves under hoisted 1.1.0 | **Yes** | `tests/fm-pi-branch-live-e2e.test.sh:580` exports it, `:589-590` imports from it; real `.../releases/1.1.0/node_modules/@earendil-works/pi-ai/dist/compat.js` exists; live effort probe passed. Old `$PI_PACKAGE_DIR/node_modules/...` path does **not** exist on this host | Addresses the pointer report `:563-569` note; import now works hoisted |
| 4. Explicit `FM_PI_PACKAGE_DIR` used exactly as given; nested 1.0.4-style layout still resolves | **Yes** | Override test returns the string unchanged; nested fixture resolves and reports nested `node_modules`; `tests/fm-pi-package-resolve.test.sh` covers both | Backward compatibility and overrides preserved |
| 5. Green run of the four named commands | **Yes** | Table above | End-to-end path is exercised and green on the real SDK |

## Falsified edge cases

| Edge case | Handled? | Evidence / behavior |
| --- | --- | --- |
| `pi` absent | **Yes (clean fallback)** | `PATH=/usr/bin:/bin`: `command -v pi` fails; falls to `$(npm root -g)/@earendil-works/pi-coding-agent`; the caller's `package.json` check then produces the actionable `Pi package absent` message. No crash, no wrong path. |
| Stale `install/current-version` (release missing) | **Yes** | current-version `9.9.9`, real release 1.0.4: `[ -f "$managed_dir/package.json" ]` false -> falls back to `npm root -g`. |
| Empty `install/current-version` | **Yes** | `[ -n "$pi_version" ]` false -> falls back to `npm root -g`. |
| Managed dir without `package.json` | **Yes** | `[ -f "$managed_dir/package.json" ]` false -> falls back to `npm root -g` rather than using a broken dir. |
| Nested layout | **Yes** | Nested fixture resolves; `fm_pi_dep_node_modules` returns `<pkg>/node_modules`. |
| Both nested and hoisted deps absent | **Yes (fails loud)** | `fm_pi_dep_node_modules` returns the top level; guards then create dangling symlinks and node fails on import — a loud failure, not a silent pass. |

Independent scratch harness: 14/14 assertions pass (real env, override,
synthetic + real symlinked launcher, nested, hoisted, and the four fallback
edges above). `bash -n` clean on all five changed files; `shellcheck -x` clean
on `tests/pi-package-helpers.sh` and `tests/fm-pi-package-resolve.test.sh`.

## Caveats / residual (out of this fix's scope)

1. **`readlink -f` portability.** `tests/pi-package-helpers.sh:33` depends on GNU
   `readlink -f`. On a platform without it (BSD/macOS), the symlink is not
   resolved and the managed-install branch is skipped, falling back to
   `npm root -g`. Reproduced by shadowing `readlink` with a failing stub:
   `FM_PI_PACKAGE_DIR= PATH="/home/andy/bin:$STUB:$PATH" fm_pi_package_dir`
   returned the (empty on this host) npm global path instead of the managed
   1.1.0 install. The live guards are Linux/CI-scoped, so this is a low-risk
   platform caveat, not a regression on this host.
2. **Other Pi tests still resolve only from `npm root -g`** and therefore
   silently skip on this managed-only host:
   - `tests/fm-pi-primary-types.test.sh:10` — absent package -> prints `skip:` and
     `exit 0` (`:11-14`); it also still checks nested
     `$PI_PACKAGE_DIR/node_modules/...` (`:15-21`).
   - `tests/fm-calm-pi-extension.test.sh:20`.
   - `tests/fm-pi-branch-extension.test.sh:5094` and `:5240` — both
     `test_real_pi_picker_primitives_stay_bounded_and_searchable` and
     `test_outcomes_tool_uses_stock_execution_and_export_consumers` return
     early with `skip: installed @earendil-works/pi-coding-agent package not
     found`. These are exactly the **2 skips** in the green branch-extension
     run, so that suite is green while those two real-SDK sub-cases never ran.
   These are pre-existing gaps, not regressions from this fix.

## Recommendation

- Accept the fix: its stated behavior is verified end to end against the real
  managed 1.1.0 SDK in both nested and hoisted layouts.
- Follow-up (separate, low priority): reuse `tests/pi-package-helpers.sh` in
  `tests/fm-pi-primary-types.test.sh`, `tests/fm-calm-pi-extension.test.sh`,
  and the two `tests/fm-pi-branch-extension.test.sh` sub-cases so those
  real-SDK checks stop silently skipping on managed-only hosts.
- Note for the record: the fix is not on `origin/main`; it is on
  `experiment/pi-durable-supervision`. Ensure it lands wherever the pi-durable
  work is meant to integrate.

ADVANCE
