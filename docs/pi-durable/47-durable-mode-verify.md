# Scout report: independent adversarial verification of the per-home durable-mode marker fix

Task: `pi-durable-durable-mode-persist-verify` (scout, repo `firstmate-pi-durable`).
Subject: the per-home durable delivery marker fix (`docs/pi-durable/46-durable-mode-persist.md`), code commit `2b8d9c16`, merge `d168f318`, base `7993171e`.
Question: does the marker make **both** consumers durable so no caller can silently downgrade a durable home, without changing an unmarked home, and are the adoption-home artifacts and the historical record as the doc claims?

**Result headline: every claimed invariant holds. I reproduced the isolated regression (fails on `7993171e`, passes on the fix), reproduced the authoritative-marker and reconcile-before-disable behavior directly, and confirmed the adoption-home `seq 5` artifacts from the raw store, session file, and cursor. Two non-blocking documentation observations, no behavioral defect. Verdict: ADVANCE.**

All commands were run from the disposable worktree at detached `d168f318` (the fix) unless a base-commit run is named. No repository code was modified; the two-file base reproduction was staged and reverted with `git checkout HEAD --`.

## Findings table

| Claim | Confirmed? | Evidence | Impact |
| --- | --- | --- | --- |
| 1a. Marker makes the extension durable | Yes | `.pi/extensions/fm-branch-supervision.ts:176` `durableMarkerFile`; `:180-181` `durableDeliveryEnabled = existsSync(durableMarkerFile) \|\| /^(1\|true\|yes)$/i.test(env)`; `:1778` picks `ensureRoutineOutcome` (durable) vs `deliverRoutineOutcome`; `tests/fm-pi-branch-extension.test.sh:5989-6059` marker arm (`existing:2`, `durable:1:1`, `marker:1` with no env) passes | Marker alone selects durable identity; conflicting/absent env irrelevant |
| 1b. Marker makes `fm-branch-outcome.sh` durable | Yes | `bin/fm-branch-outcome.sh:184` `DURABLE_MARKER`; `:201-208` `durable_delivery_in_use` checks `[ -e "$DURABLE_MARKER" ] && return 0` **before** the env case; used by `startup-replay` at `:871` | `startup-replay` takes the durable path regardless of env |
| 1c. Flagless caller cannot downgrade a marked home | Yes | Direct run: marked home, leading non-silent row, flagless `startup-replay` printed the row (`replay-printed=1`), row stayed unread (`unread-after-flagless=1`), `cursor=none` | No silent consumption |
| 1d. Conflicting `FM_PI_DURABLE_DELIVERY=0` cannot downgrade | Yes | Direct run: `FM_PI_DURABLE_DELIVERY=0 startup-replay` → `unread-after-conflict=1`; new test asserts the same | Marker wins over a contradictory flag |
| 1e. No marker keeps the flag-off path exactly | Yes | New test's post-disable section: after `disable`, `startup-replay` consumes the routine row and `unread` is empty; `durable_delivery_in_use` returns 1 with neither marker nor env | No behavior change for unmarked homes |
| 2a. `disable` refuses while any row is unread | Yes | `bin/fm-branch-outcome.sh:556-568`; direct run: `disable` → exit 1, `error: refusing to disable durable delivery while outcome rows remain unread...`, marker still present | Reconcile-before-disable enforced |
| 2b. `enable` idempotent, `status` effective | Yes | `:546-577`; direct run: `status0=disabled`, after `enable` `status1=enabled`, after settled `disable` `status2=disabled`; conflicting env on unmarked home `conflict-status=enabled` | Env still works for unmarked homes; status reflects the real selection |
| 3. New test fails pre-fix, passes post-fix | Yes | Fix: `bin/fm-test-run.sh tests/fm-branch-supervision.test.sh` exit 0, `ok - a durable home is authoritative without the flag, resists a conflicting flag, and disables only after reconciliation`. Base files staged from `7993171e`: exit 1, `not ok - flagless startup replay consumed a non-silent row in a durable home (missing: 'leading visible routine')` | Isolated regression proof holds |
| 4. Adoption-home `seq 5` delivered by the extension while flagless | Yes | Raw artifacts below: store 5 rows, cursor `4 -> 5`, digest lists `seq 5` unread, `fm-branch-visible-routine` entry with `deliveryId 192123b9-...`, marker still present, extension pid matches lock pid | The fix is demonstrated on the real Pi + extension, not only in unit tests |
| 5. Historical record unchanged | Yes | `docs/pi-durable/45-adoption-seq2.md:106` "count stays 2 of 4: `seq 1`, `seq 4`"; rendered routine entries across all sessions are exactly `seq 1`, `seq 4`, `seq 5` (no `seq 2`/`seq 3`); `docs/pi-durable/46-durable-mode-persist.md:57-58` restates it | The fix does not retroactively change the `seq 2` loss |
| 6. Live-e2e limitation is environmental, not a regression | Yes | Same failure at fix and base `7993171e`: `not ok - Pi package absent: the live branch guard needs @earendil-works/pi-coding-agent installed`; with `FM_PI_PACKAGE_DIR` at the 1.1.0 release it advances and fails `Cannot find package '@earendil-works/pi-ai'` | Pre-existing host/SDK-layout limitation; unit + adoption-home coverage still exercises the real extension |

## 1. Authoritative marker (claims 1a-1e)

The fix is a two-file change (`git diff --stat 7993171e 2b8d9c16`: `.pi/extensions/fm-branch-supervision.ts`, `bin/fm-branch-outcome.sh`, plus doc and tests).

Extension consumer:

- `.pi/extensions/fm-branch-supervision.ts:176` `const durableMarkerFile = join(state, ".pi-durable-delivery");`
- `:180-181` `const durableDeliveryEnabled = existsSync(durableMarkerFile) || /^(1|true|yes)$/i.test(process.env.FM_PI_DURABLE_DELIVERY ?? "");`
- `:1778` `} else if (durableDeliveryEnabled) { if (!ensureRoutineOutcome(...)) ... } else { deliverRoutineOutcome(row); }` — marker selects the durable identity path.
- `:1789` `if (row.verdict !== "captain" && durableDeliveryEnabled) clearDelivery(row.seq);`

Script consumer:

- `bin/fm-branch-outcome.sh:184` `DURABLE_MARKER="$STATE/.pi-durable-delivery"`
- `:201-208`:
  ```
  durable_delivery_in_use() {
    [ -e "$DURABLE_MARKER" ] && return 0
    case "${FM_PI_DURABLE_DELIVERY:-}" in
      1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss]) return 0 ;;
    esac
    return 1
  }
  ```
- `:856-887` `startup-replay`: when `durable_delivery_in_use` (`:871`) the cursor advances only through the leading silent rows (`LAST` computed from `.[] | .silent == true`), so non-silent rows stay unread for the extension; otherwise the whole leading routine run is marked read.

Home resolution is identical on both sides, so the marker is read from the same directory: extension `state = process.env.FM_STATE_OVERRIDE || `${fmHome}/state`` (`:146-148`) and `bin/fm-wake-lib.sh:8-9` `FM_HOME=...; STATE="${FM_STATE_OVERRIDE:-${STATE:-$FM_HOME/state}}"`. `bin/fm-session-start.sh:788` passes `FM_HOME` and `FM_STATE_OVERRIDE` explicitly to `startup-replay`.

Direct independent reproduction (temp home `/tmp/dmw`):

```
replay-printed=1
unread-after-flagless=1
cursor=none
unread-after-conflict=1
```

i.e. a marked home printed the leading non-silent row but did not consume it, both flagless and under `FM_PI_DURABLE_DELIVERY=0`.

Other cursor-advancing paths were checked for a residual silent downgrade:

- `advance_cursor` is called only from `mark-read` (`:697`) and `startup-replay` (`:884`).
- `mark-read` callers are the extension (`fm-branch-supervision.ts:1786`) and `bin/fm-wake-drain.sh:717`. The drain's BRANCH OUTCOMES section (which presents then `mark-read`s) is skipped for a Pi primary: `bin/fm-wake-drain.sh:622` `fm_supervision_host_outcomes_drained "$config" || return 0`, and `bin/fm-supervision-engine-lib.sh:176-180` returns 1 for `pi|pi-signed`. So a Pi durable home never consumes rows through the drain.
- `present` (`bin/fm-branch-outcome.sh:703-737`) only prints (`unread: .seq > $cursor`) and never advances the cursor.
- Only the two consumers read the marker/env (`grep -rn 'FM_PI_DURABLE_DELIVERY'` and `'pi-durable-delivery'` over `.sh`/`.ts` return only the extension, the script, and `bin/fm-live-lab.sh` which sets the env; `runtime/` has no reference).

## 2. Explicit reconciled disablement (claims 2a-2b)

`bin/fm-branch-outcome.sh:546-577` implements `durable-mode enable|disable|status`. `disable` acquires `$LOCK`, and if the marker exists refuses while `print_unread` is non-empty (`:556-568`), removing the marker only when the store is settled; `enable` truncates the marker (idempotent); `status` prints `durable_delivery_in_use`.

Direct run on `/tmp/dmv`:

```
status0=disabled
status1=enabled
disable-unread: error: refusing to disable durable delivery while outcome rows remain unread; deliver or reconcile them first; exit=1
marker-still=yes
disable-settled: durable delivery disabled for /tmp/dmv/state; exit=0
status2=disabled
conflict-status=enabled
```

## 3. Isolated regression (claim 3)

`tests/fm-branch-supervision.test.sh:352-405` `test_outcome_durable_mode_marker_is_authoritative_and_reconciled` covers the script consumer: flagless replay must not consume the row, a conflicting flag must not downgrade, `disable` refuses while unread and clears only after `mark-read`, and the flag-off path returns after disable. `tests/fm-pi-branch-extension.test.sh:5989-6059` adds the extension `marker` arm (`for arm in existing:2: durable:1:1 marker:1:`; the marker arm creates `state/.pi-durable-delivery` with no env flag and expects one delivery).

Runs:

- Fix `d168f318`: `bin/fm-test-run.sh tests/fm-branch-supervision.test.sh` exit 0; `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` exit 0 (`ok - durable delivery identity makes a committed routine note exactly once while the existing path duplicates, including from the home marker alone`); `(cd runtime/pi-durable && npm ci && npm test)` 81/81 pass.
- Base reproduction: staged `git checkout 7993171e -- bin/fm-branch-outcome.sh .pi/extensions/fm-branch-supervision.ts` (confirmed `durable-mode` absent), ran the new test file from the fix tree: exit 1, `not ok - flagless startup replay consumed a non-silent row in a durable home (missing: 'leading visible routine')`. Reverted with `git checkout HEAD -- ...`.

## 4. Adoption-home `seq 5` (claim 4)

Home `/home/andy/pi-durable-adoption`, raw artifacts:

- Store `state/branch-outcomes.jsonl`: 5 rows, all `verdict:"routine"`, `silent:false`; row 5 `{"seq":5,"epoch":1791496453,...,"summary":"Durable mode persist probe five"}` (epoch = `2026-10-08T21:54:13Z`).
- `state/.pi-durable-delivery`: present, mtime `2026-10-08 14:53:54 -0700` (= `21:53:54Z`), i.e. created before the session start.
- `state/.branch-outcomes-cursor`: `5`, mtime `2026-10-08 15:00:07.704 -0700` (= `22:00:07.70Z`).
- `state/.pi-branch-extension-loaded`: `3950210`; `state/.lock`: `3950210` — same owner.
- Session `state/pi-sessions/2026-10-08T21-54-24-102Z_01a11d82-a6e5-7583-917a-1be9fc679208.jsonl`:
  - entry 8 `custom_message` (`firstmate-sessionstart-nudge`), timestamp `2026-10-08T22:00:03.680Z`, contains `BRANCH OUTCOMES` with the `seq 5` row — `startup-replay` printed it.
  - entry 11 `custom` / `fm-branch-visible-routine`, timestamp `2026-10-08T22:00:07.670Z`, data `{"version":1,"seq":5,"task":"adoption-observe","verdict":"routine","summary":"Durable mode persist probe five","silent":false,"deliveryId":"192123b9-29b6-4095-a13c-fa4aeb2baf68"}`.
- `durable-mode status` on the home: `enabled`; `unread` returns 0 lines; `state/.adoption-observe.branch-outcome-index` = `fm-branch-outcome-index-v1\t5\t0\t-`.
- Rendered routine entries across all 8 sessions are exactly `seq 1` (`57ad6b86-...`), `seq 4` (`3374794c-...`), `seq 5` (`192123b9-...`); no `seq 2`/`seq 3`.

Interpretation: the digest at `22:00:03.680Z` listed `seq 5` as unread (so `startup-replay` had not consumed it); the cursor file was not written at digest time and only advanced at `22:00:07.704Z`, four seconds after the extension-load marker and matching the `fm-branch-visible-routine` entry timestamp. The only process that writes the cursor in a Pi home after a successful durable delivery is the extension (`:1786`), and its pid matches the lock. The marker survived the run. This is exactly the doc's account.

Adoption-home provenance: `git -C /home/andy/pi-durable-adoption show -s 03073d06` → parent `15cbe64a`; the two files at `15cbe64a` are byte-identical to base `7993171e`, and at HEAD they are byte-identical (`cmp`) to the fix tree. So the home ran the real fix.

One caveat: the doc claims a "captured `⛵` pane line". No pane capture is persisted anywhere under the adoption home or `data/` (searches for `⛵ adoption-observe` and for the probe summary return only the store, the session file, and the older reports). The pane line is therefore not independently reproducible from artifacts; the durable equivalent — the `fm-branch-visible-routine` custom entry plus the `deliveryId` and cursor advance — is confirmed.

## 5. Historical record (claim 5)

`docs/pi-durable/45-adoption-seq2.md:106` records `seq 2` as not delivered and keeps the successful count at 2 of 4 (`seq 1`, `seq 4`). The raw store still holds `seq 2` and `seq 3` with no rendered entry, and `docs/pi-durable/46-durable-mode-persist.md:57-58` states the historical record is unchanged and treats `seq 5` as a separate confirmation. Nothing in the fix touches historical rows.

## 6. Live-e2e environment limitation (claim 6)

`FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` fails identically at the fix and at base `7993171e`:

```
not ok - Pi package absent: the live branch guard needs @earendil-works/pi-coding-agent installed (FM_PI_PACKAGE_DIR to override)
```

The guard resolves `PI_PACKAGE_DIR=${FM_PI_PACKAGE_DIR:-"$(npm root -g)/@earendil-works/pi-coding-agent"}` (`tests/fm-pi-branch-live-e2e.test.sh:41-43`); `npm root -g` is `/home/andy/.nvm/versions/node/v22.21.1/lib/node_modules` and has no `@earendil-works/pi-coding-agent`. Pointing `FM_PI_PACKAGE_DIR` at the installed 1.1.0 release (`/home/andy/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent`) advances past the check and then fails `Cannot find package '@earendil-works/pi-ai' imported from .../fm-branch-supervision.ts`, because line 86 symlinks `$PI_PACKAGE_DIR/node_modules/@earendil-works/pi-ai` and the 1.1.0 release hoists `@earendil-works/pi-ai` to the release's top-level `node_modules`, not under `pi-coding-agent`. This is a host/SDK-layout limitation that predates the change (it also fails at `7993171e`) and does not touch the changed code. Live-path coverage that remains: the adoption-home run exercises the real Pi TUI plus the real extension end to end, and `tests/fm-pi-branch-extension.test.sh` loads and drives the real extension for the marker arm.

## Non-blocking observations

1. `bin/fm-branch-outcome.sh:145` still describes the durable trigger as "`FM_PI_DURABLE_DELIVERY` is truthy, the same signal the Pi branch extension gates on at load". That is now stale: the marker is authoritative for both consumers. It is a comment in the script's usage header only; runtime behavior is correct. Worth correcting when the header is next touched.
2. The adoption-home pane capture referenced by the doc is not persisted; only the session record corroborates the rendering. Consider capturing the pane to a file in future adoption runs if that evidence matters.
3. The marker is fixed at module load in the extension (documented). Enabling it during a live flag-off session switches `startup-replay` (new processes) to durable before the running extension does; this is an ordering nuance, not a silent loss.

## Recommendation

The fix is correct and complete for the stated contract: the marker is authoritative for both consumers, flagless and conflicting callers cannot downgrade a marked home, unmarked homes are unchanged, `disable` reconciles before switching, the regression is isolated, and the adoption-home `seq 5` delivery is confirmed from raw artifacts. The only residual items are a stale header comment and unpersisted pane evidence; neither requires code. Promote/carry the doc-comment correction as ordinary follow-up if desired.

ADVANCE
