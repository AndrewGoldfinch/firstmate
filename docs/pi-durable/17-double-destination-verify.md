# Pi Durable rollback-adoption fix: independent adversarial verification

- Verified commit: `a8346ffb24457655d068b871ba349d8944a7ecae` (detached checkout of the landed fix; extension sha256 `7d35b69a0edf74b91162973c83e49866830d36bdc6837807c783fbacd34f24f1`).
- Probe: real-SDK F09 probe, Pi `1.0.0`, node `v22.21.1`, linux. Probe sha256 `26ee82d8c34956ff2dc7d8c7d17e46a209ef929866e7e63a6658aef9071b4886`.
- Method: source read of the changed functions, all three requested test suites, one falsification run with the extension reverted, and one scratch probe scenario (reverted; nothing pushed) constructing a new schedule.
- Unix sockets work (`AF_UNIX` bind succeeds), as the live e2e requires.

**Verdict: HOLD - IMPLEMENTATION.** The specific deterministic loss that `15-delivery-fixes-verification.md` recorded is fixed and the regression test genuinely detects it. A constructed schedule still produces a permanent duplicate (two durable records for one row), on the same delivery path and inside the residual the fix itself documents.

## Commands run

| Command | Result |
| --- | --- |
| `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` | exit 0, `F09_PROBE_COMPLETE verdict=PASS` |
| `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` | exit 0, `58` ok, `0` failed |
| `(cd runtime/pi-durable && npm ci && npm test)` | exit 0, `81` pass, `0` fail |
| Same probe with extension reverted to `7032f6e7` | exit 1, `AssertionError: the adopted delivery must survive the stale owner's rollback`, `actual: 0, expected: 1`, `pi-f09-probe.mjs:394` |
| Scratch probe scenario `double-destination-append` on the fixed extension | `diskRecords: 2` after both owners commit |
| Scratch probe scenario `double-destination-append` on reverted extension | `diskRecords: 1` (pre-fix removed the uncommitted sibling) |

## Challenge table

| Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- |
| Re-run the adoption + rollback schedule (stale owner appends, replacement adopts, stale owner resumes) | PASS - one record, no loss | probe `takeover-after-append-before-commit`, both stages `diskRecords: 1` (`/tmp/pi-f09-rollback.json`); same scenario in `/tmp/run_e2e.log` | The recorded loss is fixed |
| Does the regression actually detect the loss, or pass vacuously? | The test has power | revert extension to `7032f6e7`, keep probe: fails `actual: 0, expected: 1` at `tests/assets/pi-f09-probe.mjs:394` (`/tmp/run_e2e_reverted.log`) | Fix is causal, not test-side |
| Can a stale owner roll back an adopted record now? | No | `committedId === deliveryId` returns at `.pi/extensions/fm-branch-supervision.ts:1070`; no-marker case refuses at `:1073`; probe adoption stage `diskRecords: 1` | Closed |
| Can two owners both deliver? | **Yes - reproducible duplicate** | scratch `double-destination-append`: after first resumes `diskRecords: 2`, after second commits `diskRecords: 2` (`/tmp/pi-f09-extra.json` lines for `first-resumes-without-marker` / `second-commits-its-own-record`) | New finding; see below |
| Can two owners both drop (permanent loss)? | Not found | the marker-named record is protected by `:1070`; a no-marker/unread row re-appends on the next reconciliation (`appendDurableOutcome` `matched` branch `:1215-1219`) | No loss reproduced |
| Can the marker be spoofed, leaked, or reclaimed while needed? | Leak reclaimed; reclaim respects unread; spoofing is same-home file access | `reclaimReadDeliveryMarkers` skips any `seq` in the unread set (`:1171-1187`, call `:1432`); probe `leaked-marker-reclaim` reclaims a marker for a read row | Bounded; no loss |
| Is `deliveryCommitted` sound now? | Sound against this code removing a committed record | marker is written only after `appendDurableOutcome` proves durability (`:1278`), and every removal path is gated on the marker (`:1070`) or a surviving sibling (`:1073`) | Sound for the tested schedules |
| Legacy empty marker: loss? | No loss; rollback refuses | `readCommittedDeliveryId` returns `null` for an empty marker (`:1139-1145`), so `:1073` refuses without a sibling; `deliveryCommitted` still suppresses a duplicate | Handled |
| Un-poison on rollback correct (no phantom/rendered duplicate)? | Correct by inspection and JSON, but not asserted | probe `takeover-at-destination-write` `old-owner-resumes-after-replacement`: `memoryRecords: 0`, `renderedCopies: 1` (the replacement's note); no probe assertion or re-reconcile checks the phantom | Coverage gap, not a defect |
| Default (flag off) path unchanged | Yes | `durableDeliveryEnabled` gates only the new calls (`:1432`, `:1458`, `:1469`); `deliverRoutineOutcome` untouched; probe `default-restart` and the 58 extension tests pass | No regression |
| Frozen Durable Outcome append mechanism untouched | Yes | `git diff --stat 7032f6e7 a8346ffb` = only `.pi/extensions/fm-branch-supervision.ts`, doc 16, `tests/assets/pi-f09-probe.mjs`; `runtime/pi-durable` unchanged; 81 runtime tests pass | No regression |

## Per-question findings

### 1. Re-run the adoption + rollback schedule
One delivery, no loss. The probe's `takeover-after-append-before-commit` stops the stale owner with a real `SIGSTOP` inside `fs.appendFileSync` after the durable append, starts a replacement that opens the same session file and adopts the record, then resumes the stale owner. Both observed stages report `diskRecords: 1`, `unread: 0`, `deliveryMarkers: 0`. Falsification confirms the scenario is real: with only the extension reverted to `7032f6e7` and the probe kept, it fails `actual: 0, expected: 1`.

### 2. New marker attacks
- Stale owner rolling back an adopted record: blocked. `rollbackDeliveryEntry` returns immediately when the marker names this owner's `deliveryId` (`:1065-1070`), and when no marker names a winner it refuses unless a different record for the same sequence is present in its own session file (`:1073`, `hasSiblingDelivery` `:1112-1130`).
- Two owners both delivering: **not prevented** (see the new issue).
- Two owners both dropping: not found. The marker-named record is never the record a rollback removes, and a no-marker row that loses all records is still unread, so the next reconciliation re-appends (`:1215-1234`).
- Spoof / leak / reclaim: the marker is a same-home `O_EXCL` file whose content is the winning `deliveryId` (`:1150-1158`); an empty or malformed marker degrades to "unknown owner" and refuses rollback. `reclaimReadDeliveryMarkers` removes only markers whose `seq` is not in the `unread` snapshot, and runs before the delivery loop (`:1432`), so a still-needed marker is kept. `leaked-marker-reclaim` passes.
- `deliveryCommitted` soundness: presence is written only after `appendDurableOutcome` returns a durable match (`:1278`), and no rollback removes the marker-named record (`:1070`); that makes presence a valid exactly-once proof for the tested schedules.

### 3. Legacy empty marker
No loss. An empty marker makes `readCommittedDeliveryId` return `null`, so a stale owner's rollback takes the no-marker branch and refuses without a sibling (`:1073`). Presence still suppresses a duplicate because `deliveryCommitted` is `existsSync` only. The probe's `leaked-marker-reclaim` seeds exactly this empty marker and the next reconciliation reclaims it.

### 4. Un-poison on rollback
Correct: a successful rollback splices the record out of Pi's in-memory `fileEntries` and fixes `byId`/`leafId` (`unpoisonSessionEntry`, `:1037-1063`, called at `:1107`). The probe's `takeover-at-destination-write` run shows `memoryRecords: 0` on the resumed stale owner. Coverage gap: no probe assertion or unit test re-runs a reconciliation in the rolled-back process, so a regression in the phantom can only be caught indirectly. Reasoning shows the phantom matters: a surviving in-memory match would let `appendDurableOutcome` return `appended: false` with a `deliveryId` and commit a marker with no disk record, which a later restart would treat as delivered.

### 5. Default path and frozen mechanism
Default (`FM_PI_DURABLE_DELIVERY` unset) path unchanged: only `reclaimReadDeliveryMarkers`, `ensureRoutineOutcome`, and `clearDelivery` are gated (`:1432`, `:1458`, `:1469`), and `deliverRoutineOutcome` is byte-identical. The frozen append mechanism (`runtime/pi-durable`) is not in the diff; `git diff --stat 7032f6e7 a8346ffb` lists only the extension, doc 16, and the probe.

### 6. Other schedules
Only the duplicate below was reproducible. Concurrent double-delete with no marker does not lose a note permanently because the row stays unread and is re-appended.

## New issue: reproducible permanent duplicate (`double-destination-append`)

Schedule (scratch probe scenario, reverted after use): two destinations reconcile one unread routine row with two different session files.
1. Destination A is granted the lock, told `pause-after-write`, and stops (real `SIGSTOP`) immediately after its durable append, before `sessionFlushed`/`generationOwnsLockSync` and before any marker.
2. Destination B opens a different session file, is granted the lock, and also stops after its append, before committing the marker. Both records are on disk, no marker exists.
3. A resumes. Its `generationOwnsLockSync` fails, so it calls `rollbackDeliveryEntry(seq, A_file, ..., D_A)`. `readCommittedDeliveryId(seq)` is `null` (no marker) and `hasSiblingDelivery(A_file, ...)` is `false` (B's record is in B's file), so the guard at `:1073` returns and keeps `D_A`.
4. B resumes, `commitDelivery(seq, D_B)` succeeds, the row is marked read, and the marker is cleared.

Fixed extension: `diskRecords: 2`, `unread: 0`, `cursor: 1`, `deliveryMarkers: 0` (`/tmp/pi-f09-extra.json`). Both records are permanent: the row is read, no rollback is outstanding, and later reconciliations deliver nothing.

Tradeoff evidence: the same scratch scenario on the reverted extension reports `diskRecords: 1` at the `first-resumes-without-marker` stage (`/tmp/pi-f09-doubledest-prefix.json`), because the pre-fix rollback removed `D_A` unconditionally. The fix therefore converts the pre-fix behavior from "remove the aborted owner's record" to "keep it", which closes the adoption loss but leaves an orphan when the two owners never share a session file.

This is the class doc 16's Residual describes ("a genuinely concurrent append during the rollback window is still not reconciled atomically"), and the fix does not make it worse in binary terms: losing the only committed note (pre-fix) is worse than an extra rendered copy (post-fix). It is still a reproducible violation of the probe's own invariant ("one committed note is one home-wide delivery") and of exactly-once on disk. A stronger protocol would reserve the home-wide identity before the append (commit the marker naming a pre-allocated `deliveryId`, then append) so a loser always sees a winner, or reconcile orphan records after the marker commit.

## What remains uncovered

- Re-reconciliation after a successful un-poison, to prove the phantom cannot cause a marker-with-no-record delivery.
- A free-running (no `SIGSTOP`) two-process race; the scratch scenario forces the interleaving deterministically.
- A legacy empty marker whose corresponding record no longer exists anywhere: `deliveryCommitted` would mark the row read and the note would never render. That is pre-existing corruption, not introduced here.
- Remote/different-home destinations and Pi session pruning/rotation, which could remove the marker-named record while the marker persists.

## Recommendation

Keep the loss fix (it is verified and its regression has power), but before treating the delivery boundary as exactly-once, address the double-destination duplicate: either reserve the delivery identity before the append, or reconcile an orphan record once a different `deliveryId` wins the marker. If the captain chooses to accept the narrow duplicate as a documented residual instead, record that explicitly; the loss fix itself should not be reverted.

ADVANCE not taken because a requested check (exactly-once, no duplicate) is falsified with a reproducible schedule. HOLD - EVIDENCE not taken because the evidence is complete and reproducible. HOLD - IMPLEMENTATION.
