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
# Cases 11-14 were added on 2026-08-18, each closing a hole the first eleven left
# — three of them states in which the gate reported the product surface as
# conformant while the #5306 defect was present:
#
#   the SAME <body> defect, split across lines       case 11 red (was GREEN: the
#                                                      check read only the line
#                                                      the tag opens on)
#   packages/web's brand.css symlink is cut          case 12 red (was GREEN: one
#                                                      correct copy still existed
#                                                      — the app just could not
#                                                      see it)
#   the --color-code-bg theme mapping is dropped     case 13 red (was GREEN: the
#                                                      utility silently stops
#                                                      existing)
#   a code pane stops overriding the theme's font    case 14 red (was GREEN: the
#                                                      fonts load, the tokens
#                                                      reference them, and the
#                                                      pane renders Fira Code)
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
  # The symlink packages/web reaches brand.css through. It is part of the subject,
  # not scaffolding: cutting it is how the app can lose every --code-* value while
  # brand.css still holds exactly one correct copy of them.
  ln -s ../../brand.css "$TREE/packages/web/brand.css"
  # The two panes that mount a syntax highlighter. The theme ships its own
  # background AND font, so these are where "identical on every surface" is
  # actually kept or lost.
  mkdir -p "$TREE/packages/web/src/ui/components/chat"
  cp "$REPO/packages/web/src/ui/components/chat/sql-block.tsx" \
     "$REPO/packages/web/src/ui/components/chat/markdown.tsx" \
     "$TREE/packages/web/src/ui/components/chat/"
  # The two sanctioned mirrors of brand.css's --code-*. @useatlas/react is
  # published to npm and cannot symlink a repo file, so its copy is literal and
  # checked BY VALUE instead; packages/api inlines a third copy into the widget
  # HTML. All three must agree, which is what A3 tests.
  mkdir -p "$TREE/packages/react/src" "$TREE/packages/api/src/api/routes"
  cp "$REPO/packages/react/src/styles.css" "$TREE/packages/react/src/styles.css"
  cp "$REPO/packages/api/src/api/routes/widget.ts" "$TREE/packages/api/src/api/routes/widget.ts"
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

# 11. ⚠️ THE DEFECT, WRITTEN ACROSS LINES. Case 3 restores the pre-#5306 <body>
# on ONE line. The check used to read only the line the tag opens on, so the
# identical className split across three lines passed GREEN — and `<html>` in
# this same file is already multi-line, so one added attribute or any formatter
# reflow gets you there. Mutation: make the gate read `head -1` of the tag again
# → this goes green and #5306 is back.
new_tree
perl -0pi -e 's{<body className="flex h-dvh flex-col font-sans antialiased">}{<body\n        className="flex h-dvh flex-col bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100"\n      >}s' \
  "$TREE/packages/web/src/app/layout.tsx"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "root <body> carries a hardcoded color utility"; then
  pass "the same <body> defect split across lines is still caught"
else
  fail "multi-line body — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 12. REACHABILITY, not just uniqueness. Cut the symlink and brand.css still
# holds exactly one correct copy of every --code-* value — while the app can see
# none of them and every code pane loses its ground. Check A alone reports clean.
new_tree
rm -f "$TREE/packages/web/brand.css"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "is not the shared brand.css"; then
  pass "severing packages/web's link to brand.css is caught"
else
  fail "severed brand.css link — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 13. A token nothing maps into the theme is a utility that does not exist:
# `bg-code-bg` then renders as nothing at all, silently.
new_tree
perl -0pi -e 's/^\s*--color-code-bg:.*\n//m' "$TREE/packages/web/src/app/globals.css"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "does not map --color-code-bg"; then
  pass "dropping the --color-code-bg theme mapping is caught"
else
  fail "missing theme mapping — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 14. ⚠️ THE FONT HALF OF THE SAME DEFECT. oneDark hardcodes its own Fira Code
# stack on BOTH the pre and the inner code tag, so a pane that overrides only
# `background` renders in the wrong typeface while checks A–D all pass: the
# fonts load, the tokens reference them, and the panes ignore both. apps/www
# renders its code in JetBrains Mono, so the result is two typefaces for one
# "identical on every surface" pane.
new_tree
perl -0pi -e 's/, fontFamily: "var\(--font-mono\)" \}/ }/' \
  "$TREE/packages/web/src/ui/components/chat/sql-block.tsx"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF 'not 2 (the pane style and the code-tag props)'; then
  pass "a code pane that lets the Prism theme keep its own font is caught"
else
  fail "code-pane fontFamily — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 15. ⚠️ THE HIGHLIGHTED BRANCH, WHICH IS THE STATE USERS SEE. #5306's headline
# defect lives here and nothing could see it: `oneLight` is a JS identifier the
# ratchet cannot count, and the unit test asserts on the fallback <pre>, a
# different element. Measured before this check existed: stripping the pane
# background left all 5 sql-block tests green AND the gate at exit 0.
new_tree
perl -0pi -e 's/\n\s*background: "var\(--code-bg\)",//' \
  "$TREE/packages/web/src/ui/components/chat/sql-block.tsx"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF 'without background: "var(--code-bg)"'; then
  pass "a highlighted pane that drops the brand ground is caught"
else
  fail "pane background — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 16. …and the mode-following theme itself, reinstated in CODE.
new_tree
sed -i 's/style={mod.oneDark}/style={dark ? mod.oneDark : mod.oneLight}/' \
  "$TREE/packages/web/src/ui/components/chat/sql-block.tsx"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF 'references oneLight'; then
  pass "reinstating oneLight in code is caught"
else
  fail "oneLight in code — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 17. …while the header COMMENT that quotes the old `dark ? oneDark : oneLight`
# as the defect it describes must stay legal. A gate that forced the removal of
# an accurate historical note would be buying its red with a worse doc.
new_tree; prepare_gate; stage; run_gate
if [ "$RC" = "0" ] && grep -qF 'oneDark : oneLight' "$TREE/packages/web/src/ui/components/chat/sql-block.tsx"; then
  pass "the same words in a comment describing the defect are not a finding"
else
  fail "oneLight in comment — expected exit 0 with the comment present, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 18. ⚠️ CHECK D WAS SATISFIABLE BY A COMMENT. `grep -q Sora layout.tsx` matched
# the block above <html> that NAMES the pair, so the loader could be swapped for
# a different font entirely and the gate still certified the brand pair.
new_tree
sed -i -e 's/import { Sora, JetBrains_Mono }/import { Inter, JetBrains_Mono }/' \
       -e 's/^const sora = Sora({/const sora = Inter({/' \
  "$TREE/packages/web/src/app/layout.tsx"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF 'does not CALL Sora(...)'; then
  pass "swapping the loader while keeping the comment is caught"
else
  fail "font loader swap — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 19. ⚠️ readlink -f MISSING MUST BE exit 2, NEVER A PASS. Without it both
# command substitutions returned "", `[ "" = "" ]` was true, every candidate was
# skipped, and check A became a no-op while the success banner printed — on BSD
# before macOS 12.3 and in busybox containers, i.e. wherever ci-local.sh is run
# by hand.
new_tree
printf ':root { --code-bg: oklch(0.5 0 0); }\n' >> "$TREE/apps/www/src/app/globals.css"
prepare_gate; stage
mkdir -p "$TREE/stub"
printf '#!/bin/sh\nexit 1\n' > "$TREE/stub/readlink"; chmod +x "$TREE/stub/readlink"
RC=0
OUT=$(PATH="$TREE/stub:$PATH" WEB_BRAND_TOKENS_ROOT="$TREE" bash "$GATE_COPY" 2>&1) || RC=$?
if [ "$RC" = "2" ]; then
  pass "a broken readlink -f exits 2, never a green no-op"
else
  fail "readlink stub — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 21. ⚠️ A MIRROR THAT DRIFTS. `@useatlas/react` ships to npm and cannot symlink
# brand.css, so its --code-* are a literal copy — licensed only because the
# values are checked. Drift is precisely the two-correct-looking-copies failure
# the symlink exists to prevent.
new_tree
sed -i 's/--code-bg: oklch(0.14 0.006 167);/--code-bg: oklch(0.18 0.006 167);/' \
  "$TREE/packages/react/src/styles.css"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "but brand.css says"; then
  pass "a sanctioned mirror whose --code-bg drifts from brand.css is caught"
else
  fail "mirror drift — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 22. …and a mirror carrying only SOME of the tokens. The widget HTML in
# packages/api is a third copy; styles.css's own comment warns about it.
new_tree
sed -i 's/--code-fg:oklch(0.86 0 0);//' "$TREE/packages/api/src/api/routes/widget.ts"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "does not define --code-fg"; then
  pass "a mirror missing one code token is caught"
else
  fail "incomplete mirror — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 23. …and an UNSANCTIONED second copy is still refused outright, so case 21's
# licence does not generalise into "any file may define these".
new_tree
mkdir -p "$TREE/packages/other/src"
printf ':root { --code-bg: oklch(0.14 0.006 167); }\n' > "$TREE/packages/other/src/rogue.css"
prepare_gate; stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "redefines a --code-* token"; then
  pass "an unregistered file defining --code-* is still refused"
else
  fail "rogue copy — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# ⚠️ AN ABSOLUTE LITERAL, for the reason its siblings carry one. PASS+FAIL is a
# tally of the cases that RAN; nothing above notices a case that silently stopped
# running — a `sed` whose anchor drifted, an `if` that can no longer be reached.
# A suite reporting "15 passed" while three cases quietly vanished reads exactly
# like success, which is the failure this whole directory exists to refuse.
EXPECTED_CASES=23
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES cases ran"
else
  fail "case count — expected $EXPECTED_CASES cases, $TOTAL ran (a case stopped running)"
fi

echo ""
echo "check-web-brand-tokens.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
