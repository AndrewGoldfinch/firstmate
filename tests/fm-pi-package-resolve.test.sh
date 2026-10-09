#!/usr/bin/env bash
# Regression for tests/pi-package-helpers.sh: the shared Pi SDK resolver the
# live guards source must find the package from an explicit override or the
# managed install (not the npm global root alone), and must point the sibling
# dependencies at the nested layout of older releases or the release top level
# of hoisted newer releases. A host whose only SDK is a managed release is the
# case the live guard previously missed and skipped.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# shellcheck source=tests/pi-package-helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/pi-package-helpers.sh"

TMP_ROOT=$(fm_test_tmproot fm-pi-package-resolve)

# seed_managed_install <root> <version> <nested|hoisted> builds a fake managed
# `pi` install: the launcher on PATH, the current-version marker, and one
# release. `hoisted` puts the sibling dependencies beside the package at the
# release's top-level node_modules; `nested` puts them under the package.
seed_managed_install() {
  local root=$1 version=$2 layout=$3
  local release="$root/agent/install/releases/$version"
  local pkg="$release/node_modules/@earendil-works/pi-coding-agent"
  local depnm="$release/node_modules"
  [ "$layout" = nested ] && depnm="$pkg/node_modules"
  mkdir -p "$root/agent/bin" "$pkg" \
    "$depnm/@earendil-works/pi-tui" \
    "$depnm/@earendil-works/pi-ai" \
    "$depnm/typebox"
  printf '#!/bin/sh\nexit 0\n' > "$root/agent/bin/pi"
  chmod +x "$root/agent/bin/pi"
  printf '%s\n' "$version" > "$root/agent/install/current-version"
  printf '{"name":"@earendil-works/pi-coding-agent","version":"%s"}\n' "$version" > "$pkg/package.json"
}

# --- hoisted release layout: package found, deps linked from the top level ---
hoisted_root="$TMP_ROOT/hoisted"
seed_managed_install "$hoisted_root" 1.1.0 hoisted
hoisted_pkg="$hoisted_root/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent"
hoisted_nm="$hoisted_root/agent/install/releases/1.1.0/node_modules"

resolved=$(PATH="$hoisted_root/agent/bin:$PATH" fm_pi_package_dir)
[ "$resolved" = "$hoisted_pkg" ] \
  || fail "resolver did not find the managed install package: got '$resolved', expected '$hoisted_pkg'"
[ -f "$resolved/package.json" ] \
  || fail "resolved managed package has no package.json at '$resolved'"
deps=$(fm_pi_dep_node_modules "$resolved")
[ "$deps" = "$hoisted_nm" ] \
  || fail "hoisted layout linked deps from '$deps', expected '$hoisted_nm'"
for dep in "@earendil-works/pi-tui" "@earendil-works/pi-ai" typebox; do
  [ -d "$deps/$dep" ] || fail "hoisted layout is missing dep '$dep' under '$deps'"
done

# --- symlinked launcher: the agent root comes from the resolved target ------
linkbin="$hoisted_root/linkbin"
mkdir -p "$linkbin"
ln -s "$hoisted_root/agent/bin/pi" "$linkbin/pi"
resolved=$(PATH="$linkbin:$PATH" fm_pi_package_dir)
[ "$resolved" = "$hoisted_pkg" ] \
  || fail "resolver missed the managed install behind a symlinked launcher: got '$resolved', expected '$hoisted_pkg'"

# --- nested release layout: deps linked from inside the package --------------
nested_root="$TMP_ROOT/nested"
seed_managed_install "$nested_root" 1.0.4 nested
nested_pkg="$nested_root/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent"

resolved=$(PATH="$nested_root/agent/bin:$PATH" fm_pi_package_dir)
[ "$resolved" = "$nested_pkg" ] \
  || fail "resolver did not find the nested managed package: got '$resolved', expected '$nested_pkg'"
deps=$(fm_pi_dep_node_modules "$resolved")
[ "$deps" = "$nested_pkg/node_modules" ] \
  || fail "nested layout linked deps from '$deps', expected '$nested_pkg/node_modules'"
[ -d "$deps/@earendil-works/pi-ai" ] \
  || fail "nested layout is missing '@earendil-works/pi-ai' under '$deps'"

# --- explicit FM_PI_PACKAGE_DIR override wins unchanged ----------------------
override="$TMP_ROOT/explicit-package"
resolved=$(FM_PI_PACKAGE_DIR="$override" PATH="$nested_root/agent/bin:$PATH" fm_pi_package_dir)
[ "$resolved" = "$override" ] \
  || fail "FM_PI_PACKAGE_DIR override was ignored: got '$resolved', expected '$override'"

# --- no managed install: fall back to the npm global root --------------------
global_root="$TMP_ROOT/global-root"
mkdir -p "$global_root/agent/bin" "$global_root/fakebin" \
  "$global_root/global/@earendil-works/pi-coding-agent" \
  "$global_root/global/@earendil-works/pi-tui" \
  "$global_root/global/@earendil-works/pi-ai" \
  "$global_root/global/typebox"
printf '#!/bin/sh\nexit 0\n' > "$global_root/agent/bin/pi"
chmod +x "$global_root/agent/bin/pi"
cat > "$global_root/fakebin/npm" <<SH
#!/bin/sh
printf '%s\n' "$global_root/global"
SH
chmod +x "$global_root/fakebin/npm"
printf '{}\n' > "$global_root/global/@earendil-works/pi-coding-agent/package.json"

resolved=$(PATH="$global_root/agent/bin:$global_root/fakebin:$PATH" fm_pi_package_dir)
[ "$resolved" = "$global_root/global/@earendil-works/pi-coding-agent" ] \
  || fail "resolver did not fall back to the npm global root: got '$resolved'"
deps=$(fm_pi_dep_node_modules "$resolved")
[ "$deps" = "$global_root/global" ] \
  || fail "global layout linked deps from '$deps', expected '$global_root/global'"

# --- installed-but-unusable package: require_usable refuses loudly ------------
broken_root="$TMP_ROOT/broken"
mkdir -p "$broken_root/pkg"
printf '{}\n' > "$broken_root/pkg/package.json"
if out=$(fm_pi_require_usable "$broken_root/pkg" 2>&1); then
  fail "fm_pi_require_usable accepted a package with no sibling dependencies"
fi
case "$out" in
  *"missing sibling dependencies"*) ;;
  *) fail "fm_pi_require_usable did not name the missing dependencies: $out" ;;
esac
( fm_pi_require_usable "$resolved" ) \
  || fail "fm_pi_require_usable rejected the complete global layout"

pass "Pi SDK resolver finds the managed install or explicit override, links sibling deps from the nested or hoisted layout, and refuses an installed-but-unusable package"
