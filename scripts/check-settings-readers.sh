#!/bin/bash
# Verify that every key in the settings registry
# (packages/api/src/lib/settings.ts) has at least one NON-TEST runtime
# reader — catching drift class 1 from the #3374 deploy-mode parity audit:
# a setting that is admin-visible (and writable) in the UI but consumed by
# nothing at runtime. Parity contract Rule 1 (#3380): every admin-writable
# value names its runtime reader.
#
# Matching rules (a key passes if ANY rule matches; all matching runs
# against comment-stripped, non-test source — see SCOPE/EXCLUSIONS below):
#
#   R1 — direct literal read:
#          getSetting("KEY") / getSettingAuto("KEY") / getSettingLive("KEY")
#          / getSettingOverride("KEY") (the DB-override-only tier, #3705 —
#          used by boot-consumed resolvers that take an injected env and
#          layer the override over it, e.g. the OAuth token-TTL resolvers).
#   R2 — const-indirected read: a const is bound to the key literal
#          (`const FOO_SETTING = "KEY"`) and that const is passed to
#          getSetting/getSettingAuto/getSettingLive. This is the
#          house pattern for keys whose name is also surfaced in error
#          copy (email-tool.ts, scim-provenance.ts, mcp prompts/gating.ts).
#   R3 — env-mirror read, PLATFORM-SCOPED KEYS ONLY:
#          `process.env.ENVVAR` / `process.env["ENVVAR"]` (reads only —
#          assignments don't count). Platform-scoped keys are legitimately
#          consumed at boot via env before/instead of the settings tier
#          chain (ATLAS_DEPLOY_MODE in config.ts, ATLAS_LOG_LEVEL in
#          logger.ts, DATABASE_URL in db/internal.ts, the provider API
#          keys in providers.ts/cli init). For WORKSPACE-scoped keys an
#          env-only reader is NOT accepted: getSetting's tier chain
#          already falls through to env, so an env-only read means the
#          per-workspace DB override the admin UI writes is runtime-inert
#          — exactly the drift this script exists to catch. Workspace
#          keys in that state go on the ALLOWLIST with a justification
#          and a tracking note, never silently pass.
#
# SCOPE: packages/*/src, ee/src, plugins/*/src. apps/ (www, docs) and
# examples/ are intentionally out of scope — a docs-site or example
# mention is not a runtime reader.
#
# EXCLUSIONS:
#   - test code: *.test.ts(x), __tests__/, __mocks__/, __test-utils__/,
#     testing/, test-setup.ts
#   - packages/api/src/lib/settings.ts itself (the registry + tier-chain
#     implementation reads every key by definition)
#   - packages/api/src/api/routes/admin.ts — the generic admin settings
#     GET/PUT/DELETE routes live there. Today they pass keys as variables
#     (getSettingDefinition(key), setSetting(key, …)) so the literal
#     matcher can't count them anyway; the file-level exclusion makes the
#     issue-#3382 rule structural: a hardcoded display-only echo added to
#     the generic routes must never satisfy the reader requirement. If a
#     REAL reader ever lands in admin.ts, this check fails noisily — move
#     the read into lib/ (CLAUDE.md: lib/ must not import from api/routes/,
#     and routes should delegate to lib helpers), don't widen this scope.
#
# Limits (conservative by design — failures are noisy, never silent):
#   - line-based matching: a reader call split so the key literal is on a
#     different line than `getSetting(` won't match. Prettier keeps them
#     together in practice; if you hit this, keep the key on the call line.
#   - R2 resolves const names textually across the whole evidence set, not
#     via the module graph.
#   - per-key reader PRESENCE only: one compliant reader satisfies a key, so
#     a second non-compliant reader of an already-compliant key (e.g. an
#     env-frozen module-level read alongside a getSetting reader, #3400) is
#     invisible to this check.
#   - reader presence, not org threading: a workspace-scoped key whose
#     readers call getSetting without the call site's orgId (skipping the
#     workspace tier, #3406) passes this check. Org threading is review
#     discipline — see parity Rule 1 in docs/development/enterprise-gating.md.

set -euo pipefail

SETTINGS_FILE="packages/api/src/lib/settings.ts"
GENERIC_SETTINGS_ROUTES_FILE="packages/api/src/api/routes/admin.ts"

# ---------------------------------------------------------------------------
# Allowlist — keys intentionally exempt from the reader requirement.
# EVERY entry needs a justification comment saying WHY (parity contract
# Rule 1). Do not add a key here just to make CI green: name the reader
# or remove the setting.
# ---------------------------------------------------------------------------
ALLOWLIST=(
  # (empty — the four Semantic Expert keys were removed by #3392 when their
  # readers moved to getSetting; new entries need a justification comment.)
)

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "::error::settings registry not found at $SETTINGS_FILE" >&2
  echo "::error::if the file moved, update SETTINGS_FILE in $(basename "$0")." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 1. Parse the registry into KEY|ENVVAR|SCOPE triples.
# `key` is always the first field of each entry, so it delimits records.
# ---------------------------------------------------------------------------
REGISTRY=$(awk '
  /^const SETTINGS_REGISTRY/ { inreg = 1; next }
  inreg && /^\];/            { inreg = 0 }
  !inreg                     { next }
  /^[[:space:]]*key: "/    { if (k != "") print k "|" e "|" s
                             match($0, /"[^"]+"/); k = substr($0, RSTART+1, RLENGTH-2); e = ""; s = "" }
  /^[[:space:]]*envVar: "/ { match($0, /"[^"]+"/); e = substr($0, RSTART+1, RLENGTH-2) }
  /^[[:space:]]*scope: "/  { match($0, /"[^"]+"/); s = substr($0, RSTART+1, RLENGTH-2) }
  END                      { if (k != "") print k "|" e "|" s }
' "$SETTINGS_FILE")

KEY_COUNT=$(echo "$REGISTRY" | grep -c . || true)
if [ "$KEY_COUNT" -lt 10 ]; then
  echo "::error::registry parse extracted only $KEY_COUNT key(s) from $SETTINGS_FILE — the SETTINGS_REGISTRY shape probably changed. Update the awk program in $(basename "$0")." >&2
  exit 2
fi
while IFS='|' read -r key envvar scope; do
  if [ -z "$envvar" ] || [ -z "$scope" ]; then
    echo "::error::registry entry '$key' parsed without envVar/scope — the SETTINGS_REGISTRY shape probably changed. Update the awk program in $(basename "$0")." >&2
    exit 2
  fi
done <<<"$REGISTRY"

# ---------------------------------------------------------------------------
# 2. Build the comment-stripped evidence set from non-test source.
# Without stripping, a key whose only "reader" is a doc-comment reference
# (several exist: layers.ts, env-profile.ts, dpa-guard.ts) would falsely
# pass. Three substitutions, in order:
#   1. strip same-line block comments (`/* x */`, `/** x */`)
#   2. drop lines that are block-comment openers/continuations/closers
#      (leading whitespace then `*` or `/*`) — the JSDoc shape every
#      multi-line comment in this repo uses. NOTE: deliberately NOT the
#      check-ee-imports.sh range delete (`/\/\*/,/\*\// d`): glob strings
#      in template literals (e.g. "metrics/*.yml" in cli init.ts) contain
#      `/*` and would open a range that deletes real code to EOF,
#      producing false "no reader" failures.
#   3. strip trailing `//` comments. Limit: a `//` inside a string
#      literal (URLs) also truncates the line — harmless unless a reader
#      call sits AFTER a URL on the same line, which would fail noisily,
#      not silently pass.
# ---------------------------------------------------------------------------
STRIP_COMMENTS='sed -E "s#/\*([^*]|\*+[^*/])*\*+/##g; /^[[:space:]]*(\*|\/\*)/d; s#//.*\$##"'

# Fast-path: only files that can possibly contain reader evidence
# (a getSetting call, a process.env read, or an ALL-CAPS string literal
# that could be a const-bound key).
CANDIDATES=$(grep -rlE 'getSetting|process\.env|"[A-Z][A-Z0-9_]{2,}"' \
  packages/*/src ee/src plugins/*/src \
  --include='*.ts' --include='*.tsx' \
  --exclude='*.test.ts' --exclude='*.test.tsx' \
  --exclude='test-setup.ts' \
  --exclude-dir=__tests__ --exclude-dir=__mocks__ --exclude-dir=__test-utils__ \
  --exclude-dir=testing \
  --exclude-dir=node_modules --exclude-dir=dist \
  2>/dev/null \
  | grep -vx "$SETTINGS_FILE" \
  | grep -vx "$GENERIC_SETTINGS_ROUTES_FILE" \
  || true)

if [ -z "$CANDIDATES" ]; then
  echo "::error::no candidate source files found under packages/*/src — scope globs in $(basename "$0") are probably stale." >&2
  exit 2
fi

EVIDENCE=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # tr -d '\0' + grep -a: one web page file contains a byte sequence grep
  # detects as binary; without these the evidence pass degrades to
  # "binary file matches" and drops the file's lines.
  EVIDENCE+=$(eval "$STRIP_COMMENTS \"\$f\"" \
    | tr -d '\0' \
    | grep -aE 'getSetting|process\.env|"[A-Z][A-Z0-9_]{2,}"' \
    | sed "s|^|$f: |" || true)
  EVIDENCE+=$'\n'
done <<<"$CANDIDATES"

# ---------------------------------------------------------------------------
# 3. Per-key reader check.
# ---------------------------------------------------------------------------
MISSING=0
R1_COUNT=0
R2_COUNT=0
R3_COUNT=0
ALLOWLISTED_COUNT=0

is_allowlisted() {
  local key="$1" entry
  # Empty-array guard: bash < 4.4 errors on "${ALLOWLIST[@]}" under set -u.
  [ "${#ALLOWLIST[@]}" -eq 0 ] && return 1
  for entry in "${ALLOWLIST[@]}"; do
    [ "$entry" = "$key" ] && return 0
  done
  return 1
}

while IFS='|' read -r key envvar scope; do
  [ -z "$key" ] && continue

  if is_allowlisted "$key"; then
    ALLOWLISTED_COUNT=$((ALLOWLISTED_COUNT + 1))
    continue
  fi

  # R1 — direct literal read.
  if grep -qE "getSetting(Auto|Live|Override)?\(\s*[\"']${key}[\"']" <<<"$EVIDENCE"; then
    R1_COUNT=$((R1_COUNT + 1))
    continue
  fi

  # R2 — const-indirected read.
  CONST_NAMES=$(grep -oE "(const|let|var)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[\"']${key}[\"']" <<<"$EVIDENCE" \
    | awk '{print $2}' | sort -u || true)
  FOUND_VIA_CONST=0
  for name in $CONST_NAMES; do
    if grep -qE "getSetting(Auto|Live|Override)?\(\s*${name}\b" <<<"$EVIDENCE"; then
      FOUND_VIA_CONST=1
      break
    fi
  done
  if [ "$FOUND_VIA_CONST" -eq 1 ]; then
    R2_COUNT=$((R2_COUNT + 1))
    continue
  fi

  # R3 — env-mirror read, platform-scoped keys only (see header).
  if [ "$scope" = "platform" ]; then
    ENV_READS=$(grep -E "process\.env\.${envvar}\b|process\.env\[[\"']${envvar}[\"']\]" <<<"$EVIDENCE" \
      | grep -vE "process\.env(\.${envvar}|\[[\"']${envvar}[\"']\])[[:space:]]*=([^=]|$)" || true)
    if [ -n "$ENV_READS" ]; then
      R3_COUNT=$((R3_COUNT + 1))
      continue
    fi
  fi

  echo "::error::setting '$key' has no runtime reader — name the reader or remove the setting (parity contract Rule 1)"
  MISSING=$((MISSING + 1))
done <<<"$REGISTRY"

if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "Found $MISSING registry key(s) in $SETTINGS_FILE with no non-test runtime reader."
  echo ""
  echo "Every admin-writable setting must name its runtime reader (parity"
  echo "contract Rule 1, #3380/#3382). Fix one of:"
  echo "  1. Add the reader: call getSetting/getSettingAuto/getSettingLive"
  echo "     with the key (workspace-scoped keys must pass orgId so the"
  echo "     per-workspace override is honored)."
  echo "  2. Platform-scoped boot keys read via env are accepted as-is"
  echo "     (process.env.<ENVVAR> in non-test source)."
  echo "  3. If the exemption is intentional, add the key to ALLOWLIST in"
  echo "     scripts/$(basename "$0") WITH a justification comment naming"
  echo "     why no getSetting reader exists."
  echo "  4. Otherwise remove the setting from the registry — a key nothing"
  echo "     reads is UI-visible but runtime-inert (drift class 1, #3374)."
  exit 1
fi

echo "Settings reader check passed — $KEY_COUNT registry key(s): $R1_COUNT direct getSetting, $R2_COUNT const-indirected, $R3_COUNT env-mirror (platform-scoped), $ALLOWLISTED_COUNT allowlisted."
