# Verify Calm renderer + queued-row harness fixes (Pi 1.1.0)

Task: `pi-durable-calm-renderer-pi110-verify`
Verified commit: `261b86c3` ("fix(pi tests): adapt Calm renderer and queued-row E2E to Pi 1.1.0"), merged `c5c44034`; note `docs/pi-durable/52-calm-renderer-pi110-fix.md`.
Verdict requested: independently and adversarially confirm both failures were test-harness drift, not Calm presentation defects, and that the fix is correct and non-vacuous.

## Bottom line

Both failures reproduce as test-harness drift, the root causes in the fix note are correct, the fix is non-vacuous, and all three named suites are green. **ADVANCE.**

One premise in the task brief did not match the delivered worktree and is worth recording: the worktree was checked out at `1f3e7696`, which is an **ancestor** of `504187ee` (the fix's parent) and 124 files / ~24.9k lines behind it. `tests/lib.sh` at `1f3e7696` lacks the `fm_pi_package_dir` / `fm_pi_dep_node_modules` helpers that `504187ee`'s test file calls, so the pre-fix test cannot run correctly from that base. All reproduction below was done at the fix's actual parent, `504187ee`, which is the correct laboratory for `504187ee..261b86c3`. This is a harness/base-selection issue, not a defect in commit `261b86c3`.

## Findings table

| Claim | Confirmed? | Evidence | Impact |
|---|---|---|---|
| (a) root cause: Pi 1.1.0 reads `getToolRenderers`, never `getToolDefinition` | **Yes** | `…/pi-coding-agent/dist/core/export-html/tool-renderer.d.ts` declares `getToolRenderers: (name) => ToolRenderers \| undefined`; `tool-renderer.js:28` destructures `getToolRenderers`, `:63`/`:79` call it. No `getToolDefinition` anywhere in the module. | Rename is required, not cosmetic. |
| (a) `getToolDefinition` produced no HTML and the sub-case failed failing-first | **Yes** | `504187ee` + `bin/fm-test-run.sh tests/fm-calm-pi-extension.test.sh` → exit 1, `not ok - Pi calm renderer and lifecycle contract failed … Error: grep disappeared from /export calm.html HTML while calm mode was on` (thrown at `assertStockHtmlRendering`); script aborted before the queued-row case. | Reproduces the exact documented failure; failure (b) is masked by it. |
| (a) failure mechanism (not a Calm defect) | **Yes** | `tool-renderer.js` wraps `renderCall`/`renderResult` in `try/catch` (lines ~61–72, ~78–103); the call `getToolRenderers(toolName)` throws `TypeError` when the resolver is absent, is caught, and returns `undefined`. Direct probe (below) shows legacy → `undefined` for both. | The `grep`/`find` row "disappearing" is the test's own guard reacting to lost HTML, not Calm hiding rows. |
| (a) fix produces **real** HTML, assertion non-vacuous | **Yes** | Node probe against the installed 1.1.0 module: `getToolDefinition` → `renderCall` `undefined`, `renderResult` `undefined`; `getToolRenderers` → `renderCall` `"<div class=\"ansi-line\">GREP_CALL_ROW</div>"`, `renderResult.expanded` `"<div class=\"ansi-line\">GREP_RESULT_ROW</div>"`. Test asserts `!callHtml \|\| !resultHtml?.expanded` throws (`tests/fm-calm-pi-extension.test.sh:1690-1697`, post-fix). | Post-fix the sub-case is a genuine rendering assertion. |
| (a) second `unmatchedRenderer` guard is meaningful post-fix | **Yes** | Guard at `:1713` calls `renderCall("unmatched-submit","grep",…)` and throws if it is truthy. Pre-fix the missing resolver made it return `undefined` for every name (vacuous pass — probe "EMPTY"/"LEGACY"); post-fix the same resolver returns real HTML for a matched call id (probe "MODERN"), so the guard now evaluates Calm's actual renderer and would fire if a non-submit input activated export rendering. | Guard changed from vacuous to real. |
| (b) root cause: WSL binds follow-up to Ctrl+Q, so `M-Enter` (Alt+Enter) never queues | **Yes** | `dist/core/keybindings.js:6` `useWindowsKeybindings()` returns true when `platform==="linux" && (WSL_DISTRO_NAME \|\| WSL_INTEROP)`; `KEYBINDINGS["app.message.followUp"].defaultKeys = windowsKeybindings ? "ctrl+q" : "alt+enter"`. Host env: `WSL_DISTRO_NAME=Debian`, `WSL_INTEROP=/run/WSL/1469_interop`, kernel `microsoft-standard-WSL2`. | Test sent the wrong key on this host; nothing queued. |
| (b) failure reproduces failing-first and is isolated from (a) | **Yes** | Renderer-only scratch state (rename applied, keybinding pin removed) → 10 `ok`, then `not ok - Pi queued-row queued_mixed case did not list the captain's queued follow-up`. | Confirms the pin, not the rename, is the fix for (b). |
| (b) Calm is not the cause | **Yes** | Scratch variant with Calm **off** + captain-queue path (pin absent) still failed: `not ok - Pi queued-row queued_offyes case did not list the captain's queued follow-up`. Same variant **with** the pin passed (15 ok). | Failure is the host keybinding, independent of Calm. |
| (b) pinned keybindings file is the one Pi reads | **Yes** | The case launches `env … PI_CODING_AGENT_DIR='$config' pi …` (`tests/fm-calm-pi-extension.test.sh:2624`); Pi's `KeybindingsManager.create` loads `join(agentDir, "keybindings.json")`. Fix writes `{"app.message.followUp":"alt+enter"}` to `"$config/keybindings.json"` (`:2525`). | Pin lands in the effective session config, host-correct. |
| (b) with the pin the case genuinely queues and observes the row | **Yes** | Fixed run: `ok - Pi 1.1.0 with Calm on hides and retains queued Firstmate input through Escape, …`; the case only passes after `wait_for_text … "Follow-up: CAPTAIN_QUEUED_queued_mixed"` succeeds. | Real observation of the queued row, not a vacuous pass. |
| No Calm change | **Yes** | `git diff --stat 504187ee c5c44034` = only `docs/pi-durable/52-calm-renderer-pi110-fix.md` and `tests/fm-calm-pi-extension.test.sh`; `git diff --stat 504187ee c5c44034 -- .pi/extensions/fm-calm.ts` empty; worktree `.pi/extensions/fm-calm.ts` identical to `261b86c3`. | Extension untouched. |
| No assertion weakened / no sub-case skipped | **Yes** | `504187ee..261b86c3` diff is 3 hunks only: two `getToolDefinition`→`getToolRenderers` renames plus explanatory comment, and the added `keybindings.json` write. Fixed run: **15 `ok`, 0 `not ok`, 0 `skip`**, exit 0. | No deletions of checks; nothing skipped. |
| Other suites green | **Yes** | `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` → exit 0; `(cd runtime/pi-durable && npm ci && npm test)` → `# tests 81 / # pass 81 / # fail 0 / # skipped 0`, chain exit 0. | Matches the note's verification claims. |
| Doc says "all 14 sub-cases" | **No (minor)** | The runner invokes 15 test functions and the fixed run prints 15 `ok` lines. | Doc/brief undercount by one; does not affect correctness. |

## Evidence detail

### Pi 1.1.0 API
- `…/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.d.ts`:
  `getToolRenderers: (name: string) => ToolRenderers | undefined;` in `ToolHtmlRendererDeps`.
  `ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">` (`dist/core/extensions/types.d.ts:508`).
- `tool-renderer.js`: `:28` `const { getToolRenderers, theme, cwd, width = 100 } = deps;`; `:63` and `:79` `const toolDef = getToolRenderers(toolName);`; `renderCall`/`renderResult` bodies wrapped in `try { … } catch { return undefined; }`.

### Direct API probe (installed managed Pi 1.1.0, `…/releases/1.1.0/…`)
```
LEGACY getToolDefinition:
  renderCall   -> undefined
  renderResult -> undefined
MODERN getToolRenderers:
  renderCall   -> "<div class=\"ansi-line\">GREP_CALL_ROW</div>"
  renderResult -> {"expanded":"<div class=\"ansi-line\">GREP_RESULT_ROW</div>"}
EMPTY no resolver:
  renderCall   -> undefined
  renderResult -> undefined
```
The test's throw condition is `if (!callHtml || !resultHtml?.expanded)` (`:1690-1697` post-fix), so LEGACY/EMPTY necessarily hit "grep disappeared" and MODERN passes with real HTML.

### Runs (all with managed Pi 1.1.0)
| State | Tree | Result |
|---|---|---|
| Failing-first | `504187ee` | exit 1; `Error: grep disappeared from /export calm.html HTML while calm mode was on`; aborted before queued-row |
| Fixed (as merged) | `504187ee` + `261b86c3` test | exit 0; 15 ok, 0 skip, 0 not ok |
| Renderer-only (pin removed) | scratch | 10 ok, then `not ok - Pi queued-row queued_mixed case did not list the captain's queued follow-up` |
| Calm off + captain queue, no pin | scratch | `not ok - Pi queued-row queued_offyes case did not list the captain's queued follow-up` |
| Calm off + captain queue, with pin | scratch | 15 ok, 0 not ok |

Fixed-state references: `tests/fm-calm-pi-extension.test.sh:1678` and `:1709` (`getToolRenderers`), `:1697` (throw), `:1713` (unmatched guard), `:2525` (keybindings pin). `git diff 261b86c3 -- tests/fm-calm-pi-extension.test.sh` empty and `git diff 261b86c3 -- .pi/extensions/fm-calm.ts` empty at report time.

### Host
`WSL_DISTRO_NAME=Debian`, `WSL_INTEROP=/run/WSL/1469_interop`, `uname -r 6.18.33.2-microsoft-standard-WSL2` → `useWindowsKeybindings()` true → `app.message.followUp` default `ctrl+q`. `M-Enter` = Alt+Enter, never the queue key. The pin restores Alt+Enter on every host.

## What remains unverified / caveats

- **Not covered by the committed regression suite:** the tracked `queued_off` variant calls `run_queued_escape_case off queued_off no`, so the Calm-off path never exercises the captain-queue keystroke. I proved "Calm off + M-Enter + pin passes" only with a scratch variant, not by a committed test. If the intent is to lock in the host-independence of the pin under Calm off, that variant would need to be added (out of scope for this fix, and not a defect in it).
- **`unmatchedRenderer` meaningfulness** was established by (i) the resolver probe showing the modern API resolves real renderers and the legacy API resolves nothing, and (ii) the fixed suite passing the guard. I did not separately re-derive Calm's internal wrapper source to show it returns `undefined` for a non-submit call id; the passing fixed run plus the live resolver is strong but indirect evidence.
- The "14 vs 15 sub-cases" count in `docs/pi-durable/52-calm-renderer-pi110-fix.md` and the task brief is inaccurate; the suite has 15.
- Nothing in this report was pushed; it is a scout deliverable. No repository code was changed. Scratch probe and logs were confined to the disposable worktree and removed.

ADVANCE
