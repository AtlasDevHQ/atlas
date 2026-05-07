#!/usr/bin/env bash
# Drive the hosted MCP load tests end-to-end against any Atlas region.
#
# Flow:
#   1. Read LOADTEST_ADMIN_EMAIL + LOADTEST_ADMIN_PASSWORD from .env (or env).
#   2. POST /api/auth/sign-in/email — Better Auth issues a session token via
#      the `bearer()` plugin (returned as `token` in the JSON body).
#   3. POST /api/v1/me/load-test/mcp-token with that session as Bearer —
#      the self-mint endpoint (#2135 follow-up) reads the session's
#      activeOrganizationId and returns a short-lived MCP-scoped JWT
#      bound to the caller's own workspace. Workspace-member gated; no
#      cross-tenant capability.
#   4. Run k6 against the chosen scenario, writing summary.json into
#      eval/load-tests/mcp/results/.
#
# Bearer never enters argv, never lands in stdout. The session token from
# step 2 stays in shell variables; the mint bearer is piped through an env
# var into k6 and discarded after the run.
#
# Usage:
#   ./loadtest.sh concurrent-sessions [-- <extra k6 args>]
#   ./loadtest.sh tool-call-mix
#   ./loadtest.sh cold-start
#
# Required:
#   LOADTEST_ADMIN_EMAIL, LOADTEST_ADMIN_PASSWORD (sourced from .env or env).
#   The user must be a workspace member with an active workspace set on the
#   session (any role — `member` is enough).
#
# Optional:
#   BASE_URL              — defaults to https://mcp.useatlas.dev (the brand
#                           hostname for the customer-facing MCP surface).
#                           Override with the regional API host (e.g.
#                           https://mcp-eu.useatlas.dev) for non-default
#                           regions, or http://localhost:3001 for local dev.
#   TTL_SECONDS           — bearer TTL, default 1800 (covers 5-min stages × multi-stage runs)
#   STAGES, STAGE_SECONDS, RAMP_SECONDS, VUS, DURATION, TARGET_RPS, TOOL — forwarded to k6 per scenario
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"

# ── Load .env if present, but don't clobber pre-set env vars ───────
# Source from the repo root .env. The trailing `|| true` guards against
# .env being absent in CI / Docker contexts where creds come from the
# environment directly.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

BASE_URL="${BASE_URL:-https://mcp.useatlas.dev}"
TTL_SECONDS="${TTL_SECONDS:-1800}"

# ── Validate args + creds up-front so the script fails fast ──────────
if [ "$#" -lt 1 ]; then
  echo "usage: $0 <concurrent-sessions|tool-call-mix|cold-start> [-- <extra k6 args>]" >&2
  exit 64
fi

SCENARIO="$1"; shift
case "$SCENARIO" in
  concurrent-sessions|tool-call-mix|cold-start) ;;
  *)
    echo "error: unknown scenario '$SCENARIO'. Known: concurrent-sessions, tool-call-mix, cold-start" >&2
    exit 64
    ;;
esac

# Allow callers to pass extra k6 flags after `--`.
K6_EXTRA=()
if [ "${1:-}" = "--" ]; then
  shift
  K6_EXTRA=("$@")
fi

if [ -z "${LOADTEST_ADMIN_EMAIL:-}" ] || [ -z "${LOADTEST_ADMIN_PASSWORD:-}" ]; then
  echo "error: LOADTEST_ADMIN_EMAIL and LOADTEST_ADMIN_PASSWORD must be set (in .env or environment)" >&2
  exit 64
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "error: k6 not on PATH. Install via 'brew install k6' or follow README.md." >&2
  exit 127
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not on PATH. Required for parsing auth + mint responses." >&2
  exit 127
fi

mkdir -p "$RESULTS_DIR"

# ── Step 1: sign in ──────────────────────────────────────────────────
# Better Auth's bearer() plugin returns the session token in the body
# as `token`. We extract via jq rather than scraping headers — the
# `set-auth-token` response header is exposed by CORS but a JSON pull
# is portable across curl versions and avoids header-case quirks.
echo ":: signing in as $LOADTEST_ADMIN_EMAIL against $BASE_URL"
SIGNIN_BODY=$(jq -n \
  --arg email "$LOADTEST_ADMIN_EMAIL" \
  --arg password "$LOADTEST_ADMIN_PASSWORD" \
  '{email: $email, password: $password}')

SIGNIN_RESPONSE=$(curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -d "$SIGNIN_BODY" \
  "$BASE_URL/api/auth/sign-in/email")

SESSION_TOKEN=$(printf '%s' "$SIGNIN_RESPONSE" | jq -r '.token // empty')
if [ -z "$SESSION_TOKEN" ]; then
  echo "error: sign-in succeeded but response carried no token. Check that the admin user exists and has a password set." >&2
  exit 1
fi

# ── Step 2: mint MCP bearer ──────────────────────────────────────────
# The /me endpoint reads the session's activeOrganizationId — there is
# no body workspaceId. Region binding is implicit in the BASE_URL we
# called (the audience is the regional /mcp URL).
echo ":: minting MCP-scoped bearer (ttl=${TTL_SECONDS}s)"
MINT_BODY=$(jq -n --arg ttl "$TTL_SECONDS" '{ttlSeconds: ($ttl | tonumber)}')

MINT_RESPONSE=$(curl -fsS -X POST \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$MINT_BODY" \
  "$BASE_URL/api/v1/me/load-test/mcp-token")

WORKSPACE_ID=$(printf '%s' "$MINT_RESPONSE" | jq -r '.workspaceId // empty')
BEARER_JWT=$(printf '%s' "$MINT_RESPONSE" | jq -r '.bearer // empty')
EXPIRES_AT=$(printf '%s' "$MINT_RESPONSE" | jq -r '.expiresAt // empty')

if [ -z "$WORKSPACE_ID" ] || [ -z "$BEARER_JWT" ]; then
  # Surface the API's structured error verbatim (it carries `requestId`
  # for forensic correlation). Echoing a 400/403 body is fine — the
  # response shape never includes credentials.
  echo "error: mint endpoint did not return a bearer:" >&2
  printf '%s\n' "$MINT_RESPONSE" >&2
  exit 1
fi

echo ":: bearer minted for workspace $WORKSPACE_ID — expires $EXPIRES_AT"

# ── Step 3: run k6 ───────────────────────────────────────────────────
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUMMARY_PATH="$RESULTS_DIR/${SCENARIO}-${TIMESTAMP}.json"
SUMMARY_TXT="$RESULTS_DIR/${SCENARIO}-${TIMESTAMP}.txt"

echo ":: running k6 scenario '$SCENARIO' → $SUMMARY_PATH"

# `--summary-export` writes the post-run aggregate (counts, rates,
# percentiles) to a single JSON file — far smaller than `--out json=...`
# (which streams every metric sample) and the right shape for trend
# tracking across runs. Streaming output goes to <name>.txt so a
# failure leaves a tail-able log next to the summary.
#
# `BEARER` and `WORKSPACE_ID` are passed to k6 via -e, which sets them
# in the script env without ever appearing in argv after k6's own
# argv-rewrite. The values stay in this process's env until the
# subprocess exits.
BEARER="$BEARER_JWT" \
WORKSPACE_ID="$WORKSPACE_ID" \
k6 run \
  -e "BASE_URL=$BASE_URL" \
  -e "WORKSPACE_ID=$WORKSPACE_ID" \
  -e "BEARER=$BEARER_JWT" \
  --summary-export="$SUMMARY_PATH" \
  "${K6_EXTRA[@]}" \
  "$SCRIPT_DIR/${SCENARIO}.js" \
  | tee "$SUMMARY_TXT"

# Drop the bearer from this shell's env right after the subprocess
# returns so a `set` / `env` invocation post-run can't surface it.
unset BEARER BEARER_JWT SESSION_TOKEN

echo ":: done. results at:"
echo "   summary: $SUMMARY_PATH"
echo "   stdout:  $SUMMARY_TXT"
