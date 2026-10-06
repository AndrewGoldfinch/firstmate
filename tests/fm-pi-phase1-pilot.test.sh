#!/usr/bin/env bash
# Opt-in Phase 1 pilot guard for the Pi durable-delivery extension. It drives
# the REAL @earendil-works/pi-coding-agent SDK, the REAL supervision extension,
# the real headless renderer, and the real outcome store through
# tests/assets/pi-phase1-probe.mjs, with no model and no network. The probe
# exercises the real session-lock ancestry walk (state/.lock names a live
# anchor process that each consumer descends from), so lock handover is
# observed through the extension's real ownership protocol rather than a
# reduced model.
#
# It validates the three approved Phase 1 gates: real lock handover with a
# delivery in flight (option 2), the normal session lifecycle with the flag-off
# default path byte-identical, and a bounded concurrent soak (fixed cycle
# count and a wall-clock cap) comparing durable home-wide records against
# externally visible deliveries. Any duplicate or loss fails the guard.
#
# FM_PHASE1_BASELINE_PLUGIN additionally compares the flag-off presentation body
# against the pre-Phase-1 extension when it loads. FM_PHASE1_OUTPUT retains the
# probe's JSON observations outside the temp lab.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fm_live_gate opt-in FM_PI_PHASE1_PILOT npm jq node

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PI_PACKAGE_DIR=${FM_PI_PACKAGE_DIR:-"$(npm root -g)/@earendil-works/pi-coding-agent"}
if [ ! -f "$PI_PACKAGE_DIR/package.json" ]; then
  fail "Pi package absent: the Phase 1 pilot needs @earendil-works/pi-coding-agent installed (FM_PI_PACKAGE_DIR to override)"
fi
PI_VERSION=$(jq -r '.version' "$PI_PACKAGE_DIR/package.json" 2>/dev/null || printf 'unknown')

TMP_ROOT=$(fm_test_tmproot fm-pi-phase1)
repo="$TMP_ROOT/repo"
mkdir -p "$repo/.pi/extensions/lib" "$repo/node_modules/@earendil-works"
cp "$ROOT/.pi/extensions/fm-branch-supervision.ts" "$repo/.pi/extensions/fm-branch-supervision.ts"
for lib in "$ROOT"/.pi/extensions/lib/*.ts; do
  cp "$lib" "$repo/.pi/extensions/lib/"
done
ln -s "$PI_PACKAGE_DIR" "$repo/node_modules/@earendil-works/pi-coding-agent"
ln -s "$PI_PACKAGE_DIR/node_modules/@earendil-works/pi-tui" "$repo/node_modules/@earendil-works/pi-tui"
ln -s "$PI_PACKAGE_DIR/node_modules/@earendil-works/pi-ai" "$repo/node_modules/@earendil-works/pi-ai"
ln -s "$PI_PACKAGE_DIR/node_modules/typebox" "$repo/node_modules/typebox"

baseline_plugin="$repo/.pi/extensions/fm-branch-supervision-baseline.ts"
if git -C "$ROOT" cat-file -e 1f3e7696:.pi/extensions/fm-branch-supervision.ts 2>/dev/null; then
  git -C "$ROOT" show 1f3e7696:.pi/extensions/fm-branch-supervision.ts > "$baseline_plugin"
else
  baseline_plugin=""
fi

FM_PHASE1_LAB="$TMP_ROOT/lab" \
  FM_PHASE1_PLUGIN="$repo/.pi/extensions/fm-branch-supervision.ts" \
  FM_PHASE1_BASELINE_PLUGIN="$baseline_plugin" \
  FM_PHASE1_ROOT="$ROOT" PI_PACKAGE_DIR="$PI_PACKAGE_DIR" \
  node "$ROOT/tests/assets/pi-phase1-probe.mjs" > "$TMP_ROOT/output" 2>&1
status=$?
cat "$TMP_ROOT/output"
[ "$status" -eq 0 ] || fail "Phase 1 pilot probe failed against Pi $PI_VERSION (see output above)"
grep -q 'PHASE1_PROBE_COMPLETE verdict=PASS' "$TMP_ROOT/output" \
  || fail "Phase 1 pilot probe did not report a passing verdict"

# Negative control: the flag-off body's byte-for-byte comparison against the
# pre-Phase-1 extension must actually fail the run. Mutating the baseline's
# rendered note body must produce a non-zero exit that names the mismatch; a
# passing verdict here means the gate is being swallowed again.
if [ -n "$baseline_plugin" ]; then
  mutated_baseline="$repo/.pi/extensions/fm-branch-supervision-baseline-mutated.ts"
  sed 's/const MERGE_NOTE_BOAT = "⛵";/const MERGE_NOTE_BOAT = "⛵MUTATED";/' "$baseline_plugin" > "$mutated_baseline"
  cmp -s "$baseline_plugin" "$mutated_baseline" \
    && fail "negative control could not mutate the pre-Phase-1 baseline body (expected MERGE_NOTE_BOAT in the baseline extension)"
  FM_PHASE1_LAB="$TMP_ROOT/lab-negative" \
    FM_PHASE1_PLUGIN="$repo/.pi/extensions/fm-branch-supervision.ts" \
    FM_PHASE1_BASELINE_PLUGIN="$mutated_baseline" \
    FM_PHASE1_ROOT="$ROOT" PI_PACKAGE_DIR="$PI_PACKAGE_DIR" \
    node "$ROOT/tests/assets/pi-phase1-probe.mjs" > "$TMP_ROOT/negative-output" 2>&1
  negative_status=$?
  if [ "$negative_status" -eq 0 ] || grep -q 'PHASE1_PROBE_COMPLETE verdict=PASS' "$TMP_ROOT/negative-output"; then
    cat "$TMP_ROOT/negative-output"
    fail "a mutated pre-Phase-1 baseline body did not fail the byte-for-byte gate (gate is not enforced)"
  fi
  grep -q 'byte-identical to the pre-Phase-1 baseline extension' "$TMP_ROOT/negative-output" \
    || fail "the mutated-baseline failure did not name the baseline byte mismatch"
fi

pass "real Pi SDK $PI_VERSION Phase 1 pilot holds real lock handover, the normal lifecycle, and a bounded concurrent soak with one home-wide delivery and no loss; the byte-for-byte baseline gate fails on a mutated baseline"
