# Pi Durable: live-guard pointer distinction and sibling-test resolver reuse

Task: fix the live branch guard's branch-session pointer classification and reuse
`tests/pi-package-helpers.sh` in the three sibling Pi tests that still resolved the
SDK from `npm root -g` alone.
Deliverable: this note plus the committed harness change on
`experiment/pi-durable-harness-guard-sibling`.
No production session-management behavior, no Pi Durable runtime source, and no
running adoption home were changed.

## Guard distinction

`tests/fm-pi-branch-live-e2e.test.sh` used to treat a missing
`state/.branch-session` pointer as `real SessionManager did not persist the branch
session pointer`.
The pointer is a branch **success-path** side effect, written only after
`createAgentSession` returns and lock ownership is re-confirmed, so the same
symptom also appears when the branch build failed earlier (prompt generation, model
pin resolution, lock loss).
The guard now separates the two cases:

- A settlement error that is not the expected unpromptable-branch failure, or no
  `state/branch-session` store at all, reports
  `branch session was never created: the branch build failed before it persisted a
  session (<real construction error>)`.
- A valid unpromptable settlement with a session store but no pointer still reports
  `real SessionManager did not persist the branch session pointer`.

The branch-lifecycle assertion is preserved: the offer must still be accepted, the
settlement must still reject, and the watcher-owned fallback wake must still be
consumed.

## Sibling resolver reuse

`tests/pi-package-helpers.sh` gains `fm_pi_require_usable`, which refuses loudly
with the missing sibling dependency named when the package is installed but its
`pi-tui`, `pi-ai`, or `typebox` dependencies cannot be resolved.
The following tests now source the helper and use `fm_pi_package_dir` /
`fm_pi_dep_node_modules` instead of `npm root -g` plus nested `node_modules` paths:

- `tests/fm-pi-primary-types.test.sh` — SDK and sibling links resolve from the
  helper; `tsc` is taken from `PATH`, then the dependency `node_modules/.bin`, then
  the repo's pinned `runtime/pi-durable/node_modules/.bin/tsc`.
- `tests/fm-calm-pi-extension.test.sh` — top-level resolution plus every fixture's
  sibling links and the embedded `pi-tui` import path.
- `tests/fm-pi-branch-extension.test.sh:5094` and `:5240` — both real-SDK sub-cases.

`tests/fm-pi-package-resolve.test.sh` covers the new usability check.

## Verification

Pre-fix, on a host whose only SDK is the managed Pi 1.1.0 install:

- `tests/fm-pi-branch-extension.test.sh` exited 0 with **2 skips** (the two real-SDK
  sub-cases).
- `tests/fm-calm-pi-extension.test.sh` printed **7** `skip:` lines.
- `tests/fm-pi-primary-types.test.sh` skipped on the absent `tsc` prerequisite.
- A scratch tree with a forced `bin/fm-branch-prompt.sh` failure made the live
  guard report the misleading `real SessionManager did not persist the branch
  session pointer`.

Post-fix against Pi 1.1.0:

- `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh`
  — exit 0, 0 skips.
- The same scratch tree now reports
  `branch session was never created: ... (fm-branch-prompt.sh did not produce a
  usable branch prompt ...)`, naming the real construction failure.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` — exit 0, **0 skips**.
- `bin/fm-test-run.sh tests/fm-pi-primary-types.test.sh` — exit 0, `ok - tracked Pi
  extensions pass strict no-emit typecheck against Pi 1.1.0`.
- `bin/fm-test-run.sh tests/fm-pi-package-resolve.test.sh` — exit 0.
- `(cd runtime/pi-durable && npm ci && npm test)` — exit 0, 81/81 pass.

## Remaining failures (reported, not fixed here)

- `tests/fm-calm-pi-extension.test.sh` still exits 1 against Pi 1.1.0: the renderer
  sub-case now runs and fails with
  `grep disappeared from /export calm.html HTML while calm mode was on`.
  That is a stock Pi 1.1.0 export-renderer compatibility finding surfaced by the
  newly running sub-case, not a resolver defect, and fixing production Calm
  behavior is out of this harness task's scope.
- `tests/fm-lint.test.sh` fails with
  `the fallback attempts lost per-root RSS reporting: unavailable`, an
  environment-dependent ShellCheck worker telemetry failure unrelated to these
  changes.

## Caveat

`fm_pi_package_dir` resolves the managed launcher with GNU `readlink -f`.
On a platform without it (BSD/macOS) the symlink is not resolved, the managed
install is not found, and resolution falls back to `npm root -g`.
The live guards are Linux/CI-scoped, so this is a low-risk platform caveat.
