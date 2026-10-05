# Independent verification: durable delivery identity for routine notes

- Commit under test: `3d8cf6c4` ("feat(pi-durable): durable delivery identity for routine notes"), checked out detached from `origin`.
- Task: `pi-durable-delivery-verify` (scout; deliverable is this report).
- Verdict: **HOLD - IMPLEMENTATION**.
- Environment: Linux, node v22.21.1, bash 5.x. Unix domain sockets bind/listen/connect: **OK** (verified with a `socket.AF_UNIX` bind+connect round trip).
- Shipped suite: `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` -> `FM_TEST_SUMMARY total=1 failed=0 ... duration_ms=63370`, `EXIT=0`; all 55 `ok -` lines including both new tests (`...:6302`/`:6303`).

## Bottom line

The opt-in path is correct for a **non-streaming** delivery, and the default path is behaviourally unchanged. But on the **real** path, when a routine reconcile runs while main's turn is still streaming — which includes every `turn_end` reconcile — `pi.sendMessage(..., {deliverAs: "nextTurn"})` only queues the custom message in Pi's in-memory `_pendingNextTurnMessages`; the `custom_message` session entry is not written until the next prompt flushes the queue. `ensureRoutineOutcome` searches the session entries, cannot see the not-yet-persisted record, and delivers a second copy on the next reconcile. A crash after a successful mark-read but before the flush loses the note. The new test fixture persists synchronously for every `sendMessage`, so it cannot observe this and its "exactly once" proof does not cover the streaming half of the documented F09 window.

This is a defect in the new mechanism (the analogue captain path persists synchronously via `pi.appendEntry`), not merely a pre-existing limitation: the mechanism advances the mark-read cursor while the delivery it claims to have recorded is still only in memory.

## Challenge table

| # | Challenge | Result | Evidence | Gate impact |
|---|-----------|--------|----------|-------------|
| 1 | Default path unchanged when flag off | PASS | `default` harness: parent keys `[customType,content,display]`; new-off keys `[customType,content,display,details]` with `details === undefined`; identical `content`/`display`; 0 durable entries; cursor advances. Real Pi reads `message.details` -> `undefined` either way, so the stored entry is byte-identical. | no blocker |
| 2 | Delivery -> crash; ack persistence fails; replay | **FAIL (streaming)** | `sync` = 1 copy; `defer` = 2 copies; `newsession` = 2 copies across a new main session. See "New issue". | blocks promotion |
| 3 | Concurrent consumers / two reconciles racing | PASS (serialized) | `enqueueDelivery` chain (`fm-branch-supervision.ts:649-676`) serializes; cross-process gated by `generationOwnsLock` before delivery and before mark-read (`:1200`,`:1231`). Not independently stress-race-tested. | none |
| 4 | New-owner takeover / ack-owner change | PASS / PARTIAL | Record search is generation-agnostic but delivery and mark-read re-check the fleet lock, so a superseded owner cannot deliver into a live generation. Shipped `...survives_replay_and_takeover` passes. **But** the test's "takeover" reuses the same `mainSessionManager`; a genuinely new main session loses the record -> re-delivery (`newsession`). | scope caveat |
| 5 | Partial ledger recovery | PASS | `partial` harness: malformed `details` for the row's seq is skipped, the note is delivered once, no drop, cursor advances. | none |
| 6 | Conflict: same seq, different content | PASS (fail closed) | `conflict` harness: 0 delivered, row stays unread. However the failure aborts the whole reconcile and sets `branchBroken` (`:1231-1233`,`:1871`), a head-of-line block until session replacement. | none (design note) |
| 7 | Loss: can the path drop a delivery? | **FAIL (streaming)** | `loss` harness: after a successful ack while every copy is still queued (`persisted=0`, `queuedInMemoryOnly=1`), a crash before flush loses the note while the store claims it was read. Pre-existing for the flag-off path too, but unaddressed by the "durable" claim. | blocks promotion |
| 8 | Chain-of-custody / hash integrity | ABSENT | `parseRoutineDeliveryRecord` (`:1048-1052`) checks `version === 1` + row shape; no hash/MAC. Corruption is either rejected (fail closed) or re-delivered. Acceptable at this trust boundary; note it. | none |

## New issue (reproduced)

Real Pi, `@earendil-works/pi-coding-agent` `dist/bundle/chunks/chunk-33XOIQ5N.js`:

```
async sendCustomMessage(message,options){
  let appMessage={role:"custom",customType:message.customType,content:message.content??[],
                  display:message.display,details:message.details,timestamp:Date.now()};
  if(options?.deliverAs==="nextTurn")this._pendingNextTurnMessages.push(appMessage);
  ...
  else this._appendCustomMessage(appMessage)
}
```

`_pendingNextTurnMessages` is only drained/persisted when the next prompt runs (`_pendingNextTurnMessages=[]` at prompt preparation; the custom entry is appended on that message's `message_end`). Pi emits `turn_end` before `agent_end`, and the extension sets `mainStreaming = true` on `agent_start` (`:1780`) and `false` only on `agent_end`/`agent_settled` (`:1837`,`:1846`). So the `turn_end` reconcile (`:1864-1870`) always runs with `mainStreaming === true`, and the branch-wake reconcile can too.

Extension flow:
- `deliverRoutineOutcome` (`:1040-1049`): `if (mainStreaming) pi.sendMessage(message, { deliverAs: "nextTurn" })` -> queued in memory only, yet returns as if delivered.
- `ensureRoutineOutcome` (`:1055-1065`): searches `currentMainSession.getEntries()`; the queued message is absent -> falls through and calls `deliverRoutineOutcome` again.
- Reconcile loop (`:1229-1237`): after `ensureRoutineOutcome` returns true it runs `mark-read`, advancing the cursor.

Runnable harness (`.verify-scratch/adv.sh` + `.verify-scratch/driver.mjs` in the scratch worktree): same shipped fixture, but `sendMessage` models Pi's timing (`deliverAs:"nextTurn"` queues; `flush()` persists). `FM_PI_DURABLE_DELIVERY=1` in all arms.

```
=== sync (shipped fixture semantics: persist on send) ===
first-reconcile  copies=1 persisted=1 unread=true
second-reconcile copies=1 persisted=1 unread=false
after-flush      copies=1 persisted=1

=== defer (real Pi nextTurn semantics) ===
first-reconcile  copies=1 persisted=0 unread=true
second-reconcile copies=2 persisted=0 unread=false     <- DUPLICATE
after-flush      copies=2 persisted=2

=== loss ===
loss after-ack copies=1 persisted=0 unread=""
loss queuedInMemoryOnly=1 -> a crash here loses the note while the store says it was read

=== newsession (genuinely new main session) ===
before-new-session copies=1 unread=true
after-new-session  copies=2 freshEntries=1              <- DUPLICATE across sessions

=== conflict ===     conflict copies=0 unreadStillHasRow=true
=== partial ===      partial copies=1 unreadHasRow=false
=== default ===      default message keys=["customType","content","display","details"] detailsType=undefined
                     default persistedEntries=0 unread=""
```

The shipped fixture (`tests/fm-pi-branch-extension.test.sh:594-604`) unconditionally pushes a `custom_message` entry for any send that carries `details`, regardless of `deliverAs`, so both new tests exercise only the non-streaming ordering and pass.

## Uncovered / real-Pi limitations

- The harness is in-process and models Pi's persistence timing from its bundled source; it does not drive a live Pi TUI. A live-Pi reproduction (streaming main turn + branch routine report + injected mark-read failure) is the next confirmation step.
- The `newsession` re-delivery across `/new` is arguably intended (the note never appeared in the new session) but it is not one of "exactly once across replay/restart/takeover" as stated, and the shipped takeover test does not model a real new session file.
- No cryptographic integrity on the delivery record; no chain-of-custody.
- Cross-process lock contention around delivery was reasoned from `generationOwnsLock`, not stress-tested.

## Recommendation

Do not promote as-is. Make the routine delivery record durable **before** its cursor advances, mirroring the captain path: either persist the record directly (`pi.appendEntry(ROUTINE_DELIVERY_ENTRY_TYPE, record)` / a synchronous session append) instead of relying on Pi's deferred `custom_message` write, or have `ensureRoutineOutcome` return false when it only queued a not-yet-persisted message so `mark-read` never crosses an in-memory delivery. Then extend the fixture to model `deliverAs:"nextTurn"` deferral and re-run the F09 arm with `mainStreaming` true.

The default path (flag off) is unchanged and safe; the opt-in path is the only affected surface.

HOLD - IMPLEMENTATION
