# Startup-replay under durable delivery — fixed contract

Follow-up to `docs/pi-durable/37-attended-pilot-rerun-review.md` ("What a fix must address", option 1).
Local-only change on `experiment/pi-durable-startup-replay-fix`; no new claim about the attended pilot, which remains stopped at the restart/startup-replay gate.

## Contract

`bin/fm-branch-outcome.sh startup-replay` runs at session start, prints the leading routine unread rows into the startup digest, then advances the read cursor.
Under durable delivery that printed digest is a tool result, not the rendered entry the cursor is documented to track, so the replay must not claim that presentation.

The replay now reads the same `FM_PI_DURABLE_DELIVERY` signal the Pi branch extension gates on at module load (`/^(1|true|yes)$/i`).
The value is fixed at session launch, so the decision does not race the extension's activation.

- **Durable delivery in use.** The replay still prints the leading non-silent routine rows into the digest, but advances the cursor only through the leading silent rows.
  Every non-silent leading routine row stays unread for the extension's `reconcileUnreadOutcomes` to render and mark read.
  A leading captain row still bars the whole replay set.
- **Durable delivery not in use** (no Pi extension, or the flag off). Behavior is unchanged: the digest itself is the presentation and the cursor advances through the whole leading routine run.

The frozen append mechanism and `runtime/pi-durable/src/` are untouched, and the default flag-off presentation path is unchanged.

## Verification

`tests/fm-branch-supervision.test.sh` gains `test_outcome_startup_replay_is_durable_delivery_aware`: a leading silent row and a leading non-silent routine row, with `FM_PI_DURABLE_DELIVERY=1`, leave the non-silent row unread and advance the cursor only through the silent row.
On the pre-fix code that assertion fails with `durable startup replay consumed a non-silent row`; it passes after the fix.
The companion non-durable half re-runs the same home without the flag and asserts the visible row is consumed, matching the existing startup-replay expectations.
