#!/usr/bin/env bash
# check-docs-canary.sh — verifies Fumadocs' getGithubLastEdit succeeded during
# `next build`. Without this canary, a missing/expired GITHUB_TOKEN degrades
# silently: every page hits the unauthenticated GitHub API, gets rate-limited
# after ~60 calls, the catch in getLastUpdate swallows the error, and timestamps
# vanish from production with no operator signal (issue #2103).
#
# Runs as the last step of the docs Dockerfile builder stage (deploy/docs/Dockerfile).
# Expects to be executed from the docs build root (where `.next/server/app/` lives).
#
# Behavior:
#   - GITHUB_TOKEN unset → skip canary, print notice. Self-hosted operators
#     don't need the token; their unauthenticated builds will degrade silently
#     for the last-updated timestamp, which is the documented trade-off.
#   - GITHUB_TOKEN set → assert representative pages contain a <time> tag.
#     If not, fail loudly so Railway marks the deploy failed instead of
#     shipping a docs site without timestamps.

set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "[docs-canary] GITHUB_TOKEN unset — skipping last-updated canary"
  echo "[docs-canary] (self-hosted builds without a token will not show 'Last updated on …' timestamps)"
  exit 0
fi

# Pick a handful of stable, high-traffic pages. If Fumadocs ever changes its
# output structure these probes will need updating; that's intentional — the
# canary should fail visibly when its assumptions break.
PROBES=(
  ".next/server/app/index.html"
  ".next/server/app/guides/mcp.html"
  ".next/server/app/semantic-layer.html"
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
