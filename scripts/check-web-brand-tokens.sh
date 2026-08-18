#!/usr/bin/env bash
# check-web-brand-tokens.sh — the product surface may not bypass its own brand
# tokens (#5306).
#
# ## Why this exists
#
# The token layer was correct and complete; the consuming components ignored it,
# so the tokens were right and the pixels were wrong. Three defects, all the same
# class — a documented brand invariant that no gate enforced:
#
#   1. `packages/web/src/app/layout.tsx`'s <body> hardcoded
#      `bg-white … dark:bg-zinc-950`. A Tailwind utility beats the `@layer base`
#      rule that sets `bg-background text-foreground`, so the page ground was
#      PURE WHITE in light mode instead of oklch(0.995 0.004 83) warm paper-lite,
#      and PURE NEUTRAL zinc in dark instead of the faintly forest-tinted
#      oklch(0.165 0.012 158) that ADR-0023 §4 and PRODUCT.md Principle 5 both
#      specify as "NOT pure gray". The skip-link on the very next line did it
#      correctly with `focus:bg-background`.
#   2. The SQL pane rendered `dark ? oneDark : oneLight` over `bg-zinc-100`.
#      PRODUCT.md Principle 5 makes the code surface fixed: "always-dark terminal
#      windows (--code-*), identical on every surface and mode". It is the hero
#      asset of the light-page/dark-code inversion, and in light mode it was a
#      light grey box.
#   3. Neither brand font was loaded. PRODUCT.md Principle 4 commits to "one font
#      pair (Sora + JetBrains Mono)"; there was no `next/font` import anywhere in
#      `packages/web/src`, so the app rendered in whatever `ui-sans-serif`
#      resolved to per-OS.
#
# ## What this gate checks, and the one thing it does NOT
#
#   A. `--code-*` is defined in exactly ONE place — the symlinked `brand.css` —
#      and no app redefines it. "Identical on every surface and mode" is a
#      statement about drift between two correct-looking copies, so the check is
#      that there is one copy, not that two copies currently agree.
#   B. Those values match the numbers PRODUCT.md states in prose.
#   C. The root <body> carries no color utility at all.
#   D. Both brand fonts load via next/font, and the type tokens point at them.
#   E. ⚠️ A RATCHET, not an absolute rule, on hardcoded neutral utilities in
#      `packages/web/src`. There are ~1100 of them. A zero-tolerance check would
#      need an allowlist longer than the codebase it guards, and an allowlist
#      that large is a findings dump, not a gate. So the count may only go DOWN:
#      a fourth bypass cannot land, and every conversion lowers the ceiling.
#      This is the honest form of the acceptance criterion, and its limit is
#      worth stating: it does not stop someone REPLACING a tokenized utility with
#      a hardcoded one of the same count. A, C and D do, on the surfaces that
#      matter most.
#
# Exit codes: 0 clean · 1 one or more findings · 2 this gate could not look.
#
# Adversarial fixtures: scripts/__tests__/check-web-brand-tokens.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A seam, so the fixture suite can point this at a throwaway tree rather than
# rewriting tracked source.
ROOT="${WEB_BRAND_TOKENS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

die() { echo "::error::[web-brand-tokens] $1" >&2; exit 2; }

[ -n "$ROOT" ] && [ -d "$ROOT" ] || die "ROOT '$ROOT' is not a directory."
cd "$ROOT" || die "could not enter ROOT '$ROOT'."

BRAND_CSS="brand.css"
WEB_LAYOUT="packages/web/src/app/layout.tsx"
WEB_GLOBALS="packages/web/src/app/globals.css"
PRODUCT="PRODUCT.md"
WEB_SRC="packages/web/src"

for f in "$BRAND_CSS" "$WEB_LAYOUT" "$WEB_GLOBALS" "$PRODUCT"; do
  [ -f "$f" ] || die "missing $f — this gate cannot verify anything."
done
[ -d "$WEB_SRC" ] || die "missing $WEB_SRC — this gate cannot verify anything."

FINDINGS=0
fail() { echo "::error file=$1::$2" >&2; echo "  $1: $2" >&2; FINDINGS=$((FINDINGS + 1)); }

echo "check-web-brand-tokens.sh — brand-token conformance for packages/web"

# ── A. one definition of the code surface ────────────────────────────────────
CODE_TOKENS=(--code-bg --code-chrome --code-well --code-fg --code-muted --code-border)

for tok in "${CODE_TOKENS[@]}"; do
  grep -qE "(^|[;{[:space:]])${tok}[[:space:]]*:" "$BRAND_CSS" || fail "$BRAND_CSS" "does not define ${tok}. The code surface is shared by every app; brand.css is where it lives."
done

# TRACKED FILES ONLY, via git: a plain `grep -r` from the repo root descends
# into `.claude/worktrees/**` — other checkouts of this same repo — and reports
# 24 findings in files that are not this tree.
#
# Any OTHER css file that assigns a --code-* token is a second copy. Assignment
# only, never a reference: the boundary class `(^|[;{ ])` before the token means
# `var(--code-bg)` does not match (preceded by `(`) and neither does an app's
# `--color-code-bg: var(--code-bg)` mapping (preceded by `-`), which is exactly
# what an app is supposed to have. A one-line `:root { --code-bg: … }` does
# match, which a `^\s*` anchor would have missed.
while IFS= read -r hit; do
  file="${hit%%:*}"
  [ "$file" = "$BRAND_CSS" ] && continue
  # brand.css is symlinked into each app; the symlink IS the one copy.
  [ "$(readlink -f "$file" 2>/dev/null)" = "$(readlink -f "$BRAND_CSS" 2>/dev/null)" ] && continue
  fail "$file" "redefines a --code-* token. There is one code surface: define it in $BRAND_CSS and reference it here. Two correct-looking copies drifting apart is what \"identical on every surface and mode\" forbids — and is how packages/web ended up with no code tokens at all while apps/www had them."
done < <(git ls-files -- '*.css' 2>/dev/null | xargs -r grep -InE '(^|[;{[:space:]])--code-(bg|chrome|well|fg|muted|border)[[:space:]]*:' 2>/dev/null)

# ── B. the values match the ones PRODUCT.md states ───────────────────────────
# PRODUCT.md › Design Tokens: "Code windows (fixed on every surface): bg oklch
# `0.14 0.006 167`, chrome `0.185`, well `0.10`." The prose is the commitment;
# the CSS is the implementation, and a gate that checked only the CSS would let
# them part company.
product_line="$(grep -m1 'Code windows (fixed on every surface)' "$PRODUCT" || true)"
[ -n "$product_line" ] || die "PRODUCT.md no longer states the \"Code windows (fixed on every surface)\" values — this gate reads them from there, so it cannot check the CSS against anything."

want_bg="$(printf '%s' "$product_line" | grep -oE 'bg oklch `[^`]+`' | grep -oE '`[^`]+`' | tr -d '`')"
want_chrome="$(printf '%s' "$product_line" | grep -oE 'chrome `[^`]+`' | grep -oE '`[^`]+`' | tr -d '`')"
want_well="$(printf '%s' "$product_line" | grep -oE 'well `[^`]+`' | grep -oE '`[^`]+`' | tr -d '`')"
[ -n "$want_bg" ] && [ -n "$want_chrome" ] && [ -n "$want_well" ] || die "could not parse the code-window values out of PRODUCT.md's prose (bg='$want_bg' chrome='$want_chrome' well='$want_well')."

css_val() { grep -m1 -oE "^\s*$1:[^;]*" "$BRAND_CSS" | sed -E "s/^\s*$1:\s*//"; }
# The prose gives chrome/well as lightness only ("0.185", "0.10"); the CSS
# carries the full triple. Compare the lightness component for those two.
first_num() { printf '%s' "$1" | grep -oE '[0-9]+\.?[0-9]*' | head -1; }

got_bg="$(css_val --code-bg)"
case "$got_bg" in
  *"$want_bg"*) ;;
  *) fail "$BRAND_CSS" "--code-bg is '$got_bg' but PRODUCT.md states oklch $want_bg." ;;
esac
for pair in "chrome:$want_chrome" "well:$want_well"; do
  name="${pair%%:*}"; want="${pair#*:}"
  got="$(first_num "$(css_val "--code-$name")")"
  # 0.10 and 0.1 are the same number, and CSS is written without the trailing 0.
  if [ "$(awk -v a="$got" -v b="$want" 'BEGIN{print (a==b) ? 1 : 0}')" != "1" ]; then
    fail "$BRAND_CSS" "--code-$name lightness is '$got' but PRODUCT.md states '$want'."
  fi
done

# ── C. the root <body> owns no color ─────────────────────────────────────────
# `@layer base { body { @apply bg-background text-foreground } }` in globals.css
# is the ground; ANY color utility on the element beats it.
# Newlines flattened: the rule is written across three lines, and a line-based
# grep would report the tokenized ground as missing while it is right there.
tr '\n' ' ' < "$WEB_GLOBALS" | grep -qE 'body[[:space:]]*\{[^}]*bg-background' ||
  fail "$WEB_GLOBALS" "the @layer base body rule no longer applies bg-background — with no color utility on <body>, nothing sets the page ground."

body_line="$(grep -nE '^\s*<body' "$WEB_LAYOUT" | head -1)"
[ -n "$body_line" ] || die "no <body> element found in $WEB_LAYOUT — this gate cannot check the page ground."
body_n="${body_line%%:*}"
body_class="${body_line#*:}"
if printf '%s' "$body_class" | grep -qE '(^|[ "])(dark:)?(bg|text|from|to|via)-(white|black|zinc|slate|gray|neutral|stone)(-[0-9]{2,3})?([ "]|$)|#[0-9a-fA-F]{3,8}'; then
  fail "$WEB_LAYOUT:$body_n" "the root <body> carries a hardcoded color utility. It beats the tokenized @layer base rule, so the page ground stops following the brand: that is exactly how light mode became #fff and dark mode became neutral zinc (#5306). Remove it — the token rule already sets the ground."
fi

# ── D. both brand fonts load, and the type tokens point at them ──────────────
grep -q 'next/font/google' "$WEB_LAYOUT" ||
  fail "$WEB_LAYOUT" "no next/font import. PRODUCT.md Principle 4 commits to one font pair (Sora + JetBrains Mono); without a loader the app renders in whatever ui-sans-serif resolves to per-OS."
for font in Sora JetBrains_Mono; do
  grep -q "$font" "$WEB_LAYOUT" ||
    fail "$WEB_LAYOUT" "does not load $font. PRODUCT.md Principle 4 names both halves of the pair; loading one is not the pair."
done
grep -qE '^\s*--font-sans:.*--font-sora' "$WEB_GLOBALS" ||
  fail "$WEB_GLOBALS" "--font-sans does not reference --font-sora, so the loaded UI font is never used."
grep -qE '^\s*--font-mono:.*--font-jetbrains' "$WEB_GLOBALS" ||
  fail "$WEB_GLOBALS" "--font-mono does not reference --font-jetbrains, so the loaded code font is never used."

# ── E. the ratchet ───────────────────────────────────────────────────────────
# ⚠️ THIS NUMBER MAY ONLY GO DOWN. It is not a target to keep meeting — it is a
# ceiling that drops every time a component is converted to tokens. Raising it
# to make a build pass re-opens the exact hole this gate closes.
HARDCODED_CEILING=1118

NEUTRAL_RE='\b(bg|text|border|ring|fill|stroke|from|to|via|divide|placeholder|decoration|outline|caret|accent)-(white|black|zinc|slate|gray|neutral|stone)(-[0-9]{2,3})?\b'
hardcoded="$(git ls-files -- "$WEB_SRC/*.tsx" "$WEB_SRC/*.ts" 2>/dev/null | xargs -r grep -InoE "$NEUTRAL_RE" 2>/dev/null | wc -l | tr -d ' ')"

# Vacuity floor: a pattern that matches nothing would report a triumphant zero.
if [ "$hardcoded" -eq 0 ]; then
  die "the hardcoded-utility scan matched NOTHING across $WEB_SRC. On a surface with a four-figure count that is a broken pattern, not a clean tree — and it would read as the strongest possible pass."
fi

echo "  code tokens:  ${#CODE_TOKENS[@]} defined once, in $BRAND_CSS"
echo "  hardcoded:    $hardcoded neutral utilities in $WEB_SRC (ceiling $HARDCODED_CEILING)"

if [ "$hardcoded" -gt "$HARDCODED_CEILING" ]; then
  fail "$WEB_SRC" "hardcoded neutral utilities went UP: $hardcoded > $HARDCODED_CEILING. Use the semantic tokens (bg-background, text-foreground, bg-muted, border-border, and bg-code-* for code panes) instead of zinc/slate/gray. Do not raise HARDCODED_CEILING in scripts/check-web-brand-tokens.sh — it is a ceiling that only drops."
elif [ "$hardcoded" -lt "$HARDCODED_CEILING" ]; then
  echo "  ↓ $((HARDCODED_CEILING - hardcoded)) fewer than the ceiling — lower HARDCODED_CEILING to $hardcoded in scripts/check-web-brand-tokens.sh to lock the gain in."
fi

if [ "$FINDINGS" -gt 0 ]; then
  echo "" >&2
  echo "FAIL: $FINDINGS brand-token violation(s)." >&2
  exit 1
fi
echo "check-web-brand-tokens.sh: the product surface follows its brand tokens."
