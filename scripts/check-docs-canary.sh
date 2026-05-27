#!/usr/bin/env bash
# check-docs-canary.sh — guards two silent-degradation modes in the docs build:
#
# 1. Fumadocs' getGithubLastEdit needs GITHUB_TOKEN. Without it every page hits
#    the unauthenticated GitHub API, gets rate-limited after ~60 calls, the
#    catch in getLastUpdate swallows the error, and 'Last updated on …'
#    timestamps vanish in production with no operator signal (issue #2103).
#
# 2. The static Orama search index at out/api/search is serialized by fumadocs
#    at build time. A regressed content loader can produce a valid but ~empty
#    JSON, the build succeeds, the 24 MB client download succeeds, and search
#    silently returns zero results — caught here by a minimum-size check.
#
# Runs as the last step of the docs Dockerfile builder stage (deploy/docs/Dockerfile).
# Expects to be executed from the docs build root (where `out/` lives — the
# static export produced by `next build` with output: 'export').

set -euo pipefail

# Search index size check — runs regardless of GITHUB_TOKEN. A real index is
# multi-MB; pick a threshold well above an empty/initial DB shape (a few KB).
SEARCH_INDEX="out/api/search"
MIN_SEARCH_INDEX_BYTES=100000
if [ ! -f "$SEARCH_INDEX" ]; then
  echo "[docs-canary] FAIL: $SEARCH_INDEX missing — static Orama export did not run."
  exit 1
fi
actual_size=$(wc -c < "$SEARCH_INDEX")
if [ "$actual_size" -lt "$MIN_SEARCH_INDEX_BYTES" ]; then
  echo "[docs-canary] FAIL: $SEARCH_INDEX is ${actual_size} bytes (< ${MIN_SEARCH_INDEX_BYTES})."
  echo "[docs-canary] Likely cause: source loader returned an empty page set — search will return zero results."
  exit 1
fi
echo "[docs-canary] PASS: search index is ${actual_size} bytes"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "[docs-canary] GITHUB_TOKEN unset — skipping last-updated canary"
  echo "[docs-canary] (self-hosted builds without a token will not show 'Last updated on …' timestamps)"
  exit 0
fi

# Pick a handful of stable, high-traffic pages. If Fumadocs ever changes its
# output structure these probes will need updating; that's intentional — the
# canary should fail visibly when its assumptions break.
PROBES=(
  "out/index.html"
  "out/guides/mcp/index.html"
  "out/semantic-layer/index.html"
)

missing_files=()
no_time_tag=()

for probe in "${PROBES[@]}"; do
  if [ ! -f "$probe" ]; then
    missing_files+=("$probe")
    continue
  fi
  # Fumadocs renders the timestamp as <p>Last updated on {date}</p>
  # (apps/docs/node_modules/fumadocs-ui/dist/layouts/docs/page/index.js:PageLastUpdate).
  # If lastUpdate prop is undefined the <p> never renders, so this string is
  # the canonical signal that getGithubLastEdit returned a Date.
  if ! grep -q "Last updated on" "$probe"; then
    no_time_tag+=("$probe")
  fi
done

if [ "${#missing_files[@]}" -gt 0 ]; then
  echo "[docs-canary] FAIL: prerender output missing expected files:"
  printf '  %s\n' "${missing_files[@]}"
  echo "[docs-canary] Fumadocs output structure may have changed — update PROBES in scripts/check-docs-canary.sh."
  exit 1
fi

if [ "${#no_time_tag[@]}" -gt 0 ]; then
  echo "[docs-canary] FAIL: GITHUB_TOKEN is set but these prerendered pages have no 'Last updated on' line:"
  printf '  %s\n' "${no_time_tag[@]}"
  echo
  echo "[docs-canary] Likely causes:"
  echo "  1. Token is expired or revoked — rotate at https://github.com/settings/personal-access-tokens"
  echo "  2. Token is missing 'Contents: Read-only' permission on AtlasDevHQ/atlas"
  echo "  3. GitHub API outage — re-run the deploy in a few minutes"
  exit 1
fi

echo "[docs-canary] PASS: ${#PROBES[@]} probed pages have last-updated timestamps"
