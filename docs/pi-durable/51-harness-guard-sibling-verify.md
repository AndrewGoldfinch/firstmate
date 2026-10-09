# Verification: live-guard pointer distinction + sibling resolver reuse

Scout report. Deliverable is a report, not a code change. No repository code was
changed (all scratch edits reverted) and nothing was pushed or opened as a PR.

## Scope and setup

- Target: fix commit `1b5e362a` ("fix(pi tests): classify branch-build failures
  and reuse the SDK resolver in sibling guards"), merge `53686e2d` ("Merge harness
  guard correction + sibling resolver reuse"), doc `docs/pi-durable/50-harness-guard-sibling.md`.
- Diff range inspected: `23840374..1b5e362a` (7 files, +206/-47).
- Where the fix lives: `53686e2d` is on `experiment/pi-durable-supervision`
  (`origin/experiment/pi-durable-supervision` is at `09bb45fa`), **not** on
  `origin/main`. This verification worktree defaulted to `main` at `1f3e7696` and
  did not contain the fix or `docs/pi-durable/`; I detached at `53686e2d` to run it.
- Host: managed-only Pi install, `pi --version` = 1.1.0, `node` = v22.21.1,
  `npm root -g` = `/home/andy/.nvm/versions/node/v22.21.1/lib/node_modules` with
  **no** `@earendil-works` package, i.e. the managed release is the only SDK.
- `runtime/pi-durable` dependencies installed with `npm ci` (exit 0) so the
  pinned `node_modules/.bin/tsc` fallback exists.

## Findings table

| Claim | Confirmed? | Evidence | Impact |
| --- | --- | --- | --- |
| 1a. A failed branch build reports `branch session was never created: ... (<real construction error>)` | Yes | Broke `bin/fm-branch-prompt.sh` (`exit 3`, stderr `forced branch prompt failure for verification`); `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` exited 1 and threw `branch session was never created: the branch build failed before it persisted a session (fm-branch-prompt.sh did not produce a usable branch prompt (status=3): forced branch prompt failure for verification)` at guard line `tests/fm-pi-branch-live-e2e.test.sh:239` | Build failures are no longer blamed on the SessionManager |
| 1b. A genuine pointer-persistence failure still reports `real SessionManager did not persist the branch session pointer` | Yes | Temporarily made the extension's pointer write throw inside its existing swallow (`writeFileSync(sessionPointer, ...)` at `fm-branch-supervision.ts:2010`); construction still succeeded and the first prompt still failed unpromptably; guard exited 1 with `real SessionManager did not persist the branch session pointer` at `tests/fm-pi-branch-live-e2e.test.sh:241` | The original failure signal is preserved, not replaced |
| 1c. Branch-lifecycle assertions are preserved (offer accepted, settlement rejected, watcher-owned fallback wake consumed) | Yes | `git diff 23840374..1b5e362a --numstat` for the file = `12 0` (pure addition, one hunk at `@@ -226,6 +226,18 @@`); no lines removed or moved. Both forced-failure runs reached the new throws at lines 239/241, which are only reachable after the checks at lines 214 (`offers[0].accepted`), 218 (`offerFailure instanceof Error`), and 225 (`fallback.includes("FIRSTMATE WATCHER WAKE: signal: live-sdk probe")`) | The fix classifies the failure; it does not soften or delete the lifecycle gate |
| 2a. `tests/pi-package-helpers.sh` gains `fm_pi_require_usable`; sibling tests source it and resolve the managed install | Yes | Helper added at `tests/pi-package-helpers.sh:61`; all five tests source it; `fm-pi-branch-extension.test.sh` uses it at `:5102`/`:5250`, `fm-pi-primary-types.test.sh` at `:15`, `fm-calm-pi-extension.test.sh` sourced | SDK resolution is centralized |
| 2b. The two real-SDK sub-cases now run (branch-extension 0 skips, was 2) | Yes | Post-fix `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` exit 0 with `0` `skip:` lines and both `ok - the installed Pi still bounds the picker's list and ranks its search` and `ok - fm_branch_outcomes hides through ToolExecutionComponent while Calm-off and HTML export stay stock`. On the same tree with the six files checked out at `23840374`, it exited 0 with exactly `2` `skip: installed @earendil-works/pi-coding-agent package not found` | Real-SDK coverage is no longer silently skipped on a managed-only host |
| 2c. Calm no longer silently skips (was 7) | Yes | Post-fix calm run `0` `skip:` lines (pre-fix run: `7`) | Calm contract sub-cases now execute |
| 2d. An installed-but-unusable SDK produces an actionable failure, not a silent skip | Yes | `FM_PI_PACKAGE_DIR=/tmp/fm-partial-sdk` (a dir with only `package.json`) → branch-extension exited 1 with `not ok - installed @earendil-works/pi-coding-agent at /tmp/fm-partial-sdk is missing sibling dependencies under / (need pi-tui, pi-ai, typebox); set FM_PI_PACKAGE_DIR to a complete install`. `fm-pi-package-resolve.test.sh` also covers the refusal (`fm_pi_require_usable` rejects a dep-less package, accepts the complete layout) and exits 0 | Broken installs fail loudly with the missing dependency named |
| 3a. `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` green | Yes | exit 0, `FM_TEST_END ... exit=0 duration_ms=34788`, `0` skips | Live guard passes against Pi 1.1.0 |
| 3b. `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` green | Yes | exit 0, `0` skips, both real-SDK sub-cases `ok` | — |
| 3c. `bin/fm-test-run.sh tests/fm-pi-primary-types.test.sh` green | Yes, with prerequisite | On a fresh tree`tsc` is absent everywhere (PATH, dep `node_modules`, repo pinned), so the first run `gate_skip=true` with `skip: Pi extension typecheck prerequisite not found: tsc`. After `(cd runtime/pi-durable && npm ci)`, re-run exits 0 with `ok - tracked Pi extensions pass strict no-emit typecheck against Pi 1.1.0` | Green only once `runtime/pi-durable` deps are installed (documented order matters); without them it still gate-skips rather than failing |
| 3d. `bin/fm-test-run.sh tests/fm-pi-package-resolve.test.sh` green | Yes | exit 0, `ok - Pi SDK resolver finds the managed install or explicit override, links sibling deps from the nested or hoisted layout, and refuses an installed-but-unusable package` | — |
| 3e. `(cd runtime/pi-durable && npm ci && npm test)` green | Yes | `npm ci` exit 0; `npm test` exit 0, `# pass 81 / # fail 0 / # skipped 0` | Runtime suite unaffected |
| 4. The calm failure is a genuine Pi 1.1.0 export-renderer finding surfaced by the now-running sub-case, not a resolver defect | Yes | Post-fix calm exits 1 with `Error: grep disappeared from /export calm.html HTML while calm mode was on`. Root cause: the sub-case passes `getToolDefinition` (`tests/fm-calm-pi-extension.test.sh:1676`, `:1707`) but Pi 1.1.0's `createToolHtmlRenderer` destructures `getToolRenderers` (`.../dist/core/export-html/tool-renderer.js`, confirmed in `.d.ts:11`) and `agent-session.js` calls it that way. A focused probe against the managed package printed `with getToolDefinition renderCall = undefined` vs `with getToolRenderers renderCall = "<div class=\"ansi-line\">hello-grep-line</div>"`. Both option names are unchanged from `23840374`; only the resolver made the sub-case start running | Separate test/API-drift finding against Pi 1.1.0, correctly scoped out of the harness fix |
| 5. GNU/Linux `readlink -f` caveat | Confirmed by inspection, not executed on BSD | `tests/pi-package-helpers.sh:30` uses `readlink -f`; on a host without it the `pi` symlink is unresolved, the managed install is not found, and resolution falls back to `npm root -g` | macOS/BSD managed-only hosts would fall back and skip again; low risk while the guards are Linux/CI-scoped |

## Additional observations (not in the brief)

1. **The fix is not on `main`.** `origin/main` at `1f3e7696` has neither the fix
   nor `docs/pi-durable/`. The merge `53686e2d` is an experiment-branch merge. If
   the intent was to land on `main`, that has not happened.
2. **The calm test has a second, pre-existing failure** masked by the renderer
   abort: on the pre-fix tree (renderer sub-case skipped) calm fails with
   `not ok - Pi queued-row queued_mixed case did not list the captain's queued
   follow-up`. Post-fix the renderer failure aborts first, so this remains hidden.
   It is not caused by the resolver change (it reproduces with the pre-fix files)
   but is worth reporting before any calm cleanup.
3. **Guard classification is regex-bound.** The SessionManager message only fires
   when the settlement error matches `/No API key|no credentials|no model available/i`
   *and* the `state/branch-session` store exists. A genuine pointer-write failure
   combined with a first-prompt error outside that pattern would be reclassified
   as a build failure. This is a residual edge, not a regression versus the fix's
   stated intent.
4. **Completion gate.** No captain-held task was minted from this worker: the
   report surfaces findings and a recommendation, and any follow-up captain
   choice (e.g. whether to fix the calm renderer) belongs to firstmate's
   scout-completion / backlog intake, not to a scout writing into the main home's
   backlog.

## Unverified / residual risk

- BSD/macOS `readlink` behavior (claim 5) is reasoned from the code, not run.
- The genuine pointer-persistence case (1b) was produced by forcing the pointer
  write to throw inside the extension's existing swallow; a naturally occurring
  SessionManager pointer write failure was not reproduced.
- `runtime/pi-durable/node_modules` was installed locally for verification; the
  primary-types green run depends on that install.

## Commands run (all inside the disposable scout worktree)

```
git checkout --detach 53686e2d
FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh   # exit 0, 0 skips
# forced build failure: replace bin/fm-branch-prompt.sh with `exit 3`, rerun      # exit 1, new message
# forced pointer failure: throw in fm-branch-supervision.ts pointer try-block, rerun # exit 1, SessionManager message
bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh                          # exit 0, 0 skips
git checkout 23840374 -- <six changed test files>; bin/fm-test-run.sh ...branch-extension # exit 0, 2 skips
bin/fm-test-run.sh tests/fm-calm-pi-extension.test.sh (post)                   # exit 1, 0 skips, renderer error
bin/fm-test-run.sh tests/fm-calm-pi-extension.test.sh (pre)                    # exit 1, 7 skips, queued-row error
bin/fm-test-run.sh tests/fm-pi-package-resolve.test.sh                            # exit 0
(cd runtime/pi-durable && npm ci && npm test)                                     # exit 0, 81/81
FM_PI_PACKAGE_DIR=/tmp/fm-partial-sdk bin/fm-test-run.sh ...branch-extension     # exit 1, actionable missing-deps message
node scratch/verify/renderer-probe.mjs                                            # getToolDefinition=undefined vs getToolRenderers=HTML
```

## Recommendation

All four brief claims hold on a managed-only Pi 1.1.0 host, including the
adversarial direction checks. The calm failure is a real, separate Pi 1.1.0
export-renderer/API-drift finding, not a resolver defect. The harness fix should
proceed; the calm renderer mismatch (and the masked queued-row failure) should be
filed separately, and the fix's location on the experiment branch rather than
`main` should be confirmed with the captain.

ADVANCE
