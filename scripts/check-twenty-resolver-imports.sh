#!/bin/bash
# Verify that only `ee/src/saas-crm/` imports `resolveOperatorCredentials`
# (and its `tryResolveOperatorCredentials` companion) from the Twenty
# plugin. Everything else — plugin actions, webhook handlers, scheduled
# tasks, the eventual workspace-scoped outbox dispatcher — must use
# `resolveWorkspaceCredentials` so each install reads its OWN
# credentials from `twenty_integrations`, never the operator's env.
#
# Closes the Direction-1 leak in #2850 structurally: a customer plugin
# install can't accidentally route through Atlas's `TWENTY_API_KEY`
# because nothing outside `ee/src/saas-crm/` can import the operator
# resolver. The Direction-2 leak (Atlas's operator path consulting
# workspace credentials) is prevented by the absence of any cross-
# workspace getter in `packages/api/src/lib/integrations/twenty/store.ts`
# AND by the resolver split — `ee/src/saas-crm/index.ts` only imports
# the operator path.
#
# Match strategy mirrors `scripts/check-ee-imports.sh`: real import
# syntax only (`from "@useatlas/twenty"`, `import("@useatlas/twenty"`,
# `require("@useatlas/twenty"`), with `//` and `/* */` comments
# stripped before matching so historical references in docstrings
# don't false-positive.
#
# Allowed call sites:
#   - `ee/src/saas-crm/`           — the platform lead-capture pipeline
#   - `plugins/twenty/src/`        — the plugin defines and re-exports
#                                    these functions
#   - `plugins/twenty/__tests__/`  — exercises the operator path
#
# A regression in this script means a new caller is reaching for the
# operator resolver. Either migrate to `resolveWorkspaceCredentials`,
# or — if the new caller genuinely belongs to the platform path —
# extend the allowed list with explicit justification.

set -euo pipefail

ALLOWED_DIRS=(
  "ee/src/saas-crm/"
  "plugins/twenty/src/"
  "plugins/twenty/__tests__/"
)

# Match every name that resolves the operator-env path. The new
# canonical names (`resolveOperatorCredentials`,
# `tryResolveOperatorCredentials`) AND the legacy `@deprecated`
# aliases (`resolveCredentialsFromEnv`, `tryResolveCredentialsFromEnv`)
# are all confined to the allowed dirs. The aliases are referentially
# identical re-exports of the new functions; a caller reaching for
# either lands in the same env-only code path, so the leak prevention
# must cover both names. The closing `\b` keeps lookalikes like
# `resolveOperatorCredentialsFromCache` from triggering the check.
PATTERN='resolveOperatorCredentials\b|tryResolveOperatorCredentials\b|resolveCredentialsFromEnv\b|tryResolveCredentialsFromEnv\b'

# Strip comments before pattern-matching. Same three-step sed program
# as `check-ee-imports.sh` (see that file for the why):
#   1. same-line block comments
#   2. multi-line block comments
#   3. trailing `//` comments
STRIP_COMMENTS='sed -E "s#/\*([^*]|\*+[^*/])*\*+/##g; /\/\*/,/\*\// d; s#//.*\$##"'

# Search the full tree (excluding heavy dirs we never edit). Candidates
# are post-filtered through STRIP_COMMENTS so comment-only matches in
# docstrings (e.g. CHANGELOG-style "uses resolveOperatorCredentials")
# don't trip the gate.
# `create-atlas/templates/` is gitignored — `create-atlas/scripts/prepare-templates.sh`
# regenerates it on demand from the live monorepo sources, so any
# resolveOperatorCredentials there is a copy of the ee/saas-crm source,
# not a new caller. Excluding it avoids a false positive after a
# template-drift run.
CANDIDATES=$(grep -rln -E "$PATTERN" . \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.mts' \
  --include='*.cts' \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=dist \
  --exclude-dir=build \
  --exclude-dir=.turbo \
  --exclude-dir=.claude \
  --exclude-dir=.git \
  --exclude-dir=templates \
  || true)

OFFENDERS=""
if [ -n "$CANDIDATES" ]; then
  while IFS= read -r raw_path; do
    [ -z "$raw_path" ] && continue
    # Normalize the leading `./` so the allow-list match works.
    f="${raw_path#./}"
    # Allowed prefix?
    allowed=0
    for prefix in "${ALLOWED_DIRS[@]}"; do
      case "$f" in
        "$prefix"*) allowed=1; break ;;
      esac
    done
    [ "$allowed" -eq 1 ] && continue
    # Post-filter through STRIP_COMMENTS so comment matches don't count.
    if eval "$STRIP_COMMENTS \"\$f\"" | grep -qE "$PATTERN"; then
      OFFENDERS="${OFFENDERS}${f}"$'\n'
    fi
  done <<<"$CANDIDATES"
fi

OFFENDERS="${OFFENDERS%$'\n'}"

if [ -n "$OFFENDERS" ]; then
  COUNT=$(echo "$OFFENDERS" | wc -l | tr -d ' ')
  echo "::error::found $COUNT file(s) importing resolveOperatorCredentials outside ee/saas-crm — use resolveWorkspaceCredentials instead"
  echo ""
  echo "Allowed prefixes:"
  for prefix in "${ALLOWED_DIRS[@]}"; do
    echo "  $prefix"
  done
  echo ""
  echo "Unexpected importers:"
  echo "$OFFENDERS" | sed 's/^/  /'
  echo ""
  echo "Fix:"
  echo "  - If this is a per-workspace plugin action / webhook / scheduled task,"
  echo "    use resolveWorkspaceCredentials(workspaceId, { deployMode, lookup })"
  echo "    from @useatlas/twenty. The lookup adapter lives at"
  echo "    packages/api/src/lib/integrations/twenty/credentials.ts."
  echo ""
  echo "  - If this genuinely belongs to the platform lead-capture path,"
  echo "    document the carve-out in the PR description and add the file's"
  echo "    directory to ALLOWED_DIRS in $(basename "$0")."
  echo ""
  echo "See #2850 for the rationale."
  exit 1
fi

echo "Twenty resolver import check passed — operator-path resolvers are confined to ee/saas-crm + the plugin."
