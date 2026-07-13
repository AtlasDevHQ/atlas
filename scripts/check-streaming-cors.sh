#!/bin/bash
# Guard: every streaming agent response attaches CORS headers.
#
# The Vercel AI SDK's `createUIMessageStreamResponse()` returns a RAW `Response`
# object. Hono's CORS middleware queues its headers via `c.header()` and only
# merges them onto responses built through `c.json()`/`c.body()`/`c.text()` — a
# raw returned (or `throw new HTTPException(200, { res })`-thrown) Response
# bypasses that merge entirely. So a cross-origin streaming POST arrives WITHOUT
# `Access-Control-Allow-Origin` and the browser blocks it even though the OPTIONS
# preflight (handled by the middleware) succeeded.
#
# The fix each streaming endpoint must apply is to spread
# `corsResponseHeaders(c.req.header("Origin") ?? "")` into the response headers
# (see `packages/api/src/lib/cors.ts`). `chat.ts` and `demo.ts` do; the
# semantic-improve `/chat` endpoint forgot, which broke the improve chat in prod
# (#2037 was the original fix; this guard stops a fourth endpoint reintroducing
# it).
#
# Rule: any file that CALLS `createUIMessageStreamResponse(` must also reference
# `corsResponseHeaders` (the import + the spread). A file that only mentions the
# name in prose (comments) does not match — we key on the call syntax
# `createUIMessageStreamResponse(`, not the bare identifier.
#
# A regression here means a new streaming endpoint returned a raw Response
# without CORS. Add `...corsResponseHeaders(c.req.header("Origin") ?? "")` to its
# response headers.

set -euo pipefail

# Root is overridable so the adversarial fixture suite can point the same logic
# at a throwaway tree (scripts/__tests__/check-streaming-cors.test.sh).
SEARCH_ROOT="${STREAMING_CORS_ROOT:-packages/api/src}"
CALL_PATTERN='createUIMessageStreamResponse[[:space:]]*\('

# Files that actually CALL the streaming-response constructor (not just import or
# mention it). `grep -l` on the call syntax; excludes test files — the guard is
# about production endpoints (tests may construct responses for assertions).
mapfile -t offenders < <(
  grep -rlE "$CALL_PATTERN" "$SEARCH_ROOT" --include='*.ts' 2>/dev/null \
    | grep -vE '(__tests__/|\.test\.ts$)' \
    | while read -r f; do
        if ! grep -q 'corsResponseHeaders' "$f"; then echo "$f"; fi
      done
)

if [ "${#offenders[@]}" -gt 0 ]; then
  echo "❌ Streaming CORS guard: these files call createUIMessageStreamResponse() but never reference corsResponseHeaders:"
  for f in "${offenders[@]}"; do echo "   - $f"; done
  echo
  echo "A raw streaming Response bypasses the CORS middleware. Add the CORS spread to its headers:"
  echo '    return createUIMessageStreamResponse({'
  echo '      stream,'
  echo '      headers: { ...corsResponseHeaders(c.req.header("Origin") ?? "") },'
  echo '    });'
  echo "See packages/api/src/lib/cors.ts and packages/api/src/api/routes/chat.ts."
  exit 1
fi

echo "✅ Streaming CORS guard: all createUIMessageStreamResponse() call sites attach corsResponseHeaders."
