# Phase 1 live-session pilot

Status: implemented on `experiment/pi-durable-phase1-live-pilot` (base `d4ee2ad9b4e54d7088b497d08b1a1676bca8203d`).
The bounded Phase 1 pilot (`29`) and its verification (`30`, `31`) proved the option-2 durable delivery boundary with a synthetic SDK probe and no model.
This doc records the single live-session pilot that followed: the real `pi` binary, the real supervision extension, a real model turn, and real on-disk session and outcome state, all in a disposable `FM_HOME` under `$TMPDIR`.
Delivery stays opt-in through `FM_PI_DURABLE_DELIVERY`; the flag-off presentation path is unchanged and is exercised in the rollback lane.
The pilot does not start broader adoption, does not run a soak, and leaves the lock and delivery logic untouched.
The only tracked additions are the probe, its guard, this doc, and this doc's documentation-audience classification; `runtime/pi-durable/src/` and `bin/fm-branch-outcome.sh` are not modified.

## What is different from the bounded pilot

The bounded pilot drove the extension through synthetic lifecycle triggers (`session.bindExtensions`, an emitted `turn_end`) inside a bare Node worker, with no model and no terminal.
This pilot drives the genuinely live path instead:

- The real `pi` binary runs one real `--print` turn against a real model in a disposable agent dir whose `auth.json` is symlinked, never copied.
- `FM_PI_DURABLE_DELIVERY=1` is scoped to each spawned `pi` process; a separate flag-off process exercises the default path.
- State is the real store (`bin/fm-branch-outcome.sh`), the real session file, and the real marker and reservation files.
- Lock ownership is the real `state/.lock` ancestry walk: a wrapper shell writes its own pid to the lock and runs `pi` as its child, so the extension resolves ownership exactly as it does in a real firstmate home.
- The in-flight window is created by a `PATH` shim on `bash` that blocks the extension's real `mark-read` subprocess: the durable record and its committed marker are on disk while the read cursor is not advanced.
- A replaced live owner is a second, genuinely live `pi` process on the same destination, not a reduced model.

## Protocol

- Opt-in only: every delivered session sets `FM_PI_DURABLE_DELIVERY=1`; the rollback lane runs the flag-off session with `FM_PI_DURABLE_DELIVERY=0`.
- Isolated lab: every home, session file, lock, agent dir, and process lives under `$TMPDIR`, never the running home.
- Real components: the real `pi` binary, the real installed `@earendil-works/pi-coding-agent` version, the real `bin/fm-branch-outcome.sh` store, and the real extension loaded with `-e`.
- Unread rows are seeded through the real store append path, standing in for a branch `fm_branch_report`.
- One model and one network provider: the pilot submits a trivial prompt per session and spends real tokens, so its guard is `opt-in` and skipped unless `FM_PI_PHASE1_LIVE_SESSION=1` (or `FM_LIVE=1`).
- HOLD rule: any duplicate or loss on the pilot path fails the run and names the failing stage and raw state.

## Lab identity

| Property | Value |
| --- | --- |
| Checkout (branch head) | `d4ee2ad9b4e54d7088b497d08b1a1676bca8203d` |
| Pi version | `1.0.4` |
| `@earendil-works/pi-coding-agent` version | `1.0.4` |
| Extension SHA-256 | `cc9cac0c832acfc7cd565cd6bd978bac44e520e651ccc1f770191fe3bf024f09` |
| Probe SHA-256 | `0bba224a44b027c72afad05edc8f8187f83fbf2e68ff906422a3449ef435dc76` |
| Model | `opencode-go/muse-spark-1.3-contributor` |
| Node / platform | `v22.21.1` / `linux` |

## Starting state

The pilot home was freshly created with empty `state/`, `data/`, `config/`, and `sessions/`.

| Property | Value |
| --- | --- |
| Outcome store rows | 0 |
| Read cursor | 0 |
| Unread outcomes | 0 |
| Durable session records | 0 |

## Stage 1 - routine delivery

One unread routine row was appended, then a live `pi` owner ran one real turn with durable delivery on.

| Property | Value |
| --- | --- |
| Outcome store rows | 1 |
| Durable session records | 1 |
| Plain notes | 0 |
| Visible deliveries (per sequence) | 1 |
| Read cursor | 1 |
| Unread outcomes | 0 |
| Delivery markers | 0 |

The durable record carried a distinct delivery id and the marker ledger was cleared once the cursor advanced, so one source row produced exactly one visible delivery.

## Stage 2 - restart and resume

A second live `pi` session was opened on the same session file with no new unread row.
The acknowledged note was not re-delivered: the durable record count stayed at 1 and the cursor stayed at 1.

A third unread routine row was then appended while no owner ran, and a fresh live session was started.
That unread note was re-presented exactly once: durable records rose to 2, the cursor advanced to 2, and no unread row remained.

| Stage | Outcome rows | Durable records | Plain notes | Cursor | Unread |
| --- | --- | --- | --- | --- | --- |
| Restart, acknowledged note | 1 | 1 | 0 | 1 | 0 |
| Resume, unread note re-presented | 2 | 2 | 0 | 2 | 0 |

## Stage 3 - lock handover under option 2

A third unread row was appended and a live owner started with the in-flight pause armed.
The extension appended the durable record and committed its marker, then blocked on its real `mark-read` subprocess, leaving the record on disk with the cursor unadvanced.

| Mid-flight property | Value |
| --- | --- |
| Outcome store rows | 3 |
| Durable session records | 3 |
| Read cursor | 2 |
| Unread outcomes | 1 (sequence 3) |
| Delivery marker | committed for sequence 3 |

A second live owner then started on the same destination and replaced the first in `state/.lock`.
The successor adopted the record instead of appending a competing one: the durable record count stayed at 3, the cursor advanced to 3, and the unread row cleared.

The first owner was then released.
It finished its already-authorized delivery but appended nothing and did not advance the cursor again, so the final state held 3 durable records, cursor 3, and no unread row.

| Stage | Durable records | Plain notes | Cursor | Unread | Markers |
| --- | --- | --- | --- | --- | --- |
| In-flight owner paused | 3 | 0 | 2 | 1 | 1 committed |
| Successor adopts and completes | 3 | 0 | 3 | 0 | 0 |
| Replaced owner finishes | 3 | 0 | 3 | 0 | 0 |

The replaced owner's delivery id is the same identity the successor adopted (`15d7d6ff-ab51-4ecf-b2c9-5148c6c5ee6d`), so there is one home-wide delivery with no duplicate and no loss.

## Rollback

Rollback switches the presentation mode back to flag-off.
Because the flag-off path recognizes no durable record, a pending durable delivery must be reconciled - delivered and cursor-advanced - before the switch, or the flag-off path re-presents the still-unread row as a plain note and duplicates it.
The rule is therefore: reconcile every pending durable delivery first, then switch.

### Rollback exercise, reconciled

A fourth unread row was appended and a live durable owner was paused mid-delivery, leaving a pending durable delivery.

| State | Durable records | Cursor | Unread | Markers |
| --- | --- | --- | --- | --- |
| Pending, before switch | 4 | 3 | 1 | 1 committed |
| Reconciled, before switch | 4 | 4 | 0 | 0 |
| Flag-off session after switch | 4 | 4 | 0 | 0 |

The flag-off session added no plain note and changed nothing, so the switch neither lost nor duplicated the pending delivery.

### Rollback negative control, unreconciled

A separate disposable lane reproduced the hazard directly.
A durable owner was killed at the same in-flight window with no reconciliation, leaving one durable record, cursor 0, and one unread row.
A flag-off session then delivered the same row as a plain note: durable records 1, plain notes 1, cursor 1.

This intentional control proves the reconciliation step is load-bearing: skipping it produces the duplicate the HOLD rule forbids.

## Fidelity reached, and what was not driven

Reached: the real `pi` binary, the real extension, a real model turn, the real lock ancestry walk, real store and session files, a real restart and resume, a real option-2 adoption by a replaced live owner, and a real flag-off rollback, all in a disposable home with no duplicate and no loss on the pilot path.

Not driven:

- The session turns were non-interactive (`pi --print`) against a real model, not a human-attended TUI session.
- No watcher extension was loaded, so no wake dispatch ran and no branch model session spawned; unread rows were seeded through the real store rather than produced by a branch `fm_branch_report`.
- The in-flight pause point is the `mark-read` boundary, after the durable append and marker commit. The reserved-before-commit sub-state (a marker in `reserved` status with no committed record) was not reached live, though the bounded pilot (`29`) covers it.
- A full firstmate fleet with real workers, a real wake queue, and network checks was not run.

## Running the pilot

```sh
FM_PI_PHASE1_LIVE_SESSION=1 bin/fm-test-run.sh tests/fm-pi-phase1-live-session.test.sh
```

`FM_PI_PHASE1_LIVE_MODEL` overrides the model and `FM_PI_PHASE1_LIVE_AGENT_DIR` overrides the Pi agent dir whose `auth.json` is symlinked into the disposable lab.
