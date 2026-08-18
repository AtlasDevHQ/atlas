#!/usr/bin/env bash
# Adversarial fixtures for scripts/check-web-brand-tokens.sh (#5306).
#
# ⚠️ Each case re-introduces the ACTUAL defect the gate was filed for, on a
# throwaway copy of the real files, and was observed red on 2026-08-17:
#
#   mutation                                        →  observed
#   ──────────────────────────────────────────────     ─────────────────────────
#   <body> regains `bg-white dark:bg-zinc-950`         case 3 red (the #5306 body)
#   apps/www redefines --code-bg locally               case 4 red (the drift the
#                                                        "identical on every
#                                                        surface" claim forbids)
#   brand.css's --code-bg diverges from PRODUCT.md     case 5 red
#   the next/font import is removed                    case 6 red
#   --font-mono stops referencing --font-jetbrains     case 7 red
#   one hardcoded utility is added                     case 8 red (the ratchet)
#
# `set -uo pipefail`, no `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/check-web-brand-tokens.sh"

[ -f "$GATE" ] || { echo "::error::gate under test not found at $GATE" >&2; exit 2; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

CASE_N=0
TREE=""

# A throwaway tree carrying COPIES OF THE REAL FILES. Copies, not hand-written
# stand-ins: a fixture that invents its own layout.tsx would drift from the file
# the gate actually reads, and then prove nothing about it.
new_tree() {
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE/packages/web/src/app" "$TREE/apps/www/src/app"
  cp "$REPO/brand.css" "$TREE/brand.css"
  cp "$REPO/PRODUCT.md" "$TREE/PRODUCT.md"
  cp "$REPO/packages/web/src/app/layout.tsx" "$TREE/packages/web/src/app/layout.tsx"
  cp "$REPO/packages/web/src/app/globals.css" "$TREE/packages/web/src/app/globals.css"
  cp "$REPO/apps/www/src/app/globals.css" "$TREE/apps/www/src/app/globals.css"
  # One representative component, so the ratchet has something to count.
  mkdir -p "$TREE/packages/web/src/ui"
  printf 'export const X = () => <div className="bg-zinc-100 text-zinc-500" />;\n' \
    > "$TREE/packages/web/src/ui/sample.tsx"
  ( cd "$TREE" && git init -q . && git add -A ) >/dev/null 2>&1
}

stage() { ( cd "$TREE" && git add -A ) >/dev/null 2>&1; }

# The real repo's ceiling is four figures; a fixture tree's is single digits, so
# the constant is rewritten in a local copy of the gate — only that constant, so
# every rule under test stays byte-identical to the shipped one. The ceiling is
# DERIVED from the tree at call time rather than hardcoded here: a fixture that
# asserted "2" would break the moment a copied real file gained a mention.
GATE_COPY=""
prepare_gate() { # prepare_gate [CEILING] — default: the tree's current count
  local ceiling="${1:-}"
  if [ -z "$ceiling" ]; then
    ceiling="$( ( cd "$TREE" && git add -A >/dev/null 2>&1; git ls-files -- 'packages/web/src/*.tsx' 'packages/web/src/*.ts' 2>/dev/null |
      xargs -r grep -InoE '\b(bg|text|border|ring|fill|stroke|from|to|via|divide|placeholder|decoration|outline|caret|accent)-(white|black|zinc|slate|gray|neutral|stone)(-[0-9]{2,3})?\b' 2>/dev/null | wc -l | tr -d ' ' ) )"
  fi
  GATE_COPY="$TREE/gate.sh"
  sed "s/^HARDCODED_CEILING=.*/HARDCODED_CEILING=${ceiling}/" "$GATE" > "$GATE_COPY"
}

run_gate() { # -> sets RC and OUT
  RC=0
  OUT=$(WEB_BRAND_TOKENS_ROOT="$TREE" bash "$GATE_COPY" 2>&1) || RC=$?
}

echo "check-web-brand-tokens.test.sh — adversarial fixtures (#5306)"

# 1. THE REAL REPO — the assertion that matters in practice.
rc_real=0
out_real=$(bash "$GATE" 2>&1) || rc_real=$?
if [ "$rc_real" = "0" ]; then
  pass "the real repo follows its brand tokens"
else
  fail "the real repo — expected exit 0, got $rc_real"
  printf '%s\n' "$out_real" | sed 's/^/       | /' >&2
fi

# 2. POSITIVE CONTROL on the copied tree, so every red below means something.
new_tree; prepare_gate; prepare_gate; stage; run_gate
if [ "$RC" = "0" ]; then
  pass "an unmodified copy of the real files passes"
else
  fail "unmodified copy — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 3. DEFECT 1 RESTORED: the <body> className from before #5306, verbatim.
new_tree
sed -i 's|<body className="flex h-dvh flex-col font-sans antialiased">|<body className="flex h-dvh flex-col bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">|' \
  "$TREE/packages/web/src/app/layout.tsx"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "root <body> carries a hardcoded color utility"; then
  pass "the pre-#5306 <body> (bg-white / dark:bg-zinc-950) is caught"
else
  fail "body color utility — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 4. THE DRIFT VECTOR: a second definition of the code surface. This is the one
# the issue comment asked for — "--code-* resolves to the same values in every
# app" is a claim about copies, so the gate refuses the second copy.
new_tree
printf ':root { --code-bg: oklch(0.14 0.006 167); }\n' >> "$TREE/apps/www/src/app/globals.css"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "redefines a --code-* token"; then
  pass "an app redefining --code-bg is caught even when the value MATCHES"
else
  fail "second --code-* definition — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 5. PROSE/CSS PARITY: PRODUCT.md is the commitment, brand.css the
# implementation; the gate reads the numbers out of the prose.
new_tree
sed -i 's|--code-bg: oklch(0.14 0.006 167);|--code-bg: oklch(0.18 0.006 167);|' "$TREE/brand.css"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "but PRODUCT.md states"; then
  pass "a --code-bg that diverges from PRODUCT.md's stated value is caught"
else
  fail "prose/CSS divergence — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 6. DEFECT 3 RESTORED: no font loader at all, which is what shipped.
new_tree
sed -i '/next\/font\/google/d' "$TREE/packages/web/src/app/layout.tsx"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "no next/font import"; then
  pass "removing the next/font import is caught"
else
  fail "missing font loader — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 7. …and the subtler half: the fonts load but nothing points at them, which
# renders exactly like not loading them.
new_tree
sed -i 's|--font-mono: var(--font-jetbrains), |--font-mono: |' "$TREE/packages/web/src/app/globals.css"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF -- "--font-mono does not reference"; then
  pass "a loaded font that no token references is caught"
else
  fail "unreferenced font — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 8. THE RATCHET goes red on one more hardcoded utility — the "fourth bypass"
# the acceptance criterion is about.
new_tree
prepare_gate   # ceiling = the tree BEFORE the new file
printf 'export const Y = () => <div className="bg-white" />;\n' > "$TREE/packages/web/src/ui/another.tsx"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "hardcoded neutral utilities went UP"; then
  pass "one added hardcoded utility trips the ratchet"
else
  fail "ratchet — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 8b. …and removing one does NOT fail; it reports the lower number to lock in.
new_tree
prepare_gate   # ceiling = the tree BEFORE the conversion
printf 'export const X = () => <div className="bg-muted text-muted-foreground" />;\n' \
  > "$TREE/packages/web/src/ui/sample.tsx"
stage; run_gate
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qF "fewer than the ceiling"; then
  pass "converting a component to tokens passes and reports the new ceiling"
else
  fail "ratchet downward — expected exit 0 with a lower-ceiling hint, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 9. VACUITY: the tokenized ground rule itself disappearing must fail. With no
# color utility on <body> AND no @layer base rule, the page has no ground at all
# — and every other check would still pass.
new_tree
perl -0pi -e 's/body \{\s*\@apply bg-background text-foreground;\s*\}//s' "$TREE/packages/web/src/app/globals.css"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "no longer applies bg-background"; then
  pass "deleting the @layer base ground rule is caught"
else
  fail "missing ground rule — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 10. The gate must say it cannot look, rather than pass, on a tree without the
# files it reads.
CASE_N=$((CASE_N + 1))
TREE="$TMPROOT/case$CASE_N"; mkdir -p "$TREE"
RC=0
OUT=$(WEB_BRAND_TOKENS_ROOT="$TREE" bash "$GATE" 2>&1) || RC=$?
if [ "$RC" = "2" ]; then
  pass "a tree with no brand.css exits 2 (verified nothing), never 0"
else
  fail "empty tree — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

echo ""
echo "check-web-brand-tokens.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
