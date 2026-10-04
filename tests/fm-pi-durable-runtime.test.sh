#!/usr/bin/env bash
# Pi Durable sidecar (runtime/pi-durable): typecheck and acceptance tests.
#
# The P1A service, protocol, and single-owner store lock live in
# runtime/pi-durable with their own Node test suite. This wrapper runs that
# suite through the repository test runner so a change under runtime/pi-durable
# selects a real check instead of an unmapped source path.
set -euo pipefail

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PKG="$ROOT/runtime/pi-durable"

if [ ! -d "$PKG" ]; then
  echo "skip: runtime/pi-durable is not present"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "skip: Pi Durable runtime prerequisite not found: node"
  exit 0
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "skip: Pi Durable runtime prerequisite not found: npm"
  exit 0
fi

cd "$PKG"

if [ ! -d node_modules ]; then
  if ! npm ci --no-audit --no-fund >/dev/null 2>&1; then
    echo "skip: Pi Durable runtime dependencies unavailable (npm ci failed)"
    exit 0
  fi
fi

npm run --silent typecheck
npm test
