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
#      oklch(0.165 0.012 158) that ADR-0023 §4 and PRODUCT.md Design Principle 5 both
#      specify as "NOT pure gray". The skip-link on the very next line did it
#      correctly with `focus:bg-background`.
#   2. The SQL pane rendered `dark ? oneDark : oneLight` over `bg-zinc-100`.
#      PRODUCT.md Design Principle 5 makes the code surface fixed: "always-dark terminal
#      windows (--code-*), identical on every surface and mode". It is the hero
#      asset of the light-page/dark-code inversion, and in light mode it was a
#      light grey box.
#   3. Neither brand font was loaded. PRODUCT.md Design Principle 4 commits to "one font
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
#   A2. …and `packages/web` can actually REACH that one copy: its `brand.css` is
#      still the symlink, `globals.css` still imports it, and each `--code-*` is
#      still mapped into the theme as `--color-code-*`. Uniqueness alone was half
#      the property — cut the symlink and A still passed while every code pane
#      lost its ground, which is the #5306 defect arriving through the blind side.
#   B. Those values match the numbers PRODUCT.md states in prose.
#   C. The root <body> carries no color utility at all.
#   D. Both brand fonts load via next/font, and the type tokens point at them.
#   D2. Every file that mounts a syntax highlighter overrides the theme's
#      `fontFamily` on BOTH the pane and the code tag. The Prism themes ship their
#      own Fira Code stack, so D (the fonts load, the tokens reference them) can
#      pass while the panes render in neither.
#   E. ⚠️ A RATCHET, not an absolute rule, on hardcoded neutral utilities in
#      `packages/web/src`. There are ~1100 of them. A zero-tolerance check would
#      need an allowlist longer than the codebase it guards, and an allowlist
#      that large is a findings dump, not a gate. So the count may only go DOWN:
#      a fourth bypass cannot land, and every conversion lowers the ceiling.
#      This is the honest form of the acceptance criterion, and its limits are
#      worth stating: it does not stop someone REPLACING a tokenized utility with
#      a hardcoded one of the same count, it is one global number rather than
#      per-file, and it reads only `.ts`/`.tsx` — a hardcoded neutral in a `.css`
#      file is outside it. A, C, D and D2 do not have those gaps, on the surfaces
#      that matter most.
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
# ⚠️ RESOLVED ONCE, AND NEVER COMPARED EMPTY-TO-EMPTY. `readlink -f` is absent
# on BSD before macOS 12.3 and on busybox/minimal containers. Both substitutions
# then return "", `[ "" = "" ]` is TRUE, every candidate is skipped, and check A
# silently becomes a no-op while the gate prints its full success banner — a
# green run whose success line is false, on exactly the machines ci-local.sh is
# run from by hand. An unresolvable brand.css is now exit 2, not a pass.
BRAND_REAL="$(readlink -f "$BRAND_CSS" 2>/dev/null || true)"
[ -n "$BRAND_REAL" ] || die "readlink -f cannot resolve $BRAND_CSS (is 'readlink -f' available here?). Every symlink comparison below would compare empty to empty and skip its subject, so this gate would pass having checked nothing."

while IFS= read -r hit; do
  file="${hit%%:*}"
  [ "$file" = "$BRAND_CSS" ] && continue
  # brand.css is symlinked into each app; the symlink IS the one copy.
  file_real="$(readlink -f "$file" 2>/dev/null || true)"
  [ -n "$file_real" ] && [ "$file_real" = "$BRAND_REAL" ] && continue
  fail "$file" "redefines a --code-* token. There is one code surface: define it in $BRAND_CSS and reference it here. Two correct-looking copies drifting apart is what \"identical on every surface and mode\" forbids — and is how packages/web ended up with no code tokens at all while apps/www had them."
# -z/-0 and -H: a tracked path containing a space would otherwise be word-split
# by xargs (the resulting grep error is swallowed by 2>/dev/null, so the file is
# never scanned and the gate reports one definition), and without -H a batch that
# narrows to a single file prints no filename, making `${hit%%:*}` a line number.
done < <(git ls-files -z -- '*.css' 2>/dev/null | xargs -0 -r grep -HInE '(^|[;{[:space:]])--code-(bg|chrome|well|fg|muted|border)[[:space:]]*:' 2>/dev/null)

# ── A2. …and packages/web actually REACHES them ──────────────────────────────
# ⚠️ "Defined once" is only half the property. A checks that no app holds a
# SECOND copy; it says nothing about whether this app can see the FIRST one. Cut
# the symlink — or let it decay into a stale plain-file copy that happens to
# carry no `--code-*` line — and A still passes (one definition, in brand.css),
# B passes, C and D pass, the ratchet passes, and the gate reports the product
# surface as conformant while `bg-code-bg` resolves to nothing and every code
# pane loses its ground. That is the #5306 defect class arriving through the
# gate's blind side, so the link and the import are checked directly.
WEB_BRAND_LINK="packages/web/brand.css"
web_link_real="$(readlink -f "$WEB_BRAND_LINK" 2>/dev/null || true)"
if [ -z "$web_link_real" ] || [ "$web_link_real" != "$BRAND_REAL" ]; then
  fail "$WEB_BRAND_LINK" "is not the shared $BRAND_CSS (it is missing, or it is a copy rather than the symlink). $WEB_GLOBALS imports it for the --code-* values; without it they are undefined and every code pane renders with no ground."
fi
grep -qE '^@import[[:space:]]+"[^"]*brand\.css"' "$WEB_GLOBALS" ||
  fail "$WEB_GLOBALS" "no @import of brand.css. The --code-* values live there; nothing else defines them for this app."
# The @theme mapping is what turns a token into a utility: no --color-code-bg,
# no `bg-code-bg`, and the class silently renders as nothing.
for tok in "${CODE_TOKENS[@]}"; do
  name="${tok#--code-}"
  grep -qE "^[[:space:]]*--color-code-${name}:[[:space:]]*var\(--code-${name}\)" "$WEB_GLOBALS" ||
    fail "$WEB_GLOBALS" "does not map --color-code-${name} to var(--code-${name}), so the bg-code-${name} / text-code-${name} utility does not exist and any component using it renders unstyled."
done

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

body_n="$(grep -nE '^[[:space:]]*<body([[:space:]>]|$)' "$WEB_LAYOUT" | head -1 | cut -d: -f1)"
[ -n "$body_n" ] || die "no <body> element found in $WEB_LAYOUT — this gate cannot check the page ground."
# ⚠️ THE WHOLE TAG, NOT THE LINE THAT OPENS IT. `<body>` is one line today, but
# `<html>` in this same file is already written across five — so one added
# attribute, or any formatter reflow, puts the className on its own line. A
# line-based match would then read the bare `<body`, find no color utility, and
# pass `bg-white … dark:bg-zinc-950` green: the exact defect this check exists to
# catch, defeated by a line break. The @layer base check above already flattens
# newlines for the same reason; this one has to as well.
body_tag="$(tail -n +"$body_n" "$WEB_LAYOUT" | tr '\n' ' ' | grep -oE '^[[:space:]]*<body[^>]*>' | head -1)"
[ -n "$body_tag" ] || die "found <body> at $WEB_LAYOUT:$body_n but could not read the tag through its closing '>' — this gate cannot check the page ground."
if printf '%s' "$body_tag" | grep -qE '(^|[ "])(dark:)?(bg|text|from|to|via)-(white|black|zinc|slate|gray|neutral|stone)(-[0-9]{2,3})?([ "]|$)|#[0-9a-fA-F]{3,8}'; then
  fail "$WEB_LAYOUT:$body_n" "the root <body> carries a hardcoded color utility. It beats the tokenized @layer base rule, so the page ground stops following the brand: that is exactly how light mode became #fff and dark mode became neutral zinc (#5306). Remove it — the token rule already sets the ground."
fi

# ── C2. the SCAFFOLDED root layout owns no color either ──────────────────────
# ⚠️ C reads packages/web's layout only, so `create-atlas/overrides/layout.tsx`
# — the root layout every `create-atlas` nextjs-standalone project ships — kept
# `bg-white … dark:bg-zinc-950` through all of #5306. prepare-templates.sh
# copies packages/web's globals.css into that template verbatim, so the
# scaffolded app inherits the tokenized ground and then overrides it, exactly as
# the product did. It must also LOAD the fonts that CSS references: an undefined
# `--font-sora` inside var() with no fallback invalidates the whole font-family
# declaration, taking `ui-sans-serif, system-ui` down with it.
SCAFFOLD_LAYOUT="create-atlas/overrides/layout.tsx"
if [ -f "$SCAFFOLD_LAYOUT" ]; then
  sc_n="$(grep -nE '^[[:space:]]*<body([[:space:]>]|$)' "$SCAFFOLD_LAYOUT" | head -1 | cut -d: -f1)"
  if [ -n "$sc_n" ]; then
    sc_tag="$(tail -n +"$sc_n" "$SCAFFOLD_LAYOUT" | tr '\n' ' ' | grep -oE '^[[:space:]]*<body[^>]*>' | head -1)"
    if printf '%s' "$sc_tag" | grep -qE '(^|[ "])(dark:)?(bg|text|from|to|via)-(white|black|zinc|slate|gray|neutral|stone)(-[0-9]{2,3})?([ "]|$)|#[0-9a-fA-F]{3,8}'; then
      fail "$SCAFFOLD_LAYOUT:$sc_n" "the scaffolded root <body> carries a hardcoded color utility. prepare-templates.sh ships this file as the root layout of every create-atlas project, over a copy of packages/web's tokenized globals.css — so the fix in packages/web does not reach a single scaffolded app."
    fi
  fi
  for font in Sora JetBrains_Mono; do
    grep -qE "(^|[^A-Za-z0-9_])${font}\(" "$SCAFFOLD_LAYOUT" ||
      fail "$SCAFFOLD_LAYOUT" "does not CALL ${font}(...). It ships alongside a copy of packages/web's globals.css, which resolves --font-sans through var(--font-sora); undefined, that makes the whole font-family declaration invalid and the scaffolded app falls back to the browser default."
  done
fi

# ── D. both brand fonts load, and the type tokens point at them ──────────────
grep -q 'next/font/google' "$WEB_LAYOUT" ||
  fail "$WEB_LAYOUT" "no next/font import. PRODUCT.md Design Principle 4 commits to one font pair (Sora + JetBrains Mono); without a loader the app renders in whatever ui-sans-serif resolves to per-OS."
# ⚠️ THE LOADER CALL, NOT THE WORD. `grep -q Sora layout.tsx` matches the comment
# block above <html> that NAMES the pair, so swapping `Sora({…})` for `Inter({…})`
# left this green while the product rendered in Inter — the gate certifying a
# brand pair that is not loaded. Anchor on the call.
for font in Sora JetBrains_Mono; do
  grep -qE "(^|[^A-Za-z0-9_])${font}\(" "$WEB_LAYOUT" ||
    fail "$WEB_LAYOUT" "does not CALL ${font}(...) as a next/font loader (a comment naming it is not loading it). PRODUCT.md Design Principle 4 names both halves of the pair; loading one is not the pair."
done
grep -qE '^\s*--font-sans:.*--font-sora' "$WEB_GLOBALS" ||
  fail "$WEB_GLOBALS" "--font-sans does not reference --font-sora, so the loaded UI font is never used."
grep -qE '^\s*--font-mono:.*--font-jetbrains' "$WEB_GLOBALS" ||
  fail "$WEB_GLOBALS" "--font-mono does not reference --font-jetbrains, so the loaded code font is never used."

# ⚠️ D2. A LOADED FONT THE CODE PANES DO NOT USE. The syntax-highlighter themes
# ship their own `fontFamily` — oneDark hardcodes `"Fira Code", "Fira Mono",
# Menlo, Consolas, …` on the <pre> AND on the inner <code> — so a pane that
# overrides only `background` renders in Fira Code no matter what --font-mono
# says. D above passes in that state: the fonts load and the tokens reference
# them, and the panes still ignore both. apps/www sets `font-family:
# var(--font-mono)` on its code, so the result was the product and the marketing
# site showing the same pane in two typefaces — the drift "identical on every
# surface and mode" forbids. Every file that mounts a highlighter must say so.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  hits="$(grep -cF 'fontFamily: "var(--font-mono)"' "$f" 2>/dev/null || true)"
  # Two: the pane's own style and the code tag's. Overriding one leaves the other
  # on the theme's font, which is how the inner block ends up mismatched.
  [ "${hits:-0}" -ge 2 ] ||
    fail "$f" "mounts a syntax highlighter but sets fontFamily: \"var(--font-mono)\" $hits time(s), not 2 (the pane style and the code-tag props). The Prism theme's own Fira Code stack wins wherever it is not overridden, so the pane stops using the brand mono font PRODUCT.md Design Principle 4 commits to."
  # ⚠️ THE HIGHLIGHTED BRANCH IS THE ONE USERS SEE, and it was the least guarded
  # thing in this PR. `#5306`'s headline defect — `dark ? oneDark : oneLight` over
  # a mode-following ground — lives entirely inside it. `oneLight` is a JS
  # identifier, so the ratchet cannot see it; the fallback <pre> is a different
  # element, so the unit test cannot see it. Measured: stripping
  # `background: "var(--code-bg)"` and reinstating oneLight left every test green
  # and this gate at exit 0. Both halves are now named here.
  grep -qF 'background: "var(--code-bg)"' "$f" ||
    fail "$f" "mounts a syntax highlighter without background: \"var(--code-bg)\" on the pane style. The Prism theme paints its own near-black, so the pane stops being the brand's code surface — and nothing else can see it: oneLight is an identifier the ratchet cannot count, and the fallback <pre> is a different element from the one under test."
  # ⚠️ CODE, NOT COMMENTS. sql-block.tsx's header legitimately quotes the old
  # `dark ? oneDark : oneLight` as the defect it is describing, and a doc naming
  # what was removed is not the thing being removed — the sibling gate strips
  # comments for exactly this reason.
  if printf '%s\n' "$(sed -E -e 's@/\*.*@@' -e 's@(^|[^:])//.*@\1@' "$f" | grep -vE '^[[:space:]]*(//|\*|/\*)')" | grep -qE '\boneLight\b'; then
    fail "$f" "references oneLight. PRODUCT.md Design Principle 5 makes the code surface the one thing that does NOT follow the mode — \"always-dark terminal windows (--code-*), identical on every surface and mode\". A light theme variant is #5306 itself: in light mode the pane rendered as light grey on white."
  fi
done < <(git ls-files -z -- "$WEB_SRC/*.tsx" 2>/dev/null | xargs -0 -r grep -lF 'react-syntax-highlighter' 2>/dev/null)

# ── E. the ratchet ───────────────────────────────────────────────────────────
# ⚠️ THIS NUMBER MAY ONLY GO DOWN. It is not a target to keep meeting — it is a
# ceiling that drops every time a component is converted to tokens. Raising it
# to make a build pass re-opens the exact hole this gate closes.
HARDCODED_CEILING=1117

NEUTRAL_RE='\b(bg|text|border|ring|fill|stroke|from|to|via|divide|placeholder|decoration|outline|caret|accent)-(white|black|zinc|slate|gray|neutral|stone)(-[0-9]{2,3})?\b'
# TEST FILES ARE EXCLUDED, and the reason is not leniency: this ratchet is about
# the RENDERED product surface, and a test asserting that `bg-zinc-100` is absent
# has to name `bg-zinc-100`. The unit test added with this gate does exactly that
# — it is the falsifier for the SQL pane — and counting it would make the gate
# punish its own measurement.
hardcoded="$(git ls-files -z -- "$WEB_SRC/*.tsx" "$WEB_SRC/*.ts" 2>/dev/null |
  grep -zvE '(^|/)__tests__/|\.test\.(ts|tsx)$' |
  xargs -0 -r grep -HInoE "$NEUTRAL_RE" 2>/dev/null | wc -l | tr -d ' ')"

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
