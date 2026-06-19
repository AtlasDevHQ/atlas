#!/bin/bash
# Verify the compile-time lead-union mirror assertion still exists in
# `ee/src/saas-crm/index.ts` (#3653).
#
# `SaasCrmLeadInput` (packages/api/src/lib/effect/services.ts) and
# `AtlasLeadEvent` (plugins/twenty/src/lead-normalizer.ts) are hand-mirrored
# wire-shape unions kept identical by one load-bearing line:
#
#   const _leadUnionsAreMirrors: ExactType<SaasCrmLeadInput, AtlasLeadEvent> = true;
#
# `ee/src/saas-crm/` is the single module allowed to depend on both sides (the
# EE inversion rule), and `dispatchOutboxRow` casts `row.payload as
# SaasCrmLeadInput` → `normalizeLead(...)` on the strength of that equality. If
# the assertion line were ever deleted, reworded out of recognition, or the
# file excluded from `tsgo`, the drift guard would vanish SILENTLY — a variant
# added to one union but not the other would then dead-letter at flush time
# (`normalizeLead`'s runtime `Unknown lead source` throw) instead of going red
# in type-check.
#
# This gate closes that one silent-regression path the same way the repo's
# other structural guards do: a cheap grep that fails loudly if the assertion
# (or the bivariance `ExactType` definition it depends on) goes missing. It is
# deliberately NOT a type check — `tsgo` already proves the unions match WHEN
# the line is present; this proves the line is still there.

set -euo pipefail

TARGET="ee/src/saas-crm/index.ts"

if [ ! -f "$TARGET" ]; then
  echo "::error::lead-union mirror SSOT file not found at $TARGET — the cross-package union drift guard has no home"
  echo ""
  echo "Expected $TARGET to declare the ExactType<SaasCrmLeadInput, AtlasLeadEvent> assertion."
  echo "If the file moved, update TARGET in $(basename "$0") to follow it."
  exit 1
fi

# Strip comments before matching so a commented-out assertion can't satisfy the
# gate (same three-step sed program as check-twenty-resolver-imports.sh):
#   1. same-line block comments  2. multi-line block comments  3. trailing //
STRIPPED="$(sed -E 's#/\*([^*]|\*+[^*/])*\*+/##g; /\/\*/,/\*\// d; s#//.*$##' "$TARGET")"

# The assertion itself: `const _leadUnionsAreMirrors: ExactType<SaasCrmLeadInput,
# AtlasLeadEvent> = true`. Whitespace-tolerant; both type args pinned so a guard
# pointed at the wrong unions can't pass. The `= true` is load-bearing (a bare
# `T extends true` helper fails open on `never`), so require it explicitly.
ASSERTION_RE='const[[:space:]]+_leadUnionsAreMirrors[[:space:]]*:[[:space:]]*ExactType<[[:space:]]*SaasCrmLeadInput[[:space:]]*,[[:space:]]*AtlasLeadEvent[[:space:]]*>[[:space:]]*=[[:space:]]*true'

# The bivariance idiom behind ExactType. Guards against the assertion being
# neutered to a trivial `type ExactType<A, B> = true` alias that always passes.
EXACTTYPE_RE='type[[:space:]]+ExactType<.*>[[:space:]]*=[[:space:]]*\(<'

MISSING=""
if ! printf '%s' "$STRIPPED" | grep -Eq "$ASSERTION_RE"; then
  MISSING="${MISSING}  - the assertion: const _leadUnionsAreMirrors: ExactType<SaasCrmLeadInput, AtlasLeadEvent> = true;"$'\n'
fi
if ! printf '%s' "$STRIPPED" | grep -Eq "$EXACTTYPE_RE"; then
  MISSING="${MISSING}  - the bivariance ExactType<A, B> definition it depends on"$'\n'
fi

if [ -n "$MISSING" ]; then
  echo "::error::lead-union mirror assertion missing from $TARGET — cross-package drift is no longer guarded"
  echo ""
  echo "Missing:"
  printf '%s' "$MISSING"
  echo ""
  echo "Why this matters:"
  echo "  SaasCrmLeadInput and AtlasLeadEvent are hand-mirrored unions. The"
  echo "  ExactType '= true' assertion is the ONLY thing that makes tsgo go red"
  echo "  when they drift. Without it, a one-sided variant addition dead-letters"
  echo "  silently at outbox flush instead of failing the build."
  echo ""
  echo "Fix:"
  echo "  Restore the assertion (and ExactType definition) in $TARGET. See #3653"
  echo "  and the rationale comment above _leadUnionsAreMirrors."
  exit 1
fi

echo "Lead-union mirror check passed — ExactType<SaasCrmLeadInput, AtlasLeadEvent> assertion is present in $TARGET."
