#!/bin/bash
# Verify that core (packages/api/src/) does not import from @atlas/ee
# except in the one boot-time composition file. Closes the 1.5.1
# architecture-deepening arc (#2017 / milestone #48) by locking in the
# inversion: ee depends on core, never the reverse.
#
# The grep targets only real import syntax (`from "@atlas/ee`, dynamic
# `import("@atlas/ee`, `require("@atlas/ee`) AFTER stripping `//` line
# comments and `/* … */` block comments. Comment references to the old
# module paths (e.g. `// Inverts await import("@atlas/ee/...")`) are
# fine and don't count, since they document history without producing
# a structural dependency.
#
# A regression in this script means a new dynamic-import slipped in;
# either migrate the call site to `yield* TheTag` from Effect Context,
# or — if the new feature genuinely needs a fresh subsystem — define
# a Context.Tag in `lib/effect/services.ts` and an `Layer.effect` in
# `ee/src/layers.ts`, mirroring the slices in #2563–#2585.

set -euo pipefail

CORE_DIR="packages/api/src"
ALLOWED_FILE="packages/api/src/lib/effect/enterprise-layer.ts"

if [ ! -d "$CORE_DIR" ]; then
  echo "::error::core source directory not found at $CORE_DIR" >&2
  exit 2
fi

if [ ! -f "$ALLOWED_FILE" ]; then
  echo "::error::expected boot-time composition file not found at $ALLOWED_FILE" >&2
  echo "::error::if the file moved, update ALLOWED_FILE in $(basename "$0")." >&2
  exit 2
fi

# Real import syntax. The `from "@atlas/ee`, `import("@atlas/ee`, and
# `require("@atlas/ee` forms cover static ESM, dynamic ESM, and CJS.
PATTERN='from "@atlas/ee|import\("@atlas/ee|require\("@atlas/ee'

# Strip comments before pattern-matching so a historical reference like
# `// Inverts await import("@atlas/ee/...")` in a docstring doesn't
# false-positive. The sed program:
#   /\/\*/,/\*\// d   — delete any line inside `/* … */` (single- or
#                       multi-line block comments)
#   s|//.*$||         — strip trailing `// …` from each remaining line
# This is intentionally narrow: it does not try to handle string
# literals containing `//` (none in core touch `@atlas/ee` in a
# literal). If a regression introduces such a literal, the gate will
# still flag the file — which is the conservative direction.
STRIP_COMMENTS='sed -E "/\/\*/,/\*\// d; s|//.*\$||"'

# Candidate files: any file whose raw text contains the pattern. We
# still post-filter each via STRIP_COMMENTS to weed out comment-only
# matches; the outer grep is just a fast-path so we don't sed every
# .ts file in core.
CANDIDATES=$(grep -rln -E "$PATTERN" "$CORE_DIR" \
  --include='*.ts' \
  --include='*.tsx' \
  --exclude='*.test.ts' \
  --exclude-dir=__mocks__ \
  --exclude-dir=__tests__ \
  --exclude-dir=__test-utils__ \
  || true)

OFFENDERS=""
if [ -n "$CANDIDATES" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if eval "$STRIP_COMMENTS \"\$f\"" | grep -qE "$PATTERN"; then
      OFFENDERS="${OFFENDERS}${f}"$'\n'
    fi
  done <<<"$CANDIDATES"
fi

UNEXPECTED=$(echo "${OFFENDERS%$'\n'}" | grep -v "^$ALLOWED_FILE$" || true)
UNEXPECTED=$(echo "$UNEXPECTED" | grep -v '^$' || true)

if [ -n "$UNEXPECTED" ]; then
  echo "::error::core imports from @atlas/ee outside the allowed boot-time composition file."
  echo ""
  echo "Allowed file (boot-time composition only):"
  echo "  $ALLOWED_FILE"
  echo ""
  echo "Unexpected importers:"
  echo "$UNEXPECTED" | sed 's/^/  /'
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
  exit 1
fi

echo "EE import check passed — only $ALLOWED_FILE imports from @atlas/ee (the allowed boot-time composition)."
