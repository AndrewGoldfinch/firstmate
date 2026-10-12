#!/usr/bin/env bash
set -eu
E=/home/andy/.no-mistakes/evidence/01M4Q6BV9JKKSKJF62CYG2CT5K
LAB="$PWD/.l"
bin/fm-lab-home.sh create "$LAB"
mkdir -p "$LAB/t"
touch "$LAB/config/supervision-host"
printf '999999\n' > "$LAB/state/.lock"
cleanup(){ TMUX_TMPDIR="$LAB/t" tmux -L fm-lab kill-server 2>/dev/null || true; rm -rf "$LAB"; }
trap cleanup EXIT
env -u NO_MISTAKES_GATE -u FM_GATE_REFUSE_BYPASS -u FM_ROOT_OVERRIDE -u FM_STATE_OVERRIDE -u FM_DATA_OVERRIDE -u FM_CONFIG_OVERRIDE -u FM_PROJECTS_OVERRIDE TMUX_TMPDIR="$LAB/t" tmux -L fm-lab new-session -d -s primary -x 120 -y 40 -c "$PWD" -e FM_HOME="$LAB" "bash -c '(sleep 12; bin/fm-lock.sh > \"\$FM_HOME/reclaim.log\" 2>&1) & exec pi --no-session --no-extensions --no-skills --no-mcp --no-context-files -e .pi/extensions/fm-primary-pi-watch.ts'"
sleep 3
TMUX_TMPDIR="$LAB/t" tmux -L fm-lab send-keys -t primary Down Down Enter
sleep 4
{ echo 'BEFORE RECLAIM'; cat "$LAB/state/.lock"; ls -a "$LAB/state"; TMUX_TMPDIR="$LAB/t" tmux -L fm-lab capture-pane -p -t primary; } > "$E/pi-before-reclaim.txt"
sleep 20
{ echo 'AFTER RECLAIM'; cat "$LAB/reclaim.log"; cat "$LAB/state/.lock"; ls -a "$LAB/state"; test ! -f "$LAB/state/.watch.lock" || cat "$LAB/state/.watch.lock"; TMUX_TMPDIR="$LAB/t" tmux -L fm-lab capture-pane -p -t primary; } > "$E/pi-after-reclaim.txt"
cat "$E/pi-after-reclaim.txt"
