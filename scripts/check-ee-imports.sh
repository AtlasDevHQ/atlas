#!/bin/bash
# Verify that the AGPL core packages do not import from @atlas/ee except in
# the small, documented set of allowed boundary files. Closes the 1.5.1
# architecture-deepening arc (#2017 / milestone #48) by locking in the
# inversion: ee depends on core, never the reverse.
#
# Two scopes are scanned (#3998 added the second):
#
#   1. packages/api/src — the AGPL core API. Allowed file:
#        lib/effect/enterprise-layer.ts  (boot-time Layer composition only).
#      Everything else routes enterprise capability through a Context.Tag
#      (`yield* TheTag`) with a Noop layer for the non-enterprise case.
#
#   2. packages/mcp/src — the AGPL-licensed MCP server package, which is
#      structurally above core (it already statically depends on @atlas/api).
#      Its self-serve onboarding + governance surface is *formally SaaS-coupled*
#      (see docs/development/enterprise-gating.md § "The MCP SaaS-coupled
#      surface"): the `start_trial` onboarding tool only exists on hosted Atlas
#      (a static import gated by the SaaS-only deploy mode), and the
#      actor-binding approval probe is a deferred, fail-closed dynamic import.
#      Both touch @atlas/ee through a documented, audited seam. Allowed files:
#        src/onboarding.ts   (start_trial → trial provisioning, SaaS-only static)
#        src/actor.ts        (approval-rule existence probe, deferred fail-closed)
#      Any *other* @atlas/ee importer in packages/mcp/src is a regression — the
#      coupling must stay confined to those two audited files so the boundary
#      can't widen unseen.
#
# The grep targets only real import syntax (`from "@atlas/ee`, dynamic
# `import("@atlas/ee`, `require("@atlas/ee`) AFTER stripping `//` line
# comments and `/* … */` block comments. Comment references to the old
# module paths (e.g. `// Inverts await import("@atlas/ee/...")`) are
# fine and don't count, since they document history without producing
# a structural dependency.
#
# A regression in the API scope means a new dynamic-import slipped in;
# either migrate the call site to `yield* TheTag` from Effect Context,
# or — if the new feature genuinely needs a fresh subsystem — define
# a Context.Tag in `lib/effect/services.ts` and an `Layer.effect` in
# `ee/src/layers.ts`, mirroring the slices in #2563–#2585.

set -euo pipefail

CORE_DIR="packages/api/src"
ALLOWED_FILE="packages/api/src/lib/effect/enterprise-layer.ts"

MCP_DIR="packages/mcp/src"
# Documented SaaS-coupled seam files in @atlas/mcp (see header + the
# enterprise-gating doc). Newline-separated; each entry is a repo-relative path.
MCP_ALLOWED_FILES="packages/mcp/src/onboarding.ts
packages/mcp/src/actor.ts"

if [ ! -d "$CORE_DIR" ]; then
  echo "::error::core source directory not found at $CORE_DIR" >&2
  exit 2
fi

if [ ! -f "$ALLOWED_FILE" ]; then
  echo "::error::expected boot-time composition file not found at $ALLOWED_FILE" >&2
  echo "::error::if the file moved, update ALLOWED_FILE in $(basename "$0")." >&2
  exit 2
fi

if [ ! -d "$MCP_DIR" ]; then
  echo "::error::mcp source directory not found at $MCP_DIR" >&2
  exit 2
fi

# Each MCP allowlist entry must still exist; a stale entry would silently
# whitelist nothing (harmless) but more often means the file moved and a new
# unguarded copy was created — fail loud so the allowlist is kept honest.
while IFS= read -r allowed; do
  [ -z "$allowed" ] && continue
  if [ ! -f "$allowed" ]; then
    echo "::error::allowlisted MCP seam file not found at $allowed" >&2
    echo "::error::if the file moved, update MCP_ALLOWED_FILES in $(basename "$0")." >&2
    exit 2
  fi
done <<<"$MCP_ALLOWED_FILES"

# Real import syntax. The `from "@atlas/ee`, `import("@atlas/ee`, and
# `require("@atlas/ee` forms cover static ESM, dynamic ESM, and CJS.
PATTERN='from "@atlas/ee|import\("@atlas/ee|require\("@atlas/ee'

# Strip comments before pattern-matching so a historical reference like
# `// Inverts await import("@atlas/ee/...")` in a docstring doesn't
# false-positive. The sed program runs three substitutions in order:
#
#   1. s|/\*([^*]|\*+[^*/])*\*+/||g
#        Strip same-line block comments (canonical C-comment regex —
#        handles plain `/* x */` and JSDoc-style `/** x */` on a single
#        line). MUST run before the range delete: pre-#2594 the range
#        delete saw a same-line `/* … */ import { x } from "@atlas/ee/y"`
#        and deleted the whole line including the real import, silently
#        whitelisting a structural EE dependency — see #2594 / commit
#        message for the adversarial fixtures that motivated this fix.
#   2. /\/\*/,/\*\// d
#        Delete lines participating in a true multi-line block comment
#        (the canonical sed range delete; safe now that same-line block
#        comments are already gone by step 1).
#   3. s|//.*$||
#        Strip trailing `// …` line comments.
#
# This is intentionally narrow: it does not try to parse string
# literals containing `from "@atlas/ee` — those would still false-
# positive. None exist in core today; the conservative direction is to
# flag a literal rather than silently allow one, so a future
# error-message string that needs the pattern should use concatenation
# (e.g. `"from \"" + "@atlas/ee\""`) or, better, name the package
# inline-via-a-constant.
# `#` delimiter for the substitutions so the ERE alternation `|` inside
# the block-comment regex doesn't collide with the substitution
# delimiter (sed would otherwise see `|` as the end of the search half).
STRIP_COMMENTS='sed -E "s#/\*([^*]|\*+[^*/])*\*+/##g; /\/\*/,/\*\// d; s#//.*\$##"'

# scan_scope <dir> <newline-separated allowlist>
# Echoes any unexpected @atlas/ee importer (one path per line) to stdout.
# Candidate files: any file whose raw text contains the pattern. We still
# post-filter each via STRIP_COMMENTS to weed out comment-only matches; the
# outer grep is just a fast-path so we don't sed every .ts file in the scope.
scan_scope() {
  local dir="$1"
  local allowlist="$2"

  local candidates
  candidates=$(grep -rln -E "$PATTERN" "$dir" \
    --include='*.ts' \
    --include='*.tsx' \
    --exclude='*.test.ts' \
    --exclude-dir=__mocks__ \
    --exclude-dir=__tests__ \
    --exclude-dir=__test-utils__ \
    || true)

  local offenders=""
  if [ -n "$candidates" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      if eval "$STRIP_COMMENTS \"\$f\"" | grep -qE "$PATTERN"; then
        offenders="${offenders}${f}"$'\n'
      fi
    done <<<"$candidates"
  fi

  offenders="${offenders%$'\n'}"
  [ -z "$offenders" ] && return 0

  # Drop every allowlisted path from the offender set. `-vxF` matches the
  # allowlist entry as a FIXED whole-line string — never as a regex — so a
  # `.` in a path (`actor.ts`) is a literal dot, and a future allowlist entry
  # containing a regex metacharacter can't silently widen (fail-open) or
  # narrow the filter.
  local unexpected="$offenders"
  while IFS= read -r allowed; do
    [ -z "$allowed" ] && continue
    unexpected=$(echo "$unexpected" | grep -vxF "$allowed" || true)
  done <<<"$allowlist"

  unexpected=$(echo "$unexpected" | grep -v '^$' || true)
  [ -n "$unexpected" ] && echo "$unexpected"
  return 0
}

API_UNEXPECTED=$(scan_scope "$CORE_DIR" "$ALLOWED_FILE")
MCP_UNEXPECTED=$(scan_scope "$MCP_DIR" "$MCP_ALLOWED_FILES")

FAILED=0

if [ -n "$API_UNEXPECTED" ]; then
  FAILED=1
  echo "::error::core (packages/api/src) imports from @atlas/ee outside the allowed boot-time composition file."
  echo ""
  echo "Allowed file (boot-time composition only):"
  echo "  $ALLOWED_FILE"
  echo ""
  echo "Unexpected importers:"
  echo "$API_UNEXPECTED" | sed 's/^/  /'
  echo ""
  echo "Fix one of:"
  echo "  1. Migrate the call site to 'yield* TheTag' from Effect Context."
  echo "     Each enterprise subsystem already has a Context.Tag in"
  echo "     packages/api/src/lib/effect/services.ts (search for"
  echo "     'NoopXxxLayer') and an EE Layer.effect impl in ee/src/layers.ts."
  echo ""
  echo "  2. If a new subsystem is needed, define a fresh Context.Tag in"
  echo "     services.ts and a Layer.effect in ee/src/layers.ts — mirror"
  echo "     the slices in #2563 through #2585."
  echo ""
  echo "See parent issue #2017 + milestone 1.5.1 (#48) for the rationale."
  echo ""
fi

if [ -n "$MCP_UNEXPECTED" ]; then
  FAILED=1
  echo "::error::@atlas/mcp (packages/mcp/src) imports from @atlas/ee outside the documented SaaS-coupled seam files."
  echo ""
  echo "Allowed files (formally SaaS-coupled onboarding + governance seam):"
  echo "$MCP_ALLOWED_FILES" | sed 's/^/  /'
  echo ""
  echo "Unexpected importers:"
  echo "$MCP_UNEXPECTED" | sed 's/^/  /'
  echo ""
  echo "The MCP self-serve onboarding surface is formally SaaS-coupled (see"
  echo "docs/development/enterprise-gating.md § \"The MCP SaaS-coupled surface\")."
  echo "A NEW @atlas/ee importer in packages/mcp is a regression. Fix one of:"
  echo ""
  echo "  1. Keep the coupling out of MCP entirely — consume the capability"
  echo "     through @atlas/api (which routes enterprise features via a"
  echo "     Context.Tag), not a direct @atlas/ee import."
  echo ""
  echo "  2. If the surface genuinely belongs to the SaaS-only onboarding"
  echo "     funnel, fold it into one of the two existing audited seam files"
  echo "     rather than spreading the coupling to a new file. A new seam file"
  echo "     is a deliberate boundary expansion: prefer a deferred (dynamic),"
  echo "     fail-closed import, then add the file to MCP_ALLOWED_FILES with a"
  echo "     justification comment (the static onboarding.ts seam is grandfathered"
  echo "     because it is wholly SaaS-mode-gated; new seams should not add"
  echo "     static @atlas/ee dependencies)."
  echo ""
  echo "See #3998 + parent #3984 (WS5) for the rationale."
  echo ""
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

echo "EE import check passed:"
echo "  - core: only $ALLOWED_FILE imports from @atlas/ee (boot-time composition)."
echo "  - mcp:  only the documented SaaS-coupled seam files import from @atlas/ee."
