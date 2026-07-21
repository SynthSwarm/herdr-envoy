#!/usr/bin/env bash
# Local dev sync: build the plugin and copy the compiled dist into opencode's
# global plugins dir (mirrors how the published npm package loads). opencode
# does NOT follow symlinks in the plugins dir, so we COPY. The bridge file
# (herdr-envoy.ts) wraps dist/index.js.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/.config/opencode/plugins/herdr-envoy-dist"

# build
( cd "$HERE" && bunx tsc -p tsconfig.json )

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$HERE/dist/." "$DEST/"
echo "synced (built) $HERE/dist -> $DEST"
