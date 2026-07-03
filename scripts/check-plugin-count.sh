#!/usr/bin/env bash
# check-plugin-count.sh — CI check that the canonical plugin count is stated
# identically across every marketing/docs surface, and that it matches the
# actual plugins/ directory (#4066).
#
# THE COUNTING RULE (canonical, single source of truth):
#   A "plugin" is a directory under plugins/ whose definePlugin() declares a
#   PluginType via a `types: [...]` array (one of: datasource, context,
#   interaction, action, sandbox). The `obsidian` client app extends Obsidian's
#   own Plugin class and declares no PluginType, so it is excluded — it is a
#   host-app surface, not an Atlas plugin in the catalog sense.
#
# The count is DERIVED here from plugins/ (not hand-maintained), so it stays
# honest as plugins/ grows: add a plugin that declares a PluginType and every
# surface in SURFACES (below) must restate the new total or this gate goes red.
# Every surface embeds the count as human-readable prose rather than importing a
# derived constant — even the .tsx surfaces (the landing comparison table, the
# blog announcement page, and the brand-asset generator), which *could* import TS
# but state the figure as display copy. So all of them are kept in lockstep by
# the same string assertion: each must state exactly "<N> plugins" and carry no
# stale "<other> plugins".
#
# This replaces the formerly hand-counted figure in
# apps/www/src/components/landing/comparison.tsx (previously a recount-on-change
# CLAIM-ACCURACY note) with this enforced derivation.
#
# Run locally: bash scripts/check-plugin-count.sh

set -euo pipefail

# ROOT defaults to the repo root (this script lives in scripts/), so the gate
# runs correctly from any cwd. PLUGIN_COUNT_ROOT overrides it so the adversarial
# fixture suite (scripts/__tests__/check-plugin-count.test.sh) can point the
# same logic at a scaffolded temp tree.
ROOT="${PLUGIN_COUNT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Guard against an empty/unresolvable ROOT: `cd ""` is a silent no-op that would
# leave the gate scanning whatever cwd it was launched from.
if [ -z "$ROOT" ] || ! cd "$ROOT"; then
  echo "check-plugin-count: could not resolve/enter the repo root (ROOT='$ROOT')." >&2
  exit 1
fi

# --- Derive the canonical count from plugins/ -------------------------------
# Count plugin directories whose source declares a `types:` array containing at
# least one PluginType literal (e.g. `types: ["datasource"] as const`). A dir
# with no PluginType (the `obsidian` host app) is excluded by construction.
#
# - grep -z treats each file as one NUL-delimited record, so the `[[:space:]]`
#   and `[^]]` classes span newlines — a `types:` array a formatter has wrapped
#   across lines still matches and is never silently undercounted.
# - The quote class accepts ", ' or ` around the literal so a re-quoted (but
#   still valid) PluginType matches the documented rule, not just Prettier's
#   double-quote default.
PLUGIN_TYPE_RE='types:[[:space:]]*\[[^]]*["'\''`](datasource|context|interaction|action|sandbox)["'\''`]'

count=0
typed_dirs=()
for d in plugins/*/; do
  [ -d "$d" ] || continue
  # A plugin dir with no src/ can't have its PluginType derived — fail loudly
  # rather than letting `grep`'s "No such file" exit silently drop it from the
  # count (a silent undercount would then "correct" every surface to a wrong N).
  if [ ! -d "${d}src" ]; then
    echo "check-plugin-count: ${d} has no src/ directory — cannot derive its PluginType." >&2
    echo "  Update the derivation in scripts/check-plugin-count.sh if the plugin layout changed." >&2
    exit 1
  fi
  # Distinguish a legitimate no-match (grep exit 1 → not a typed plugin) from a
  # read/I-O error (exit >=2 → unreadable path). The latter must fail loudly,
  # never be misread as "not a plugin" and silently undercounted.
  set +e
  grep -rzqE "$PLUGIN_TYPE_RE" "${d}src"
  rc=$?
  # Datasource plugins assembled via the createDatasourcePlugin factory (#4192)
  # declare their PluginType (`types: ["datasource"]`) inside the SDK helper,
  # not in the plugin's own src/, so the PLUGIN_TYPE_RE grep above misses them.
  # The factory produces a datasource-typed plugin by construction, so treat a
  # `createDatasourcePlugin<` / `createDatasourcePlugin(` call site as an
  # equivalent PluginType declaration. Only consulted on a clean no-match
  # (rc==1); a read error (rc>=2) still falls through to the loud-fail branch.
  if [ "$rc" -eq 1 ]; then
    grep -rzqE 'createDatasourcePlugin[[:space:]]*[<(]' "${d}src"
    rc=$?
  fi
  set -e
  case "$rc" in
    0) count=$((count + 1)); typed_dirs+=("$(basename "$d")") ;;
    1) : ;; # no PluginType declared — excluded by construction (e.g. obsidian)
    *) echo "check-plugin-count: grep failed (exit $rc) scanning ${d}src — cannot derive its PluginType." >&2
       echo "  A read error must not be silently undercounted; fix the unreadable path under ${d}src." >&2
       exit 1 ;;
  esac
done

if [ "$count" -eq 0 ]; then
  echo "check-plugin-count: derived a plugin count of 0 — the PluginType detection in this script has broken." >&2
  echo "Expected plugin dirs under plugins/ to declare a \`types: [\"datasource\"|...]\` array. Fix the derivation regex." >&2
  exit 1
fi

N="$count"
echo ":: Canonical plugin count derived from plugins/: ${N} (${typed_dirs[*]})"

# --- Surfaces that must restate the canonical count -------------------------
# Every marketing/docs surface that quotes a plugin count. Each must state
# exactly "<N> plugins" (at least once) and carry no stale "<other> plugins".
# Add a surface here whenever a new one starts quoting the count.
SURFACES=(
  "README.md"
  "apps/www/src/components/landing/comparison.tsx"
  "apps/www/src/app/blog/announcing-atlas/page.tsx"
  "apps/www/public/llms.txt"
  "apps/www/content/social/twitter-launch.md"
  "apps/www/content/social/linkedin-launch.md"
  "apps/docs/content/shared/comparisons/metabase.mdx"
  "apps/docs/content/shared/comparisons/cube.mdx"
  "apps/docs/content/shared/comparisons/thoughtspot.mdx"
  "apps/docs/content/shared/comparisons/vanna.mdx"
  "scripts/generate-brand-assets.tsx"
)

# Matches a quoted count like "24 plugins" or "21+ plugins" (one space), so a
# bare-number check can both confirm the right count and flag a stale one.
COUNT_RE='[0-9]+\+?[[:space:]]plugins'

fail=0
for surface in "${SURFACES[@]}"; do
  if [ ! -f "$surface" ]; then
    echo "check-plugin-count: listed surface not found: $surface" >&2
    echo "  Remove it from SURFACES in scripts/check-plugin-count.sh if it was intentionally deleted/renamed." >&2
    fail=1
    continue
  fi

  # Every distinct "<n>[+] plugins" token in the file must equal exactly "<N>"
  # with no trailing "+". A no-match leaves the loop empty → found_canonical
  # stays 0 and the missing-count branch fires (never a silent skip).
  found_canonical=0
  while IFS= read -r token; do
    [ -n "$token" ] || continue
    num="$(printf '%s' "$token" | grep -oE '[0-9]+\+?')"
    if [ "$num" = "$N" ]; then
      found_canonical=1
    else
      echo "$surface: states \"$token\" but the canonical plugin count is ${N}." >&2
      echo "  Update it to \"${N} plugins\" (derived from plugins/)." >&2
      fail=1
    fi
  done < <(grep -oiE "$COUNT_RE" "$surface" || true)

  if [ "$found_canonical" -eq 0 ]; then
    echo "$surface: does not state the canonical \"${N} plugins\" anywhere." >&2
    echo "  Add/restore the \"${N} plugins\" figure, or drop this file from SURFACES if it no longer quotes a count." >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "Plugin-count parity check FAILED. Canonical count is ${N} (see the counting rule atop scripts/check-plugin-count.sh)." >&2
  exit 1
fi

echo "Plugin-count parity check passed — every surface states the canonical \"${N} plugins\"."
