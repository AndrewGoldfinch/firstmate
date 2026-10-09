# Pi Durable: Calm renderer and queued-row fixes for Pi 1.1.0

Task: fix the two failures the newly-running Calm coverage exposed against Pi 1.1.0.
Deliverable: this note plus the committed test-harness change on
`experiment/pi-durable-calm-renderer-pi110`.
No production session-management behavior, no Pi Durable runtime source, no pinned
SDK, and no running adoption home were changed.

## Failures reproduced

Both were reproduced failing-first with `bin/fm-test-run.sh tests/fm-calm-pi-extension.test.sh`
against the managed Pi 1.1.0 package.

- (a) `test_rendering_and_session_lifecycle` aborted with
  `Error: grep disappeared from /export calm.html HTML while calm mode was on`.
- (b) `test_queued_operational_escape_e2e` reported
  `not ok - Pi queued-row queued_mixed case did not list the captain's queued follow-up`.

(b) was masked because the renderer abort in (a) stopped the script before the queued-row
sub-case ran; isolating the queued-row sub-case exposed it directly.

## Root causes

Both are test-harness drift against Pi 1.1.0, not Calm presentation defects, so
`.pi/extensions/fm-calm.ts` needed no change.

- (a) Pi resolves HTML-export tool renderers through `getToolRenderers`
  (`dist/core/export-html/tool-renderer.d.ts`), but the sub-case built
  `createToolHtmlRenderer` with `getToolDefinition`, which Pi never reads.
  The renderer returned no HTML for every row, so the `grep` row read as disappeared and
  the second `unmatchedRenderer` guard passed only because its `renderCall` was always
  `undefined`.
- (b) The sub-case sent the follow-up keystroke as `M-Enter` (Alt+Enter), but Pi binds
  `app.message.followUp` to Alt+Enter only when `useWindowsKeybindings()` is false, and to
  Ctrl+Q on Windows and WSL.
  This host is WSL, so Alt+Enter never queued: the text stayed in the editor, no
  `Follow-up:` row was drawn, and no captain message reached the session.
  Running the same case with Calm off failed identically, which ruled out Calm as the cause.

## Fix

- Renamed the two `getToolDefinition` options to `getToolRenderers` in
  `tests/fm-calm-pi-extension.test.sh`, restoring the sub-case's real assertion.
- Pinned `{"app.message.followUp":"alt+enter"}` in the queued-row E2E session
  `keybindings.json` so the case sends the same real queue key on every host instead of
  depending on Pi's platform default.
  No assertion was weakened and no sub-case was skipped.

## Verification

- `bin/fm-test-run.sh tests/fm-calm-pi-extension.test.sh` - exit 0, 0 skips, all 14
  sub-cases pass, including the renderer and queued-row cases.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` - exit 0.
- `(cd runtime/pi-durable && npm ci && npm test)` - 81 pass, 0 fail, 0 skipped.

## Scope

The adoption home, this home's production supervision, dispatch targeting, and the
away-wedge symptom were out of scope and remain separately tracked.
No Pi Durable expansion and no SDK repin.
