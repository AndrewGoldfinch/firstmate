#!/usr/bin/env bash
# Opt-in Phase 1 LIVE-SESSION pilot guard. Unlike the no-model bounded pilot
# (fm-pi-phase1-pilot.test.sh), this guard drives the genuinely live product
# path: a real `pi` process, the real supervision extension, a real model turn,
# and real on-disk session/outcome state, in a disposable FM_HOME under $TMPDIR.
# `FM_PI_DURABLE_DELIVERY=1` is scoped to each spawned `pi` process.
#
# It checks routine delivery, restart/resume (an acknowledged note is not
# re-delivered; an unread note is re-presented once), and an option-2 lock
# handover (a live owner paused mid-delivery is replaced by a live successor
# that adopts the record), then exercises the rollback contract that a pending
# durable delivery must be reconciled before switching to flag-off. A separate
# lane demonstrates the hazard of switching without reconciling. Any duplicate
# or loss on the pilot path fails the guard.
#
# It spends model tokens, so it is opt-in: set FM_PI_PHASE1_LIVE_SESSION=1 (or
# FM_LIVE=1) to run it. FM_PI_PHASE1_LIVE_MODEL overrides the model, and
# FM_PI_PHASE1_LIVE_AGENT_DIR overrides the Pi agent dir whose auth.json is
# symlinked (never copied) into the disposable lab.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fm_live_gate opt-in FM_PI_PHASE1_LIVE_SESSION pi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PI_PACKAGE_DIR=${FM_PI_PACKAGE_DIR:-"$(npm root -g)/@earendil-works/pi-coding-agent"}
if [ ! -f "$PI_PACKAGE_DIR/package.json" ]; then
  fail "Pi package absent: the live-session pilot needs @earendil-works/pi-coding-agent installed (FM_PI_PACKAGE_DIR to override)"
fi
PI_VERSION=$(jq -r '.version' "$PI_PACKAGE_DIR/package.json" 2>/dev/null || printf 'unknown')
AGENT_DIR=${FM_PI_PHASE1_LIVE_AGENT_DIR:-"$HOME/.pi/agent"}
[ -f "$AGENT_DIR/auth.json" ] || fail "Pi auth store absent at $AGENT_DIR/auth.json (FM_PI_PHASE1_LIVE_AGENT_DIR to override)"

TMP_ROOT=$(fm_test_tmproot fm-pi-phase1-live)
FM_LIVE_LAB="$TMP_ROOT/lab" \
  FM_LIVE_ROOT="$ROOT" \
  FM_LIVE_OUTPUT="$TMP_ROOT/report.json" \
  FM_LIVE_MODEL="${FM_PI_PHASE1_LIVE_MODEL:-opencode-go/muse-spark-1.3-contributor}" \
  FM_LIVE_AGENT_DIR="$AGENT_DIR" \
  PI_PACKAGE_DIR="$PI_PACKAGE_DIR" \
  node "$ROOT/tests/assets/pi-phase1-live-session.mjs" > "$TMP_ROOT/output" 2>&1
status=$?
cat "$TMP_ROOT/output"
[ "$status" -eq 0 ] || fail "Phase 1 live-session pilot failed against Pi $PI_VERSION (see output above)"
grep -q 'PHASE1_LIVE_SESSION_COMPLETE verdict=PASS' "$TMP_ROOT/output" \
  || fail "Phase 1 live-session pilot did not report a passing verdict"

pass "real Pi SDK $PI_VERSION Phase 1 live session holds routine delivery, restart/resume, and an option-2 lock handover with exactly one durable delivery and no loss; the rollback reconciles a pending durable delivery before flag-off, and the unreconciled negative control reproduces the duplicate"
