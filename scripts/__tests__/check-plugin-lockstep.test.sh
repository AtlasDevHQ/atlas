#!/usr/bin/env bash
# Adversarial fixture suite for scripts/check-plugin-lockstep.ts (#4880).
#
# The gate exists because three lists in deploy/api/Dockerfile — the prod-deps
# `--filter` scope, the symlink-rebuild loop, and the runtime-import assertion
# loop — must agree with `plugins[]` in deploy/api/atlas.config.ts, and were
# previously held in lockstep by comments alone. A gate that can only go green
# is worthless here, so this suite proves each disagreement it is supposed to
# catch actually turns it red, and that its two legitimate exemptions do not.
#
# Fixtures run against a scaffolded temp tree via PLUGIN_LOCKSTEP_ROOT, then the
# suite ends with a real-repo sanity case.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-plugin-lockstep.ts"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0
TMPDIRS=()
cleanup() { for d in ${TMPDIRS+"${TMPDIRS[@]}"}; do rm -rf "$d"; done; }
trap cleanup EXIT

# scaffold <config-plugins-csv> <filter-csv> <symlink-csv> <assert-csv>
#
# Builds a minimal tree: an atlas.config.ts that imports+invokes each plugin in
# arg 1, a Dockerfile carrying the three lists, and a plugins/<n>/package.json
# per mentioned plugin. Names are plugin DIRECTORIES; package names are derived
# as @useatlas/<dir>, matching the real repo.
scaffold() {
  local cfg="$1" filters="$2" symlinks="$3" asserts="$4"
  local tmp p
  tmp="$(mktemp -d)"
  TMPDIRS+=("$tmp")
  mkdir -p "$tmp/deploy/api" "$tmp/packages/api"

  # @atlas/api with no plugin deps, so --filter is the only way to satisfy scope
  # (except where a case deliberately adds one).
  printf '{ "name": "@atlas/api", "dependencies": { "hono": "^4.0.0" } }\n' \
    > "$tmp/packages/api/package.json"

  # atlas.config.ts
  {
    for p in ${cfg//,/ }; do
      printf 'import { %sPlugin } from "./plugins/%s/src/index";\n' "$p" "$p"
    done
    printf 'export default defineConfig({\n  plugins: [\n'
    for p in ${cfg//,/ }; do printf '    %sPlugin({}),\n' "$p"; done
    printf '  ],\n});\n'
  } > "$tmp/deploy/api/atlas.config.ts"

  # Dockerfile with the three lists
  {
    printf 'FROM base AS prod-deps\n'
    printf 'RUN bun install --frozen-lockfile --production \\\n'
    printf "      --filter='@atlas/api' \\\\\n"
    for p in ${filters//,/ }; do printf "      --filter='@useatlas/%s' \\\\\n" "$p"; done
    printf '      --ignore-scripts\n'
    printf 'RUN for p in %s; do \\\n' "${symlinks//,/ }"
    printf '      ln -sfn /app/packages/plugin-sdk /app/plugins/$p/node_modules/@useatlas/plugin-sdk; \\\n'
    printf '    done\n'
    printf 'RUN set -e; \\\n'
    printf '    for p in %s; do \\\n' "${asserts//,/ }"
    printf "      (cd /app/plugins/\$p && bun -e \"await import('/app/plugins/\$p/src/index');\"); \\\\\n"
    printf '    done\n'
  } > "$tmp/deploy/api/Dockerfile"

  # plugin manifests for every dir named anywhere
  for p in ${cfg//,/ } ${filters//,/ } ${symlinks//,/ } ${asserts//,/ }; do
    mkdir -p "$tmp/plugins/$p"
    printf '{ "name": "@useatlas/%s" }\n' "$p" > "$tmp/plugins/$p/package.json"
  done

  printf '%s' "$tmp"
}

# expect <expected-rc> <label> <tree> [grep-for]
expect() {
  local want="$1" label="$2" tree="$3" needle="${4:-}"
  local out rc
  set +e
  out="$(PLUGIN_LOCKSTEP_ROOT="$tree" bun "$SCRIPT" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne "$want" ]; then
    echo "  FAIL: $label — expected rc=$want, got rc=$rc"
    echo "$out" | sed 's/^/        /' | head -6
    FAIL=$((FAIL + 1))
    return
  fi
  if [ -n "$needle" ] && ! grep -q -- "$needle" <<<"$out"; then
    echo "  FAIL: $label — rc correct but message missing '$needle'"
    echo "$out" | sed 's/^/        /' | head -6
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  ok:   $label"
  PASS=$((PASS + 1))
}

echo "== scripts/check-plugin-lockstep.ts adversarial fixtures =="

# --- green: all three lists agree ---
expect 0 "all three lists agree" \
  "$(scaffold "chat,clickhouse" "chat,clickhouse" "chat,clickhouse" "chat,clickhouse")"

# --- the scenario the gate exists for: a plugin added to config only ---
expect 1 "boot-loaded plugin absent from every Dockerfile list" \
  "$(scaffold "chat,clickhouse,duckdb" "chat,clickhouse" "chat,clickhouse" "chat,clickhouse")" \
  "runtime-import assertion loop"

# --- each list independently ---
expect 1 "missing from --filter only" \
  "$(scaffold "chat,clickhouse" "chat" "chat,clickhouse" "chat,clickhouse")" \
  "prod-deps --filter list"

expect 1 "missing from symlink-rebuild loop only" \
  "$(scaffold "chat,clickhouse" "chat,clickhouse" "chat" "chat,clickhouse")" \
  "symlink-rebuild loop"

expect 1 "missing from assertion loop only" \
  "$(scaffold "chat,clickhouse" "chat,clickhouse" "chat,clickhouse" "chat")" \
  "runtime-import assertion loop"

# --- stale entry: assertion loop names a plugin config no longer loads ---
expect 1 "stale entry in assertion loop" \
  "$(scaffold "chat" "chat" "chat" "chat,mysql")" \
  "no longer boot-loads it"

# --- legitimate exemptions must NOT trip the gate ---
# 1. extra entries in the symlink loop are deliberate (lazy e2b/daytona, salesforce)
expect 0 "extra entries in symlink loop are allowed" \
  "$(scaffold "chat" "chat" "chat,e2b,daytona,salesforce" "chat")"

# 2. a plugin that is a dependency of @atlas/api needs no --filter entry
TREE_DEP="$(scaffold "chat" "" "chat" "chat")"
printf '{ "name": "@atlas/api", "dependencies": { "@useatlas/chat": "workspace:*" } }\n' \
  > "$TREE_DEP/packages/api/package.json"
expect 0 "@atlas/api dependency needs no --filter entry" "$TREE_DEP"

# --- the gate must fail LOUDLY if its own parsing goes stale ---
TREE_STALE="$(scaffold "chat" "chat" "chat" "chat")"
printf 'export default defineConfig({ plugins: [] });\n' > "$TREE_STALE/deploy/api/atlas.config.ts"
expect 1 "unparseable atlas.config.ts fails loudly rather than passing vacuously" \
  "$TREE_STALE" "update this guard"

TREE_NOLOOP="$(scaffold "chat" "chat" "chat" "chat")"
grep -v 'await import' "$TREE_NOLOOP/deploy/api/Dockerfile" > "$TREE_NOLOOP/deploy/api/Dockerfile.tmp"
mv "$TREE_NOLOOP/deploy/api/Dockerfile.tmp" "$TREE_NOLOOP/deploy/api/Dockerfile"
expect 1 "a removed assertion loop fails loudly rather than passing vacuously" \
  "$TREE_NOLOOP" "update this guard"

# --- real repo sanity ---
expect 0 "real repo passes" "$REPO_ROOT"

echo ""
echo "check-plugin-lockstep fixtures: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
