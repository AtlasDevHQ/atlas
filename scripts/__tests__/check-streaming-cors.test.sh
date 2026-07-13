#!/bin/bash
# Adversarial fixture suite for scripts/check-streaming-cors.sh.
#
# Locks in that the guard (a) FAILS when a file calls
# createUIMessageStreamResponse() without referencing corsResponseHeaders,
# (b) PASSES when the CORS spread is present, and (c) does NOT false-positive on
# a comment that merely mentions the name in prose (the guard keys on the call
# syntax `createUIMessageStreamResponse(`, not the bare identifier).
#
# Each fixture runs against a throwaway tree via STREAMING_CORS_ROOT so the real
# codebase is never touched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-streaming-cors.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# run_fixture <label> <expect: pass|fail> <file-contents>
run_fixture() {
  local label="$1" expect="$2" contents="$3"
  local tmp
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/api/routes"
  printf '%s\n' "$contents" > "$tmp/api/routes/fixture.ts"

  local rc=0
  STREAMING_CORS_ROOT="$tmp" bash "$SCRIPT" >/dev/null 2>&1 || rc=$?
  rm -rf "$tmp"

  if [ "$expect" = "pass" ] && [ "$rc" -eq 0 ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  elif [ "$expect" = "fail" ] && [ "$rc" -eq 1 ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  else
    echo "  ✗ $label — expected $expect, got exit $rc"; FAIL=$((FAIL + 1))
  fi
}

echo "check-streaming-cors adversarial fixtures:"

# (a) A raw streaming response with no CORS → must FAIL.
run_fixture "call without corsResponseHeaders fails" fail \
'return createUIMessageStreamResponse({ stream, headers: { "Cache-Control": "no-cache" } });'

# (b) The call WITH the CORS spread → must PASS.
run_fixture "call with corsResponseHeaders passes" pass \
'import { corsResponseHeaders } from "@atlas/api/lib/cors";
return createUIMessageStreamResponse({ stream, headers: { ...corsResponseHeaders(o) } });'

# (c) A comment merely naming the constructor (no call syntax) → must PASS.
run_fixture "prose mention (no call) does not false-positive" pass \
'// createUIMessageStreamResponse returns a raw Response — see cors.ts.
return c.json({ ok: true });'

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
