# Independent adversarial verification: durable routine delivery fix

- Commit under test: `44714b57` ("Merge durable routine delivery persistence fix"), whose implementation commit is `0b575e4b` ("fix(pi-durable): persist routine delivery before the cursor advances"). Checked out detached from `origin` in this disposable worktree.
- Task: `pi-durable-delivery-verify2` (scout; deliverable is this report).
- Prior verification: `docs/pi-durable/11-delivery-verification.md` returned **HOLD - IMPLEMENTATION** for `3d8cf6c4` because the routine record was only queued in memory by `deliverAs: "nextTurn"` at every `turn_end` (main streaming), so v1 re-delivered and could lose a note.
- Environment: Linux, node v22.21.1, bash 5.x. Unix domain sockets `AF_UNIX` bind/listen/connect: **OK** (verified with a node `net.createServer`/`connect` round trip, `unix-socket: pong`).
- Shipped suite: `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> `FM_TEST_BEGIN 2026-10-05T06:35:39Z` ... `FM_TEST_END ... exit=0 duration_ms=62870`, `FM_TEST_SUMMARY total=1 failed=0`, 56 `ok -` lines, including the three new durable tests at log lines 54-56.
- Adversarial harness: `.verify-scratch2/adv.sh` reuses the shipped fixture but replaces the fixture's always-synchronous `appendEntry` with a model of the real Pi `SessionManager._appendEntry` (push into `fileEntries` BEFORE `_persist`, a throwing `_persist` leaves the record visible to `getEntries()`, and a silent no-write when a fresh session has no user/assistant entry).

## Core reading of the fix

- `VISIBLE_ROUTINE_ENTRY_TYPE = "fm-branch-visible-routine"` (`.pi/extensions/fm-branch-supervision.ts:198`).
- `deliverRoutineOutcome` no longer carries a durable `details` record; `details: undefined` always (`:1049-1058`). It is only reached when `durableDeliveryEnabled` is false.
- `ensureRoutineOutcome` (`:1066-1090`) searches `currentMainSession.getEntries()` for a `custom` entry of that type keyed on store `seq`; on a match it returns true; otherwise it `pi.appendEntry`s the record and then verifies with `currentMainSession.getEntries().some(...)` (`:1083-1087`). A same-`seq` record with different content returns false (fail closed). The reconcile loop calls this, then `mark-read --through seq` (`:1254-1259`).
- Entry renderer registered at `:2537`; message renderer `fm-branch-merge` stays for the flag-off path. Under the flag no `fm-branch-merge` message is sent.
- Test fixture now models the `deliverAs:"nextTurn"` queue (`tests/fm-pi-branch-extension.test.sh:565`, `:572`) and the new streaming test is at `:6151`.

## Challenge table

| # | Challenge | Result | Evidence | Gate impact |
|---|-----------|--------|----------|-------------|
| 1 | Delivery record synchronous before `mark-read`; no re-delivery on the real streaming path (normal persistence) | **PASS** | Shipped streaming test (`:6151`, log line 56) passes; custom non-streaming arm delivers exactly one durable entry across two reconciles with no `fm-branch-merge` message (`SCENARIO4`). | none |
| 2 | F09 window: delivery -> crash; delivery -> failed ack; replay; restart; new main session; streaming | **PASS for normal persistence, FAIL under a failed/skipped `_persist`** | Shipped streaming test passes. `SCENARIO1`: `{"memAfterFirst":1,"diskAfterFirst":0,"afterFirstUnread":"<row>","afterSecondUnread":"","diskAfterSecond":0,"afterRestart":0}`. | residual (below) |
| 3 | Loss check: is every committed routine note delivered at least once? | **FAIL under `_persist` failure or silent skip** | `SCENARIO1` and `SCENARIO2` (`{"mem":1,"disk":0,"unread":""}`) show `mark-read` advances while the record exists only in memory. | residual (below) |
| 4 | Same `seq` different content fails closed; malformed record for the `seq` does not block delivery | **PASS** | `SCENARIO5`: `{"conflictUnread":"<row>","conflictDelivered":0,"partialUnread":"","partialDelivered":1}`. Shipped takeover test (log line 55) passes. | none |
| 5 | Default (flag off) path unchanged | **PASS** | `SCENARIO3`: `{"msgs":1,"durable":0,"unread":""}` - one `fm-branch-merge` message, zero durable entries, cursor advanced. `deliverRoutineOutcome` sets `details: undefined` (`:1049-1058`), byte-identical to the old off path. | none |
| 6 | Non-streaming path no duplicate; no double-render (entry renderer + message renderer) | **PASS** | `SCENARIO4`: `{"entries":1,"msgs":0,"unread":"","rendered":true,"silentHidden":true}` - one entry across two reconciles, no message sent, entry renderer renders non-silent and hides silent. | none |

## Per-question findings

### 1. Synchronous persistence at the real call site
On the normal path `pi.appendEntry` -> `SessionManager.appendCustomEntry` -> `_appendEntry` -> `_persist` -> `appendFileSync` runs synchronously (`dist/core/session-manager.js:815-819`, `:794-812`; `dist/core/agent-session.js:2685`). `ensureRoutineOutcome` re-reads `getEntries()` and only then does the caller run `mark-read` (`fm-branch-supervision.ts:1083-1087`, `:1254-1259`). With no storage failure there is no re-delivery: `SCENARIO4` and the shipped streaming test confirm exactly one durable entry across a failed ack and a replay, and `pendingNextTurnMessages.length === 0` means the deferred queue is not used under the flag.

### 2. The window
Normal persistence: the shipped streaming test (`:6151`) runs delivery, a failed `mark-read`, replay, a queue flush, recovery, and a genuinely new main session with `mainStreaming` true, and passes. Independently, `SCENARIO4` (non-streaming) and the flag-off arm hold. The gap is only under storage failure (Q3).

### 3. Loss check (the important one)
`ensureRoutineOutcome`'s "verify persisted" step reads `currentMainSession.getEntries()`, which is Pi's in-memory `fileEntries`, not the session file. `_appendEntry` pushes into `fileEntries` before `_persist` (`session-manager.js:815-819`), and `_persist` can (a) throw after that push or (b) silently return without writing when `!flushed && !_hasConversation()` (`session-manager.js:794-800`). In both cases the record is visible to `getEntries()`.

- `SCENARIO1` (throwing `_persist`): first `turn_end` appends to memory, `_persist` throws, `ensureRoutineOutcome` catches and returns false, row stays unread, nothing on disk. The next `turn_end` finds the record in memory, returns true **without calling `appendEntry` again**, and `mark-read` advances. After simulating a process restart (in-memory gone, only disk survives) the durable count is 0 and `unread` is empty: the committed note is gone while the store says it was read.
- `SCENARIO2` (fresh session, no conversation): `session_start` reconcile on an empty session calls `appendEntry`; `_persist` silently no-writes (no user/assistant entry yet); `ensureRoutineOutcome` sees the in-memory record, returns true, and `mark-read` advances. Nothing is on disk. If the process exits before the first conversation message flushes the whole file, the note is lost.

So "mark-read now only crosses a durable delivery" holds only when `_persist` actually completes; the code verifies in-memory visibility, not durability.

### 4. Concurrency / takeover / conflict / partial ledger
In-process reconciles are serialized by `deliveryChain` (`fm-branch-supervision.ts:656-676`), and cross-process ownership is re-checked with `generationOwnsLock` before delivery and before `mark-read` (`:1233`, `:1259`). Same-`seq` different-content fails closed (`SCENARIO5`, `:1074-1076`); a malformed record for the `seq` is skipped and the note still delivers once (`SCENARIO5`). The shipped `...survives_replay_and_takeover` test passes. I did not stress-race two processes.

### 5. Flag-off path
`deliverRoutineOutcome` is the only remaining user of `sendMessage` for routine notes and always sends `details: undefined` (`:1049-1058`); `ensureRoutineOutcome` is gated by `durableDeliveryEnabled` (`:1254-1257`). `SCENARIO3` matches the old off-path shape exactly.

### 6. Non-streaming duplicate / double render
Under the flag the durable path never sends `fm-branch-merge`, so the message renderer cannot also fire; the entry renderer is the only path (`:2537`). `SCENARIO4` shows `entries:1, msgs:0`, renderer returns a value for non-silent and `undefined` for silent. No double render.

## New issue (residual, not the reported defect)

**`ensureRoutineOutcome` treats an in-memory-only record as durable.** The record is verified through `getEntries()` (Pi `fileEntries`) rather than through the session file, so any `_persist` failure or silent no-write still lets `mark-read` cross a delivery that is not on disk. This is the same structure as the pre-existing captain path (`ensureVisibleCaptainOutcome`, `:1019-1046`), so it is inherited, not introduced by `0b575e4b`; the reported streaming duplicate+loss is fixed.

Reachability: storage write failure (ENOSPC/EIO/EROFS) on the append, or a `session_start` reconcile on a fresh session with no conversation entry yet, followed by exit before the first conversation message.

Suggested follow-up (small): make `ensureRoutineOutcome` distinguish "delivered durably" from "pushed into the in-memory model" - e.g. re-read the session file / require `flushed`, un-poison the in-memory entry when `appendEntry` throws, or have the flag-on path not advance `mark-read` until a durable marker exists. The same hardening should be applied to the captain path.

Minor doc nit: the `parseRoutineDeliveryRecord` comment (`fm-branch-supervision.ts:545-549`) still says the record lives in the stored custom message's `details`; it now lives in a `custom` entry's `data`.

## What remains uncovered

- No live Pi TUI run. The harness is in-process and models Pi persistence from the bundled/`dist` source; it does not drive a real streaming main turn.
- Cross-process lock races around delivery vs `mark-read` were reasoned from `generationOwnsLock`, not stress-tested.
- Pi builds that lack `registerEntryRenderer` (the call is `?.`-guarded) would persist the note but render nothing.
- No cryptographic integrity on the record; corruption is rejected (fail closed) or re-delivered.

## Bottom line

The reported F09 streaming duplicate+loss is fixed: with normal persistence the delivery is recorded before the cursor advances, replay does not duplicate, the deferred queue is unused, the default path is unchanged, and conflicts fail closed. The remaining loss path requires a storage write failure or a fresh-session no-conversation window and is shared with the already-accepted captain path. Promote with the in-memory-verification hardening tracked as a follow-up.

ADVANCE
