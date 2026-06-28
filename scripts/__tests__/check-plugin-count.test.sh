#!/usr/bin/env bash
# Adversarial fixture suite for scripts/check-plugin-count.sh (#4066).
#
# Locks in the gate's two jobs against silent regression:
#   1. DERIVATION from plugins/ — counts dirs that declare a PluginType, excludes
#      a typeless host-app dir, tolerates a formatter-wrapped multiline `types:`
#      array, fails loudly on a plugin dir with no src/, and refuses a 0 count.
#   2. SURFACE PARITY — passes when every surface states the derived "<N> plugins",
#      fails on a stale count, a missing count, and a "<N>+ plugins" variant.
#
# The fixtures are pointed at a scaffolded temp tree via PLUGIN_COUNT_ROOT, so
# they never touch the real repo; the suite then ends with one real-repo sanity
# case that runs the gate against the actual tree (default ROOT). The SURFACES
# list is read out of the script under test (not duplicated here), so the
# scaffold can't drift from the gate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-plugin-count.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

# Read the gate's authoritative surface list so this suite stays in lockstep
# with it (a surface added to the script is scaffolded here automatically).
mapfile -t SURFACES < <(sed -n '/^SURFACES=(/,/^)/p' "$SCRIPT" | grep -oE '"[^"]+"' | tr -d '"')
if [ "${#SURFACES[@]}" -eq 0 ]; then
  echo "::error::could not read SURFACES from $SCRIPT — has its format changed?" >&2
  exit 2
fi

PASS=0
FAIL=0

# Scaffold a temp tree: $1 typed plugin dirs (each a single-line `types:`
# declaration) and every surface stating "$1 plugins". Returns the tree path.
scaffold() {
  local n="$1" tmp i s
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/plugins"
  for ((i = 1; i <= n; i++)); do
    mkdir -p "$tmp/plugins/p$i/src"
    printf 'export default definePlugin({ types: ["datasource"] as const });\n' \
      > "$tmp/plugins/p$i/src/index.ts"
  done
  for s in "${SURFACES[@]}"; do
    mkdir -p "$tmp/$(dirname "$s")"
    printf 'intro line\n%s plugins power Atlas.\n' "$n" > "$tmp/$s"
  done
  printf '%s' "$tmp"
}

# run_case EXPECTED NAME TREE — run the gate against TREE, assert pass/fail, clean up.
run_case() {
  local expected="$1" name="$2" tree="$3" status=0
  # Refuse to run against an unbuilt fixture: an empty/missing tree would make
  # the gate fall back to the real repo (ROOT's `:-` treats "" as unset), which
  # would silently turn a pass-case into a green no-op against the live tree.
  if [ -z "$tree" ] || [ ! -d "$tree" ]; then
    echo "  FAIL $name — scaffold produced no usable tree (got '$tree')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  (PLUGIN_COUNT_ROOT="$tree" bash "$SCRIPT" >/dev/null 2>&1) || status=$?
  if { [ "$expected" = pass ] && [ "$status" -eq 0 ]; } ||
     { [ "$expected" = fail ] && [ "$status" -ne 0 ]; }; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tree"
}

# --- derivation -------------------------------------------------------------

# Clean tree: 3 typed plugins, every surface says "3 plugins".
run_case pass "clean tree — derived count matches every surface" "$(scaffold 3)"

# A typeless host-app dir (the `obsidian` case) is excluded from the count.
tree="$(scaffold 3)"
mkdir -p "$tree/plugins/obsidian/src"
printf 'export default class Foo extends Plugin {}\n' > "$tree/plugins/obsidian/src/index.ts"
run_case pass "typeless dir is excluded (count stays 3)" "$tree"

# A formatter-wrapped multiline `types:` array must still be counted: adding it
# makes the derived count 4, so the surfaces (saying "4") stay in parity.
tree="$(scaffold 4)"
rm -rf "$tree/plugins/p4"
mkdir -p "$tree/plugins/p4/src"
cat > "$tree/plugins/p4/src/index.ts" <<'EOF'
export default definePlugin({
  types: [
    "context",
  ] as const,
});
EOF
run_case pass "multiline types: array is counted (locks the grep -z fix)" "$tree"

# A plugin dir with no src/ can't have its PluginType derived → fail loudly,
# never a silent undercount.
tree="$(scaffold 3)"
mkdir -p "$tree/plugins/no_src"
run_case fail "plugin dir with no src/ fails loudly" "$tree"

# Zero typed plugins (a dir with src/ but no PluginType) trips the 0-count guard.
tree="$(scaffold 0)"
mkdir -p "$tree/plugins/untyped/src"
printf 'export default definePlugin({});\n' > "$tree/plugins/untyped/src/index.ts"
run_case fail "zero typed plugins is rejected" "$tree"

# --- surface parity ---------------------------------------------------------

# Stale count (below derived): one surface lags at "2 plugins" while count is 3.
tree="$(scaffold 3)"
printf 'intro line\n2 plugins power Atlas.\n' > "$tree/${SURFACES[0]}"
run_case fail "stale count below derived is caught" "$tree"

# Over-count (above derived): a surface bumped to "4 plugins" with no new plugin.
tree="$(scaffold 3)"
printf 'intro line\n4 plugins power Atlas.\n' > "$tree/${SURFACES[0]}"
run_case fail "over-count above derived is caught" "$tree"

# A correct mention must not mask a stale sibling mention in the same surface.
tree="$(scaffold 3)"
printf 'intro line\n3 plugins today (was 2 plugins last year).\n' > "$tree/${SURFACES[0]}"
run_case fail "a stale mention alongside the correct one is caught" "$tree"

# Missing count: a surface no longer states any "<n> plugins".
tree="$(scaffold 3)"
printf 'intro line\nAtlas has a rich plugin ecosystem.\n' > "$tree/${SURFACES[0]}"
run_case fail "missing count on one surface is caught" "$tree"

# "<N>+ plugins" variant must be rejected (the canonical form is bare "<N>").
tree="$(scaffold 3)"
printf 'intro line\n3+ plugins power Atlas.\n' > "$tree/${SURFACES[0]}"
run_case fail "an N+ variant is rejected" "$tree"

# A listed surface missing entirely fails loudly.
tree="$(scaffold 3)"
rm -f "$tree/${SURFACES[0]}"
run_case fail "a missing surface file fails loudly" "$tree"

# --- real tree sanity -------------------------------------------------------
# The actual repo must pass with the default (un-overridden) ROOT.
real_status=0
(bash "$SCRIPT" >/dev/null 2>&1) || real_status=$?
if [ "$real_status" -eq 0 ]; then
  echo "  ok   real repo passes the gate (expected pass)"
  PASS=$((PASS + 1))
else
  echo "  FAIL real repo does not pass the gate — status=$real_status" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "check-plugin-count.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
