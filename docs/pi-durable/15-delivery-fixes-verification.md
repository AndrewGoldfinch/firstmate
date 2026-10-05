# Independent adversarial verification: real-SDK delivery-boundary fixes (fd1dbb83)

Task: `pi-durable-delivery-fixes-verify` (scout). Deliverable: this report only; no repository code was modified.
Base commit under test: `fd1dbb8364548c9ba3b8c80f3859453eebc14ab9` (`experiment/pi-durable-delivery-fixes`), checked out detached in a scratch worktree.
Environment: Pi coding-agent `1.0.0`, Node `v22.21.1`, Linux (WSL2), non-root user `andy`.
Scope of change inspected: `.pi/extensions/fm-branch-supervision.ts` (home-wide `.branch-outcomes-delivered/<seq>` `O_EXCL` marker, flush-durable guard, owner fence), `tests/assets/pi-f09-probe.mjs`, `tests/fm-pi-branch-extension.test.sh`, `tests/fm-pi-branch-live-e2e.test.sh`, `docs/pi-durable/13-*.md`, `docs/pi-durable/14-delivery-boundary-fix.md`.

## Verdict

**HOLD - IMPLEMENTATION.**

The two original defects are fixed for the exact schedules the shipped probe uses, and every tested path is exactly-once with no loss.
But an independent adversarial schedule still **loses a committed routine note** at the real-SDK boundary: when a replacement session adopts the stale owner's already-appended record as its own durable delivery and completes the cursor, the stale owner's lost-fence rollback then deletes that same record by `deliveryId`. The result is zero on-disk deliveries, the row read, and the home-wide marker cleared - a permanent loss that the probe's own `PASS` does not exercise.
This is a new defect on the fix's own rollback path, not one of the two prior counterexamples and not the residual the doc admits.

## What I ran (evidence)

1. `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> `exit=0`, `58` `ok` assertions, `duration_ms=67573`, `gate_skip=false`. The two new regressions pass:
   - `ok - durable delivery identity keeps one committed routine note to one home-wide delivery across a destination replacement`
   - `ok - durable delivery identity defers a note until the session file is flushed and never acknowledges an in-memory-only delivery`
   - plus the pre-existing durable tests (`...makes a committed routine note exactly once...`, `...survives replay and takeover...`, `...streaming neither duplicates nor loses`).
2. `FM_PI_BRANCH_LIVE_E2E=1 FM_PI_F09_ONLY=1 FM_PI_F09_OUTPUT=/tmp/pi-f09.json bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` -> `exit=0`, `verdict=PASS`, `duration_ms=9410`. The seven shipped scenarios reproduce exactly the assertions in `tests/assets/pi-f09-probe.mjs`.
3. `(cd runtime/pi-durable && npm ci && npm test)` -> `81` pass / `0` fail after `npm ci`. (First run without `npm ci` failed 10 tests only because the worktree `node_modules` was incomplete: `Cannot find package '.../node_modules/@earendil-works/pi-ai/index.js'`. `npm ci` resolved it; the failures were environmental, not code.)
4. Unix sockets: `AF_UNIX` bind/listen/connect succeeds in this environment (Python `socket.AF_UNIX` probe). The runtime unit suite that uses Unix sockets passes with `# skipped 0`.

## Adversarial reproduction (the new loss)

I copied the shipped probe to a scratch path and added one hook and one scenario; the repository was not touched.

- Hook: `pause-after-write` pauses the worker immediately **after** its real `fs.appendFileSync` of the session record (so the record is on disk, `flushed` is still true, and the extension has not yet run its post-append ownership recheck).
- Scenario `takeover-rollback-race`:
  1. `setup()` commits one routine row (seq 1) through the real outcome store.
  2. Launch stale owner `A`, grant it the lock, arm `pause-after-write`, and call `start`; `A` appends its routine record to `sessions/main.jsonl` and stops (`SIGSTOP`) before its ownership recheck.
  3. Launch replacement `B` **after** `A`'s append, so `B`'s real `SessionManager` loads the file containing `A`'s record. Grant `B` the lock and call `start`.
     `B`'s `appendDurableOutcome` finds `A`'s record already matches the row, returns `{ok:true, deliveryId:null}` **without appending**, commits the home-wide marker, completes the cursor, and clears the marker.
  4. `SIGCONT` `A`; its ownership recheck fails, so `rollbackDeliveryEntry` removes its own record (the record `B` just adopted) by `deliveryId`.

Scratch artifacts: `/tmp/adv-probe.mjs`, `/tmp/adv-f09.json`, `/tmp/adv-f09-run2.json`, `/tmp/adv.log`, `/tmp/adv2.log`. Two independent runs produced identical observations:

```
replacement-adopts-stale-record       | render 1 disk 1 dest 1 mem 1 unread 0 cursor 1 markers 0
stale-owner-rolled-back-after-adoption | render 1 disk 0 dest 0 mem 1 unread 0 cursor 1 markers 0
```

After the run, the only session file is the shared `sessions/main.jsonl`:

```
$ wc -l sessions/main.jsonl            -> 3
$ grep -c F09_PROBE_ONE_LOGICAL_NOTE sessions/main.jsonl -> 0
$ cat state/.branch-outcomes-cursor    -> 1
$ bin/fm-branch-outcome.sh unread      -> (empty)
$ ls state/.branch-outcomes-delivered  -> (empty)
```

The three surviving lines are `session` header, `message` (user), `thinking_level_change` - no delivery record. The one committed note is gone from disk, the outcome cursor is at `1` (row read/acknowledged), and the home-wide marker has been cleared, so a restart re-delivers nothing. This is a permanent loss of a committed routine note.

Root cause (file:line):

- `.pi/extensions/fm-branch-supervision.ts:1192` `ensureRoutineOutcome`; `:1194` `if (deliveryCommitted(row.seq)) return true;`.
- `:1125` `appendDurableOutcome`; `:1131-1144` the matching scan returns a durable success with `deliveryId: null` when a record for the row already exists in the loaded session, with no ownership/identity binding to the process that wrote it.
- `:1153-1156` the post-append lost-fence path calls `rollbackDeliveryEntry(currentMainSession.getSessionFile(), customType, deliveryId)`.
- `:1201-1203` the lost-claim path calls the same rollback.
- `:1062` `rollbackDeliveryEntry` deletes every JSONL line whose `data.deliveryId` equals this owner's id.

The fence records **that** a delivery happened but not **which** record/deliveryId is canonical. A replacement can adopt the stale owner's record as the delivery, and the stale owner can then legally delete it. The doc's claim "a stale owner that lost the marker race removes its own record, so the home keeps exactly one copy and a sibling owner's copy survives" assumes the sibling appended its own copy; in the adoption case there is no sibling copy.

Candidate fix direction (for firstmate to scope, not implemented): make the marker carry the winning `deliveryId`, or refuse a lost-fence/lost-claim rollback when `deliveryCommitted(row.seq)` is already true, or force the adopter to append under its own `deliveryId` instead of adopting by sequence. Any of these closes the window; the first is the most explicit.

## Challenge table

| Challenge | Result | Evidence | Gate impact |
| --- | --- | --- | --- |
| 1. Replaced destination yields exactly one home-wide delivery | PASS for the shipped schedule | Probe `new-destination-before-ack`: original `disk 1`, replacement `dest 0`, `unread 0`, `markers 0`; new extension test `...replacement_destination_does_not_re_deliver` passes | Supports ADVANCE |
| 2. Paused/superseded owner cannot append or render | **FAIL** | Probe `old-owner-resumes-after-replacement`: stale `memoryRecords 1` (phantom), `renderedCopies 1` while its disk line was rolled back; my `takeover-rollback-race` shows the stale owner appends, is adopted, then its rollback destroys the adopted record (`disk 0`, `unread 0`, `cursor 1`, `markers 0`, no note line) | **HOLD - IMPLEMENTATION** |
| 3. Fresh session with no conversation defers and never loses | PASS | Probe `fresh-session`: `mem 1`, `disk 0`, `unread 1`, `cursor 0`, `markers 0`; restart `unread 1`; `converse` -> `disk 1`; `retry` -> `unread 0`; new test `...defers_until_the_session_flushes` passes | Supports ADVANCE |
| 4. Real `EACCES` rolls back so a later retry delivers, no false cursor advance | PASS | Probe `write-failure`: `memoryRecords 0`, `disk 0`, `ioErrors ["EACCES"]`, `unread 1`, `markers 0`; after `chmod 600` retry `disk 1`, `unread 0` | Supports ADVANCE |
| 5. Same-file restart after failed cursor write is exactly one delivery | PASS | Probe `durable-restart`: before `disk 1`, `unread 1`, `markers 1`; after restart `disk 1`, `unread 0`, `markers 0` | Supports ADVANCE |
| 6. No loss; default (flag off) path unchanged; frozen append untouched | **FAIL (no loss)** / partial on the rest | Loss proven by `takeover-rollback-race` above. Default presentation `deliverRoutineOutcome` is byte-identical, but the new ownership fence at `:1379` also runs for the flag-off and captain paths; `git show --stat fd1dbb83` touches no `runtime/` or `bin/fm-branch-outcome.sh` file, so the frozen append mechanism is untouched | **HOLD - IMPLEMENTATION** |
| 7. New attack surface from the fix | **FAIL** | (a) adoption+rollback loss (above); (b) stale owner keeps an in-memory phantom and rendered copy because the rollback path skips `unpoisonSessionEntry` (`:1062` vs `:1037`); (c) marker leaks on a crash between `mark-read` and `clearDelivery` (`:1383`); (d) `deliveryCommitted` trusts the marker without verifying any durable record survives | **HOLD - IMPLEMENTATION** |

## Per-question findings

**Q1 - destination replacement.** Correct. `commitDelivery` (`:1102`, `O_EXCL`) gives one home-wide claim; the replacement sees `deliveryCommitted(seq)` at `:1194` and returns before appending, then completes the cursor. Verified by the shipped probe and the new extension test.

**Q2 - stale-owner takeover.** Not safe. Two distinct problems:
- The stale owner **does** render and does retain its entry in Pi's in-memory `fileEntries`. In the shipped probe's own `old-owner-resumes-after-replacement` row the stale snapshot reports `memoryRecords 1` and `renderedCopies 1` even though the rollback removed its file line. The rollback path rewrites only the file; it never calls `unpoisonSessionEntry`, so the phantom and the rendered copy stay. The `renderedCopies` assertion in the probe is the stale owner's own render, so the probe reads "one copy" while two sessions each rendered the note.
- The stronger defect: the adoption+rollback sequence demonstrates the stale owner can still append (as owner, before losing the fence) and then delete the only delivered record.

**Q3 - fresh session, no conversation.** Correct. `sessionFlushed` (`:1027`) treats `flushed !== false` as durable; a never-flushed session returns `{ok:false}` (`:1155`), so the cursor never crosses the in-memory-only record, the record is re-found and (once flushed) committed exactly once, and the marker is cleared after read.

**Q4 - real `EACCES`.** Correct. `pi.appendEntry` throws, `unpoisonSessionEntry` (`:1037`, called at `:1150`) removes the phantom from `fileEntries`/`byId`/`leafId`, no marker is committed, and the cursor stays. Retry after permission recovery appends for real exactly once. I confirmed the real SDK's `_persist` is append-only once `flushed`, and that `flushed` is only ever set after a full write, so un-poisoning the in-memory list is sound.

**Q5 - same-file restart after failed cursor write.** Correct. The marker persists across the restart (`markers 1`), the re-opened session matches the durable record, `ensureRoutineOutcome` short-circuits on `deliveryCommitted`, and only `mark-read` remains; one disk record, `unread 0`.

**Q6 - no loss / default path / frozen append.** The frozen append mechanism is untouched (`git show --stat fd1dbb83` changes only the extension, two test files, the probe, and two docs). The default presentation body is unchanged. But no-loss fails because of Q2/Q7, and the new pre-`mark-read` ownership fence at `:1379` is a control-flow change that also applies to the flag-off routine path and the captain path, so "default path unchanged" is only true of the presentation message, not the reconcile loop.

**Q7 - new attack surface.**
- *Adoption+rollback loss (primary):* described above. Deterministic, reproduced twice.
- *Rollback does not un-poison memory:* `rollbackDeliveryEntry` (`:1062`) removes only the file line; `unpoisonSessionEntry` (`:1037`) is not called. I read the real SDK to bound this: once `flushed` is true, `_persist` uses `appendFileSync` and does not rewrite `fileEntries`, and the full-rewrite path (`_rewriteFile`, SDK session-manager lines ~754-766, ~723) runs on initial flush or migration only. So the phantom normally stays out of the file, but it is a visible transient duplicate and a latent duplicate if any future code path rewrites the session from `fileEntries` while `flushed` stays true (e.g. a branch/resume built on the live list).
- *Marker ledger:* `clearDelivery` (`:1112`, called `:1383`) runs only after a successful `mark-read`. A crash between them leaves a zero-byte marker indefinitely; the directory stays bounded only to one leaked marker per crashed delivery, not "removed once read" under crash.
- *Marker as sole source of truth:* `:1194` trusts the marker without checking that any durable record still exists. That is sound only while nothing can delete a committed record - which Q2's rollback can.

## What remains uncovered

- The doc's own admitted residual ("a concurrent append during the rollback window can still be lost") was **not** independently reproduced; the adoption+rollback loss is a stronger, deterministic failure on the same code path, so the residual stays plausible and untested.
- No genuine multi-process free-running concurrency beyond `SIGSTOP`-controlled schedules; real scheduler interleavings could expose additional orders.
- Captain-verdict delivery under the real SDK (only the routine path is exercised end-to-end; the captain path shares `appendDurableOutcome` but has no home-wide marker).
- Host power loss, filesystem corruption, and the runtime sidecar's Unix-socket transport end-to-end (AF_UNIX works and the runtime unit suite passes, but the F09 probe is in-process and does not drive the sidecar over its socket).

## Recommendation

Do not advance the current fix as-is. The two shipped defects are genuinely fixed and the flush-durable guard is sound, but the rollback path can still destroy the only committed delivery. Extend the fix (candidate directions under "Adversarial reproduction") and add a real-SDK regression that pauses the stale owner **after** its append and lets a replacement adopt the record, then asserts the note still exists on disk after the stale owner resumes. Say so if firstmate wants this promoted: the defect is reproduced, deterministic, and the fix direction is clear.

Final line: **HOLD - IMPLEMENTATION**
