#!/usr/bin/env bash
# tests/pi-package-helpers.sh - shared Pi SDK package resolution for the guards.
#
# Sourced by every test that loads the real @earendil-works/pi-coding-agent
# package, so each one resolves the SDK and its sibling dependencies from the
# same place instead of re-rolling the lookup.
#
# The SDK ships in two layouts. Older installs nest their dependencies under the
# package (pi-coding-agent/node_modules/...). Newer releases hoist them to the
# release's top-level node_modules, next to the package
# (<release>/node_modules/@earendil-works/pi-ai, .../typebox, ...). The two
# functions below handle either layout.

# fm_pi_package_dir echoes the @earendil-works/pi-coding-agent package root to
# load, in this order:
#   1. FM_PI_PACKAGE_DIR, when set (explicit override, used exactly as given)
#   2. the managed `pi` install's current release, discovered the same way the
#      launcher finds it (install/current-version then install/releases/<version>)
#   3. the npm global root
fm_pi_package_dir() {
  local managed_dir pi_bin pi_agent_dir pi_version
  if [ -n "${FM_PI_PACKAGE_DIR:-}" ]; then
    printf '%s\n' "$FM_PI_PACKAGE_DIR"
    return 0
  fi
  pi_bin=$(command -v pi 2>/dev/null || true)
  if [ -n "$pi_bin" ]; then
    # command -v may return a symlink (e.g. ~/bin/pi -> ~/.pi/agent/bin/pi);
    # resolve it so the agent root is derived from the real launcher.
    pi_bin=$(readlink -f "$pi_bin" 2>/dev/null || printf '%s\n' "$pi_bin")
    pi_agent_dir=$(cd "$(dirname "$pi_bin")/.." 2>/dev/null && pwd || true)
    if [ -n "$pi_agent_dir" ]; then
      pi_version=$(cat "$pi_agent_dir/install/current-version" 2>/dev/null || true)
      managed_dir="$pi_agent_dir/install/releases/$pi_version/node_modules/@earendil-works/pi-coding-agent"
      if [ -n "$pi_version" ] && [ -f "$managed_dir/package.json" ]; then
        printf '%s\n' "$managed_dir"
        return 0
      fi
    fi
  fi
  printf '%s\n' "$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent"
}

# fm_pi_dep_node_modules <package_dir> echoes the node_modules directory holding
# the SDK's sibling dependencies (@earendil-works/pi-tui, pi-ai, typebox, and
# @types/node). A nested <package_dir>/node_modules wins when it carries the
# dependencies; otherwise they are hoisted to the layout's top level, one
# directory above the @earendil-works scope.
fm_pi_dep_node_modules() {
  local package_dir=$1 nested="$1/node_modules"
  if [ -d "$nested/@earendil-works/pi-ai" ]; then
    printf '%s\n' "$nested"
  else
    printf '%s\n' "$(dirname "$(dirname "$package_dir")")"
  fi
}
