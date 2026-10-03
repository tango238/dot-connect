#!/usr/bin/env bash
# bun build --compile で 2 サイドカーを Tauri の target-triple 命名で出力する。
# 使い方: ./build-sidecars.sh [bun-target...]  (省略時はホストの darwin-arm64)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=desktop/src-tauri/binaries
mkdir -p "$OUT"

# bun の --target 名 → Rust target triple の対応
triple_for() {
  case "$1" in
    bun-darwin-arm64) echo aarch64-apple-darwin ;;
    bun-darwin-x64) echo x86_64-apple-darwin ;;
    bun-windows-x64) echo x86_64-pc-windows-msvc ;;
    *) echo "unknown bun target: $1" >&2; exit 1 ;;
  esac
}

TARGETS=("${@:-bun-darwin-arm64}")
for t in "${TARGETS[@]}"; do
  triple=$(triple_for "$t")
  ext=""
  [[ "$t" == bun-windows-* ]] && ext=".exe"
  bun build --compile --target="$t" src/server.ts --outfile "$OUT/dot-connect-server-$triple$ext"
  bun build --compile --target="$t" src/mcp/server.ts --outfile "$OUT/dot-connect-mcp-$triple$ext"
done
echo "built: $(ls "$OUT")"
