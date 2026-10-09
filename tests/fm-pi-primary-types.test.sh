#!/usr/bin/env bash
# Strict no-emit contract check for the tracked Firstmate Pi extensions.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=tests/pi-package-helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/pi-package-helpers.sh"

PI_PACKAGE_DIR=$(fm_pi_package_dir)
if [ ! -f "$PI_PACKAGE_DIR/package.json" ]; then
  echo "skip: Pi extension typecheck prerequisite not found: installed @earendil-works/pi-coding-agent package"
  exit 0
fi
fm_pi_require_usable "$PI_PACKAGE_DIR"
FM_PI_DEP_NODE_MODULES=$(fm_pi_dep_node_modules "$PI_PACKAGE_DIR")

TSC=$(command -v tsc 2>/dev/null || true)
if [ -z "$TSC" ] && [ -x "$FM_PI_DEP_NODE_MODULES/.bin/tsc" ]; then
  TSC="$FM_PI_DEP_NODE_MODULES/.bin/tsc"
fi
if [ -z "$TSC" ] && [ -x "$ROOT/runtime/pi-durable/node_modules/.bin/tsc" ]; then
  TSC="$ROOT/runtime/pi-durable/node_modules/.bin/tsc"
fi
if [ -z "$TSC" ]; then
  echo "skip: Pi extension typecheck prerequisite not found: tsc"
  exit 0
fi

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-pi-primary-types.XXXXXX")
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$TMP_ROOT/lib" "$TMP_ROOT/node_modules/@earendil-works" "$TMP_ROOT/node_modules/@types"
cp "$ROOT/.pi/extensions/fm-branch-supervision.ts" "$TMP_ROOT/fm-branch-supervision.ts"
cp "$ROOT/.pi/extensions/fm-calm.ts" "$TMP_ROOT/fm-calm.ts"
cp "$ROOT/.pi/extensions/fm-primary-pi-watch.ts" "$TMP_ROOT/fm-primary-pi-watch.ts"
cp "$ROOT/.pi/extensions/fm-primary-turnend-guard.ts" "$TMP_ROOT/fm-primary-turnend-guard.ts"
cp "$ROOT/.pi/extensions/lib/fm-branch-dispatch.ts" "$TMP_ROOT/lib/fm-branch-dispatch.ts"
cp "$ROOT/.pi/extensions/lib/fm-native-contract.ts" "$TMP_ROOT/lib/fm-native-contract.ts"
cp "$ROOT/.pi/extensions/lib/fm-async-exec.ts" "$TMP_ROOT/lib/fm-async-exec.ts"
cp "$ROOT/.pi/extensions/lib/fm-branch-model-picker.ts" "$TMP_ROOT/lib/fm-branch-model-picker.ts"
cp "$ROOT/.pi/extensions/lib/fm-calm-assistant-layout.ts" "$TMP_ROOT/lib/fm-calm-assistant-layout.ts"
cp "$ROOT/.pi/extensions/lib/fm-calm-preservation.ts" "$TMP_ROOT/lib/fm-calm-preservation.ts"
cp "$ROOT/.pi/extensions/lib/fm-calm-operational-user-layout.ts" "$TMP_ROOT/lib/fm-calm-operational-user-layout.ts"
cp "$ROOT/.pi/extensions/lib/fm-calm-pending-operational-layout.ts" "$TMP_ROOT/lib/fm-calm-pending-operational-layout.ts"
cp "$ROOT/.pi/extensions/lib/fm-calm-visibility.ts" "$TMP_ROOT/lib/fm-calm-visibility.ts"
cp "$ROOT/.pi/extensions/lib/fm-calm-working-ship.ts" "$TMP_ROOT/lib/fm-calm-working-ship.ts"
cp "$ROOT/.pi/extensions/lib/fm-calm-working-ship-sprite.ts" "$TMP_ROOT/lib/fm-calm-working-ship-sprite.ts"
cp "$ROOT/.pi/extensions/lib/fm-operational-input.ts" "$TMP_ROOT/lib/fm-operational-input.ts"
cp "$ROOT/.pi/extensions/lib/fm-execution-provider.ts" "$TMP_ROOT/lib/fm-execution-provider.ts"
ln -s "$PI_PACKAGE_DIR" "$TMP_ROOT/node_modules/@earendil-works/pi-coding-agent"
ln -s "$FM_PI_DEP_NODE_MODULES/@earendil-works/pi-tui" "$TMP_ROOT/node_modules/@earendil-works/pi-tui"
ln -s "$FM_PI_DEP_NODE_MODULES/@earendil-works/pi-ai" "$TMP_ROOT/node_modules/@earendil-works/pi-ai"
ln -s "$FM_PI_DEP_NODE_MODULES/typebox" "$TMP_ROOT/node_modules/typebox"
ln -s "$FM_PI_DEP_NODE_MODULES/@types/node" "$TMP_ROOT/node_modules/@types/node"

cat > "$TMP_ROOT/package.json" <<'JSON'
{"type":"module"}
JSON
cat > "$TMP_ROOT/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2022",
    "types": ["node"]
  },
  "include": ["*.ts", "lib/*.ts"]
}
JSON

"$TSC" -p "$TMP_ROOT/tsconfig.json" || exit 1
version=$(jq -r '.version' "$PI_PACKAGE_DIR/package.json" 2>/dev/null || printf 'unknown')
printf 'ok - tracked Pi extensions pass strict no-emit typecheck against Pi %s\n' "$version"
