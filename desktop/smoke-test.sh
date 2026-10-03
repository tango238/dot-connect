#!/usr/bin/env bash
# コンパイル済みサイドカーの単体スモークテスト:
#   起動 → LISTENING 行 → /api/models → /api/capabilities → 静的 index.html → TODO 作成
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=desktop/src-tauri/binaries/dot-connect-server-aarch64-apple-darwin
[[ -x "$BIN" ]] || { echo "run build-sidecars.sh first"; exit 1; }

TMP=$(mktemp -d)
trap 'kill $PID 2>/dev/null || true; rm -rf "$TMP"' EXIT
PORT=45757

# DOT_CONNECT_DESKTOP=1 is intentionally omitted here: it makes the server
# watch stdin for EOF and self-exit (see src/desktopLifecycle.ts), which is
# meant to detect the Tauri shell going away. Backgrounded under a
# non-interactive shell (as this script, CI, etc. do), stdin is inherited
# already-closed, so the server would exit right after printing LISTENING —
# confirmed empirically: with the flag set, the process was gone within 1s
# and curl got "Connection refused"; without it, it stayed up and answered.
DB_PATH="$TMP/smoke.db" STATIC_DIR="$PWD/public" PORT=$PORT \
  "$BIN" > "$TMP/out.log" 2>&1 &
PID=$!

for _ in $(seq 1 50); do
  grep -q "LISTENING $PORT" "$TMP/out.log" && break
  sleep 0.2
done
grep -q "LISTENING $PORT" "$TMP/out.log" || { echo "FAIL: no LISTENING line"; cat "$TMP/out.log"; exit 1; }

BASE="http://127.0.0.1:$PORT"
curl -sf "$BASE/api/models" | grep -q '"success":true' || { echo "FAIL: /api/models"; exit 1; }
curl -sf "$BASE/api/capabilities" | grep -q '"dispatch"' || { echo "FAIL: /api/capabilities"; exit 1; }
curl -sf "$BASE/index.html" | grep -qi '<html' || { echo "FAIL: static index.html"; exit 1; }
curl -sf -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"title":"smoke"}' "$BASE/api/todos" | grep -q '"success":true' || { echo "FAIL: POST /api/todos"; exit 1; }
echo "smoke test: OK"
