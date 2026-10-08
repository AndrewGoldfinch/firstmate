# Per-home durable delivery mode — authoritative marker fix

Follow-up to `docs/pi-durable/45-adoption-seq2.md` (`seq 2` loss, HOLD - IMPLEMENTATION).
Local-only change on `experiment/pi-durable-durable-mode-persist`; no push, PR, or merge.

## Contract

Durable delivery was selected only by the process environment variable `FM_PI_DURABLE_DELIVERY`, so a flagless `bin/fm-branch-outcome.sh startup-replay` in a durable home silently consumed leading non-silent routine rows (the `seq 2` path).

The selection is now a per-home on-disk marker, `state/.pi-durable-delivery`, and the marker is authoritative for both consumers:

- `.pi/extensions/fm-branch-supervision.ts` enables durable delivery when the marker exists, regardless of the environment variable.
- `bin/fm-branch-outcome.sh` (`durable_delivery_in_use`, used by `startup-replay`) takes the durable path when the marker exists, regardless of the environment variable.

The environment variable still enables durable delivery in a home that was never marked, and a home with neither keeps the flag-off path exactly.
A flagless or conflicting caller (for example `FM_PI_DURABLE_DELIVERY=0`) therefore cannot downgrade a marked home.
The marker is fixed at process/module load, like the environment variable, so a running session keeps the mode it started with.

`bin/fm-branch-outcome.sh durable-mode enable|disable|status` owns the marker.
`disable` reconciles before switching: it refuses while any outcome row is unread, so the home cannot move to the flag-off presentation with a delivery pending.
`enable` is idempotent, and `status` reports the effective selection.

The frozen append mechanism and `runtime/pi-durable/src/` are untouched, and the default flag-off presentation path is unchanged.

## Isolated regression (failing first)

`tests/fm-branch-supervision.test.sh` gains `test_outcome_durable_mode_marker_is_authoritative_and_reconciled`.
It marks a home durable, appends a leading non-silent routine row, and asserts that a flagless `startup-replay` leaves that row unread with no cursor advance.
It then asserts a conflicting flag cannot downgrade the home, that `durable-mode disable` refuses while the row is unread, and that after the row is settled the same command clears the marker and restores the flag-off path.

On the pre-fix code the test fails at the first assertion with `flagless startup replay consumed a non-silent row in a durable home`; it passes after the fix.

`tests/fm-pi-branch-extension.test.sh` extends `test_f09_durable_delivery_identity_makes_routine_notes_exactly_once` with a `marker` arm: the same committed routine row and injected cursor-write failure, but durable delivery selected from the home marker alone with no environment flag.
The existing arm expects two copies on the flag-off path and one under durable delivery; the marker arm expects one, so it fails if the extension ignores the marker.

## Adoption home test

The captain-authorized home `/home/andy/pi-durable-adoption` was updated only after the isolated regression passed.
Its checkout was at `15cbe64a`, and both `bin/fm-branch-outcome.sh` and `.pi/extensions/fm-branch-supervision.ts` there were byte-identical to the fix's base `7993171e`, so the two fixed files were copied in exactly and committed on a local branch in that home.
`durable-mode enable` wrote `state/.pi-durable-delivery`, and `durable-mode status` reported `enabled`.

Before the test the home read `cursor == tail == 4`, `unread` empty, and no durable marker.
A new routine row (seq 5, `Durable mode persist probe five`, `silent:false`) was appended while the owner was down, leaving `cursor 4` and `unread == [5]`.
The primary was then relaunched flagless, with no `FM_PI_DURABLE_DELIVERY` in the process environment (lock pid `3950210`).

Observed on that flagless launch:

- The session-start digest (a captured `custom_message` entry, session `2026-10-08T21-54-24-102Z_01a11d82-a6e5-7583-917a-1be9fc679208.jsonl`) contains `BRANCH OUTCOMES` with `seq 5`, so `startup-replay` still printed the row.
- The cursor was not advanced by `startup-replay`: it stayed `4` through the digest, which is the durable contract the marker now enforces without the environment flag.
- The extension delivered the row: the same session file holds a `custom` / `fm-branch-visible-routine` entry for `seq 5` with `deliveryId 192123b9-29b6-4095-a13c-fa4aeb2baf68`, and the cursor moved `4 -> 5`.
- The cursor advance is attributed to the extension, not to a flag-off replay: `state/.pi-branch-extension-loaded` recorded the new owner pid `3950210`, and the pane rendered the note as `⛵ adoption-observe:`.
- The marker remained present and the home stayed enabled.

One narrow turn was required to complete the delivery: on this launch the extension's session-start reconcile did not advance the cursor, and the row was delivered by the first turn's reconcile after ownership was established.
That is consistent with the ownership check requiring an already-acquired session lock; it is recorded here as an observed startup ordering, not a new guarantee.

The historical record is unchanged: `seq 2` stays a loss, and the successful delivery count for the original four rows stays **2 of 4** (`seq 1`, `seq 4`).
The flagless seq 5 delivery is a separate confirmation of the fix.

## Validation

- `bin/fm-test-run.sh tests/fm-branch-supervision.test.sh` — pass, including the new regression.
- `bin/fm-test-run.sh tests/fm-pi-branch-extension.test.sh` — pass, including the `marker` arm.
- `(cd runtime/pi-durable && npm ci && npm test)` — 81 of 81 pass.
- `bin/fm-lint.sh` — pass (ShellCheck 0.11.0, actionlint).
- `FM_PI_BRANCH_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh` — could not run in this environment: this host has no globally installed `@earendil-works/pi-coding-agent` with the nested dependency layout the opt-in live guard requires, so it fails with `Pi package absent`.
  The same failure occurs with this change stashed, so it is an environment limitation, not a regression, and this change does not touch the live path.
