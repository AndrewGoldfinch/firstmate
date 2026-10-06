# Independent adversarial verification: reclaim exclusive-create claim (commit 081b8b93)

Scout task `pi-durable-reclaim-claim-verify`. Deliverable: this report. No repository change was landed; the only tracked file touched in the scratch worktree was `tests/assets/pi-f09-probe.mjs`, and only to add attack schedules that are inert unless `FM_PI_F09_ATTACK=1` is set. That scratch diff is preserved at `/tmp/attack-probe.diff` and is not proposed for landing.

## Environment and artifacts

- Firstmate repo worktree at detached `081b8b934a1331d1951e1d8debc7f64537017fbc` ("fix(pi): fence reclaim publish with an exclusive-create claim"), parent `9250c40b401f7042fab6b8b3bf06f1e8906c7f17`.
- `@earendil-works/pi-coding-agent` 1.0.4, Node v22.21.1, Linux 6.18.33.2-microsoft-standard-WSL2 x86_64.
- Extension SHA-256 `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09` (matches `extensionSha256` recorded by the probe).
- Real-SDK F09 evidence: `/tmp/f09-out.json`, `/tmp/f09-run.log`.
- Pre-fix counterfactual evidence: `/tmp/prefix-f09.json`, `/tmp/prefix-f09.log` (parent extension tree extracted to `/tmp/prefix-ext`).
- Attack evidence: `/tmp/f09-attack.json`, `/tmp/f09-attack.log` (HEAD extension + scratch probe schedules).
- Unix domain sockets: **work** (`net.Server.listen` on a `/tmp` path succeeded in this environment).

## Verdict

The exclusive-create claim closes the doc-26 compare-to-rename window. Under every schedule exercised, including the exact doc-26 counterfactual and adversarial claim attacks, reclaim settles at exactly one durable home-wide record and one visible delivery. No reachable duplicate or loss was found. The only new observation is a liveness-only stall from an externally corrupted `.claim` file, unreachable through the extension's own writes.

| Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- |
| Doc-26 counterfactual, pre-fix compare-then-rename, temp sweep suppressed | **Duplicates** (`diskRecords: 2`) | `/tmp/prefix-f09.json`: `first-reclaimer-resumes-without-sweep` `d=2, r=1`; `AssertionError` at `tests/assets/pi-f09-probe.mjs:745` ("the reclaim window must not leave two durable records"), probe exit 1 | Proves the probe discriminates; the window was real |
| Same counterfactual, fixed claim (`reclaim-takeover-without-temp-sweep`) | **One record, one delivery** | `/tmp/f09-out.json`: successor `d=0, r=0` (could not take the live claim, `m=3` = marker+claim+temp); resumed first reclaimer `d=1, r=1`; later adoption `d=1, u=0, m=0, c=1` | Closes the window; gate passes |
| Takeover between claim link and rename (`reclaim-takeover-before-rename`) | **One record, one delivery** | `/tmp/f09-out.json`: successor `d=0, r=0, m=2`; resumed first `d=1, r=1`; adoption `d=1, u=0, m=0, c=1` | Holds |
| Dead-claim cleanup race (two reclaimers both observe a crashed owner) | **One record, no duplicate; a stall is possible** | Scratch `attack-dead-claim-race`: first resumes `d=1, r=1, c=1`; second resumes `d=1, r=0` | Holds (liveness-only, already scoped in doc 27) |
| Claim left by a live owner (`attack-live-claim-blocks`) | **Defers, no duplicate**; recovers when the claim clears | `live-claim-defers` `d=0, r=0, u=1, m=2`; after clearing the claim `d=1, r=1, u=0, m=0, c=1` | Holds (liveness) |
| Malformed `.claim` (`attack-garbage-claim`) | **Defers/stalls, no duplicate** | `garbage-claim-defers` `d=0, r=0, u=1, m=2` | New, non-blocking (unreachable by own writes) |
| Dead-owner claim reclaimed (`attack-dead-claim-reclaimed`) | **One record, one delivery** | `d=1, r=1`; adoption `d=1, u=0, m=0, c=1` | Holds |
| Claim vs marker disagreement (claim bytes ≠ stale marker) | **One record** | same scenario as above; the post-rename identity check ties the published marker to the winner's `deliveryId` | Holds |
| Regression set (adoption-loss, double-destination, crash-before-append, rise-after-committed, fresh-session, EACCES, leaked-marker, marker-write-crash, reclaim-takeover-before-rename) | **All pass** | `/tmp/f09-out.json` last-stage table below | Holds |
| Flag-off default path | **Unchanged** (no dedupe, as designed) | `default-restart` `d=2, r=2`; `durable-restart` `d=1, r=1` | Holds |
| Frozen Durable Outcome append / `runtime/` / `bin/fm-branch-outcome.sh` | **Untouched** | `git show --stat 081b8b93` touches only `.pi/extensions/fm-branch-supervision.ts`, docs 24/26/27, `tests/assets/pi-f09-probe.mjs`; `git diff --stat 081b8b93 -- runtime bin` is empty | Holds |

## Per-question findings

### 1. Reproduce the doc-26 counterfactual

Command (pre-fix extension = parent `9250c40b`, HEAD probe, temp sweep suppressed by the probe's `keep-marker-temps` schedule):

```
PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
FM_F09_LAB=/tmp/f09-prefix-lab \
FM_F09_PLUGIN=/tmp/prefix-ext/.pi/extensions/fm-branch-supervision.ts \
FM_F09_ROOT="$PWD" FM_PI_F09_OUTPUT=/tmp/prefix-f09.json \
node tests/assets/pi-f09-probe.mjs
```

Result: probe exit 1 with

```
AssertionError [ERR_ASSERTION]: the reclaim window must not leave two durable records
2 !== 1
  at controller (tests/assets/pi-f09-probe.mjs:745:14)
```

and observations `successor-without-temp-sweep d=1,r=1,u=0,m=1` then `first-reclaimer-resumes-without-sweep d=2,r=1`. This is the doc-26 `resumed.diskRecords: 2` result.

Same schedule against HEAD (`FM_F09_PLUGIN="$PWD/.pi/extensions/fm-branch-supervision.ts"`, `FM_PI_F09_ONLY=1` run below) settles at: successor `d=0,r=0,u=1,m=3` (the successor cannot take the first reclaimer's live claim and publishes nothing), resumed first reclaimer `d=1,r=1,u=1,m=2`, adoption `d=1,r=1,u=0,m=0,c=1`. Exactly one durable record and one visible delivery. **Confirmed.**

### 2. Attack `linkSync` exclusivity

- **Dead-claim cleanup race.** Two reclaimers observe the same crashed owner. Scratch schedule `attack-dead-claim-race`: first reclaimer stops inside `removeDeadClaim` before its `rmSync`; second takes the lock, removes the dead claim, links its own claim, and stops before `renameSync`; the lock is then returned to the first, which resumes and removes the second's live claim. Result: first resumes `d=1,r=1,c=1`, second resumes `d=1,r=0` — one durable record, one visible delivery. The race can stall a row, not duplicate it, because only one `renameSync(claimPath, target)` can succeed (a successful rename consumes the claim path) and the post-rename identity check (`readReservation(seq)?.deliveryId !== deliveryId`, extension line 1316) refuses to append against a marker that does not name the reclaimer's delivery.
- **Takeover between the claim link and the rename.** `linkSync(sourcePath, claimPath)` (line 1293) is the atomic winner decision; a second reclaimer gets `EEXIST` and returns without publishing. The first reclaimer's claim is a durable hard link, so it also survives the successor's abandoned-temp sweep (the sweep's `.claim` branch at line 1348 routes to `removeDeadClaim`, never the temp `rmSync`). Evidence: `reclaim-takeover-without-temp-sweep` and `reclaim-takeover-before-rename` above.
- **Claim spoofing or accidental sweeping.** A `.claim` held by a live owner is not swept (`removeDeadClaim` line 1255 leaves a live owner's claim; `attack-live-claim-blocks` defers with `d=0`). A malformed claim is also not swept and stalls (`attack-garbage-claim` defers with `d=0`). Neither produces a second record.
- **Claim vs marker disagreement.** The claim carries the replacement bytes and becomes the marker; after the rename the identity check ties marker to delivery. A claim whose bytes name a different delivery only causes the loser to abort. `attack-dead-claim-reclaimed` (`d=1,r=1`) confirms.
- **Live-but-replaced owner.** A live owner that loses the lock leaves its claim; a successor defers (`reservationReclaimable` line 1531 requires lock ownership and a dead owner; `removeDeadClaim` leaves live owners alone). The row stalls until the owner exits or resumes and removes its own claim. Liveness, not loss.

### 3. Regression set re-run

All HEAD F09 schedules passed (`verdict=PASS`, `F09_PROBE_COMPLETE verdict=PASS`, exit 0). Last-stage observations:

```
adv-commit-race                  replacement-commits-after-race   d=1 r=1 u=0 m=0 c=1
default-restart                  reopened-and-retried             d=2 r=2 u=0 m=0 c=1
double-destination-append        cursor-completes-on-reopen       d=1 r=1 u=0 m=0 c=1
durable-restart                  reopened-and-retried             d=1 r=1 u=0 m=0 c=1
fresh-session                    reconcile-after-flush            d=1 r=1 u=0 m=0 c=1
leaked-marker-reclaim            leaked-marker-reclaimed          d=1 r=1 u=0 m=0 c=1
marker-write-crash               recovered-after-marker-crash     d=1 r=1 u=0 m=0 c=1
new-destination-before-ack       original-destination-...-cursor  d=1 r=1 u=0 m=0 c=1
reclaim-interleave               first-reclaimer-resumes          d=1 r=0 u=1 m=1 c=0
reclaim-takeover-before-rename   adopt-and-cleanup-after-window   d=1 r=1 u=0 m=0 c=1
reclaim-takeover-without-temp-sweep adopt-and-cleanup-after-no-sweep d=1 r=1 u=0 m=0 c=1
reservation-crash-before-record  recorded-destination-reclaims-... d=1 r=1 u=0 m=0 c=1
reservation-crash-fresh-destination fresh-destination-reclaims-... d=1 r=1 u=0 m=0 c=1
takeover-after-append-before-commit stale-owner-resumes-after-adoption d=1 r=1 u=0 m=0 c=1
takeover-at-destination-write    cursor-completes-on-reopen       d=1 r=1 u=0 m=0 c=1
write-failure                    restart-after-recovery           d=1 r=1 u=0 m=0 c=1
```

(`d`=diskRecords, `r`=renderedCopies, `u`=unread, `m`=deliveryMarkers, `c`=cursor.)

### 4. No new loss or duplicate; default path; frozen append

- No schedule produced two durable records or two visible deliveries for one committed note.
- Default (`FM_PI_DURABLE_DELIVERY` off) behavior is unchanged: `default-restart` still produces one durable record per reopened session (`d=2`), which is the pre-existing contract; the claim machinery is gated by `durableDeliveryEnabled` (line 173; used at 1744, 1770, 1781).
- The commit changes only `reclaimReservation`/`removeDeadClaim`/`reclaimReadDeliveryMarkers`. `appendDurableOutcome` (line 1404) and `adoptDurableDelivery`/`recordedDelivery` are not in the diff; `runtime/` and `bin/fm-branch-outcome.sh` are byte-unchanged relative to `081b8b93`.

### 5. Shipped suites re-run

- `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `exit=0`, `F09_PROBE_COMPLETE verdict=PASS`, ~26 s.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> `exit=0`.
- `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass, `0` fail.
- Attack probe (scratch schedules, HEAD extension): `FM_PI_F09_ATTACK=1 ... node tests/assets/pi-f09-probe.mjs` -> `verdict=PASS`, `F09_PROBE_COMPLETE verdict=PASS`, exit 0.

## New issue

**Malformed or empty `.claim` stalls its sequence (liveness only).** `removeDeadClaim` (extension lines 1255-1268) parses the claim and returns early when `parseReservation` yields `null`; `parseReservation("")` returns `null` for an empty file, and the legacy fallback for non-JSON text yields `owner: ""`, for which `pidAlive("")` is `true` (`process.kill(0, 0)` succeeds; `pidAlive` at line 388). So a garbage or empty `.claim` is never reclaimed and every later `linkSync(sourcePath, claimPath)` fails `EEXIST`, stalling that sequence indefinitely. Evidence: `attack-garbage-claim` (`d=0, r=0, u=1, m=2`). Reachability: the extension only ever creates a claim by `linkSync` from a fully-written replacement temp, so an empty/garbage claim cannot arise from its own writes; it needs external corruption or a filesystem anomaly. This is a robustness/liveness note, not a data-loss or duplication path, and does not block the claim change. A one-line hardening would be to treat an unparseable or empty claim file as reclaimable (remove it) instead of leaving it.

## What remains uncovered

- Free-running multi-process reclaim with no lock change: not tested (doc 27's own scoped limit). The probe serializes reclaim by the lock and simulates takeover by re-granting it; a truly lockless race was not exercised.
- Filesystems without hard-link support, cross-device marker directories, or a filesystem where `linkSync`/`renameSync` is not atomic: not tested; reclaim would stall rather than duplicate.
- PID reuse making a dead claim owner look alive: not tested; would stall a row for as long as the reused PID lives.
- The full non-F09 live branch guard and the responsiveness live e2e were not run; only the F09-only path plus the source-level extension test were.
- Windows/other platform hard-link semantics were not exercised.

## Recommendation

The exclusive-create claim is a real, atomic fence: the winner is decided by `linkSync`, the claim is not swept by the abandoned-temp reclamation, and the post-rename identity check plus `recordedDelivery` prevent a second append even across a dead-claim cleanup race. The doc-26 window is closed and the regression set is green. Ship the change as-is; the malformed-claim stall can be filed as a separate low-priority hardening and does not gate this work.

ADVANCE
