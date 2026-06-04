#!/bin/bash
# #3159 — guard against reintroducing the Better Auth **admin plugin**.
#
# The admin plugin authorized the caller by the RAW `user.role` column (via
# `hasPermission({ role: session.user.role, ... })`), NOT Atlas's merged
# `effectiveRole`. After #2890 reduced it to a single platform-only role the
# footgun was contained but live: any NEW admin-plugin route reachable by a
# workspace admin would silently break the same way removeUser / revokeSessions
# / SCIM did. #3159 removed the plugin entirely — its consumers are now direct
# internal-DB ops (`lib/auth/admin-user-ops.ts`), ban enforcement is reproduced
# via the `session.create.before` hook + a per-request check in `managed.ts`,
# and `role`/`banned`/`banReason`/`banExpires` survive as `user.additionalFields`.
#
# This is the STATIC half of the reintroduction guard; the runtime half is the
# "admin plugin removal (#3159)" test in lib/auth/__tests__/server.test.ts which
# asserts buildPlugins() contains no plugin with id "admin". A regression here
# means the raw-`user.role` authorization seam is being re-opened — reconsider.
#
# Mirrors the comment-stripping discipline of check-ee-imports.sh so a comment
# that mentions the old symbols (this file's own history, ADRs) never trips it.

set -euo pipefail

API_DIR="packages/api/src"
WEB_DIR="packages/web/src"

for d in "$API_DIR" "$WEB_DIR"; do
  if [ ! -d "$d" ]; then
    echo "::error::source directory not found at $d" >&2
    exit 2
  fi
done

# Strip block comments (same-line then multi-line range) and trailing line
# comments before matching, so historical references in docstrings don't
# false-positive. Identical program to check-ee-imports.sh.
STRIP_COMMENTS='sed -E "s#/\*([^*]|\*+[^*/])*\*+/##g; /\/\*/,/\*\// d; s#//.*\$##"'

OFFENDERS=""

# Helper: append "file: reason" for every non-test, non-mock file under $1
# whose comment-stripped text matches the ERE in $2.
scan() {
  local dir="$1" pattern="$2" reason="$3"
  local candidates
  candidates=$(grep -rlE "$pattern" "$dir" \
    --include='*.ts' --include='*.tsx' \
    --exclude='*.test.ts' --exclude='*.test.tsx' \
    --exclude-dir=__mocks__ --exclude-dir=__tests__ --exclude-dir=__test-utils__ \
    || true)
  [ -z "$candidates" ] && return 0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if eval "$STRIP_COMMENTS \"\$f\"" | grep -qE "$pattern"; then
      OFFENDERS="${OFFENDERS}${f}  — ${reason}"$'\n'
    fi
  done <<<"$candidates"
}

# 1. The server admin plugin: `admin` imported from "better-auth/plugins".
#    Match the named import on the import line (the import is single-line in
#    Atlas). `[{,]\s*admin\s*[,}]` keeps `customSession`/`adminClient` clear.
scan "$API_DIR" 'from "better-auth/plugins".*[{,][[:space:]]*admin[[:space:]]*[,}]' \
  'imports the admin() plugin from "better-auth/plugins"'
scan "$API_DIR" '[{,][[:space:]]*admin[[:space:]]*[,}].*from "better-auth/plugins"' \
  'imports the admin() plugin from "better-auth/plugins"'

# 2. The client mirror: `adminClient` from "better-auth/client/plugins".
scan "$WEB_DIR" 'adminClient' 'reintroduces the adminClient() Better Auth client plugin'

# 3. The deleted getAdminApi() bridge.
scan "$API_DIR" 'getAdminApi' 'reintroduces the getAdminApi() admin-plugin bridge'

# 4. The deleted admin-permissions.ts ACL mirrors.
if [ -f "$API_DIR/lib/auth/admin-permissions.ts" ]; then
  OFFENDERS="${OFFENDERS}${API_DIR}/lib/auth/admin-permissions.ts  — admin-plugin ACL mirror was deleted in #3159"$'\n'
fi
if [ -f "$WEB_DIR/lib/auth/admin-permissions.ts" ]; then
  OFFENDERS="${OFFENDERS}${WEB_DIR}/lib/auth/admin-permissions.ts  — admin-plugin ACL mirror was deleted in #3159"$'\n'
fi

OFFENDERS=$(echo "${OFFENDERS%$'\n'}" | grep -v '^$' || true)

if [ -n "$OFFENDERS" ]; then
  echo "::error::the Better Auth admin plugin is being reintroduced — this re-opens the raw user.role authorization footgun retired in #3159."
  echo ""
  echo "Offenders:"
  echo "$OFFENDERS" | sed 's/^/  /'
  echo ""
  echo "User-management ops live in packages/api/src/lib/auth/admin-user-ops.ts"
  echo "(platform_admin-gated at the route layer). Ban enforcement is the"
  echo "session.create.before hook in server.ts + the per-request check in"
  echo "managed.ts. See issue #3159 and ADR/architecture-wins for the rationale."
  exit 1
fi

echo "admin-plugin check passed — the Better Auth admin plugin is not present."
