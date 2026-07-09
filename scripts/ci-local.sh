#!/usr/bin/env bash
# ci-local.sh — token-cheap local mirror of the required `ci` PR gate.
#
# WHY THIS EXISTS
#   `/ci` used to run ~16 gates as ~16 separate shell calls, each streaming
#   full stdout into the agent's context. Verbose test output (especially on
#   failure) dominated the token cost, and the agent loop re-bills the whole
#   accumulated context on every step. This wrapper runs every gate, redirects
#   each one's output to its own logfile under .ci-local/, and prints ONLY a
#   compact PASS/FAIL table plus the tail of any FAILED gate. One small tool
#   result instead of twenty large ones. Run it from a subagent (see
#   .claude/commands/ci.md) to keep even that out of the main thread.
#
# WHAT IT MIRRORS
#   The required `ci` GitHub check (.github/workflows/ci.yml: drift + lint +
#   type + build's openapi-drift + test-others) PLUS the api test suite. It is
#   a SUPERSET of the old /ci list — it adds the 8 drift gates real CI runs
#   that the old /ci skipped (dockerfile-workspace, dockerfile-bun-pins,
#   plugin-count, enforcement-parity, migration-rename-discipline, ee-imports,
#   no-admin-plugin, no-legacy-connections-sql, auth-md-parity, the adversarial
#   __tests__ fixtures, unpublished-versions), so you stop finding them only
#   after a push. It does NOT run the GitHub-only checks (Deploy Validation,
#   Analyze/CodeQL, Symlink Stub Build) or the heavy `bun run build` web build.
#
# SCHEDULE (race- and flake-safe, not max-parallel)
#   Stage 0  serial    `bun run type` — the ONLY gate that writes SDK dist/.
#                      Runs alone first so nothing reads a half-written dist/.
#   Stage 1  parallel  lint + lint:type-aware + syncpack + ~22 read-only
#                      drift/check scripts.
#                      None touch dist/, so they fan out safely (CI_LOCAL_JOBS).
#   Stage 2  serial    `bun run test` ALONE. The full suite flakes under CPU
#                      contention on WSL2, so it gets the machine to itself.
#
# ENV TOGGLES
#   CI_LOCAL_JOBS=N        Stage-1 concurrency (default 6).
#   CI_LOCAL_NO_TEST=1     Skip Stage 2 (gates-only fast pass). RESULT is then
#                          flagged "tests skipped" — never reported as a clean pass.
#   CI_LOCAL_NO_NET=1      Skip the two npm-registry gates (published-symbols,
#                          unpublished-versions) for offline runs.
#   CI_LOCAL_FAIL_TAIL=N   Lines of each failed gate's log to print (default 40).
#   TEST_DATABASE_URL=...  If set, the real-Postgres *-pg.test.ts run (else skip,
#                          exactly as CI's behavior differs from a bare local run).
#
# Exit code: 0 if every run gate passed, 1 otherwise.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/.ci-local"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

JOBS="${CI_LOCAL_JOBS:-6}"
NO_TEST="${CI_LOCAL_NO_TEST:-0}"
NO_NET="${CI_LOCAL_NO_NET:-0}"
FAIL_TAIL="${CI_LOCAL_FAIL_TAIL:-40}"

# BUN_VERSION lives in the workflow — read it at runtime so the Dockerfile-pin
# gate can never drift from CI's expectation.
EXPECTED_BUN="$(grep -E '^\s*BUN_VERSION:' .github/workflows/ci.yml | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"

# Ordered record of every gate we ran, parallel to STATUS/SECS.
GATE_NAMES=()

now() { date +%s; }

# ---- gate bodies that need shell operators / env (plain scripts run inline) ----
g_type()             { bun run type; }
g_lint()             { bun run lint; }
g_lint_type_aware()  { bun run lint:type-aware; }
g_syncpack()         { bun x syncpack lint; }
g_template_drift()   { SKIP_SYNCPACK=1 bash scripts/check-template-drift.sh; }
g_openapi_drift()    { bash scripts/check-openapi-drift.sh; }
g_auth_md_parity()   { ( cd packages/api && bun scripts/check-auth-md-discovery-parity.ts ); }
g_published_symbols(){ bun run scripts/check-published-symbols.ts; }
g_unpublished()      { bun scripts/check-unpublished-versions.ts; }
g_test()             { bun run test; }

g_dockerfile_pins() {
  local expected="$1" errors=0 f actual
  if [ -z "$expected" ]; then
    echo "ERROR: could not read BUN_VERSION from .github/workflows/ci.yml"
    return 1
  fi
  while IFS= read -r f; do
    grep -q 'oven/bun:' "$f" || continue
    actual="$(grep -oE 'oven/bun:[0-9.]+' "$f" | head -1 | cut -d: -f2)"
    if [ "$actual" != "$expected" ]; then
      echo "ERROR: $f pins bun $actual, expected $expected"
      errors=$((errors + 1))
    fi
  done < <(find . -name Dockerfile -not -path './.git/*' -not -path './node_modules/*')
  [ "$errors" -eq 0 ] && echo "All Dockerfiles pin bun $expected"
  [ "$errors" -eq 0 ]
}

g_gate_fixtures() {
  # Adversarial fixtures that test the drift gates themselves. Bundled into one
  # table row — they rarely fail for an app PR and only matter when a gate
  # script changes.
  local rc=0 t
  for t in scripts/__tests__/*.test.sh; do
    echo ":: $t"
    bash "$t" || rc=1
  done
  return "$rc"
}

# run_fg <name> <fn-or-cmd...> — run a gate in the foreground (Stage 0 / 2),
# capturing log + exit + seconds the same way the parallel launcher does.
run_fg() {
  local name="$1"; shift
  local start; start="$(now)"
  "$@" >"$LOG_DIR/$name.log" 2>&1
  echo "$?" >"$LOG_DIR/$name.exit"
  echo "$(( $(now) - start ))" >"$LOG_DIR/$name.secs"
  GATE_NAMES+=("$name")
}

# launch <name> <fn-or-cmd...> — start a gate in the background with throttling.
launch() {
  local name="$1"; shift
  GATE_NAMES+=("$name")
  (
    local start; start="$(now)"
    "$@" >"$LOG_DIR/$name.log" 2>&1
    echo "$?" >"$LOG_DIR/$name.exit"
    echo "$(( $(now) - start ))" >"$LOG_DIR/$name.secs"
  ) &
  # Throttle: block while the running-job count is at the cap.
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n 2>/dev/null || break; done
}

echo "Atlas local CI — mirrors the required \`ci\` gate. Logs: .ci-local/<gate>.log"
[ "$NO_TEST" = "1" ] && echo "  (CI_LOCAL_NO_TEST=1 — Stage 2 test suite skipped)"
[ "$NO_NET" = "1" ]  && echo "  (CI_LOCAL_NO_NET=1 — npm-registry gates skipped)"
if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "  TEST_DATABASE_URL set — real-Postgres *-pg.test.ts WILL run."
else
  echo "  TEST_DATABASE_URL unset — *-pg.test.ts SKIPPED (set it + db:up to exercise)."
fi

# Match CI's `bun install --frozen-lockfile`: catches a stale lockfile and
# guarantees node_modules exists (a worktree/fresh checkout would TS2307 otherwise).
printf '  bun install (frozen) … '
if bun install --frozen-lockfile >"$LOG_DIR/install.log" 2>&1; then
  echo "ok"
else
  echo "FAILED — see .ci-local/install.log"
  tail -n "$FAIL_TAIL" "$LOG_DIR/install.log"
  echo "RESULT: FAIL — dependency install failed; fix the lockfile before gates can run."
  exit 1
fi

# ---- Stage 0: the lone dist/-writer, serial ----
echo "stage 0: type-check + SDK dist build (serial) …"
run_fg type g_type

# ---- Stage 1: read-only gates, parallel ----
echo "stage 1: read-only drift/lint gates (parallel, jobs=$JOBS) …"
launch lint                      g_lint
# Type-aware lint reads the SDK dist/ that Stage 0 just built (tsgolint
# resolves @useatlas/* via "exports" → dist), so it must run after Stage 0 —
# which every Stage-1 gate already does. Read-only; safe to fan out.
launch lint-type-aware           g_lint_type_aware
launch syncpack                  g_syncpack
launch dockerfile-bun-pins       g_dockerfile_pins "$EXPECTED_BUN"
launch dockerfile-workspace      bash scripts/check-dockerfile-workspace.sh
launch railway-watch             bash scripts/check-railway-watch.sh
launch template-drift            g_template_drift
launch security-headers-drift    bash scripts/check-security-headers-drift.sh
launch pricing-parity            bash scripts/check-pricing-parity.sh
launch plugin-count              bash scripts/check-plugin-count.sh
launch enforcement-parity        bash scripts/check-enforcement-parity.sh
launch schema-drift              bash scripts/check-schema-drift.sh
launch migration-rename          bash scripts/check-migration-rename-discipline.sh
launch oauth-helper-drift        bash scripts/check-oauth-helper-drift.sh
launch ee-imports                bash scripts/check-ee-imports.sh
launch twenty-resolver           bash scripts/check-twenty-resolver-imports.sh
launch no-admin-plugin           bash scripts/check-no-admin-plugin.sh
launch no-legacy-connections     bash scripts/check-no-legacy-connections-sql.sh
launch test-discipline           bash scripts/check-test-discipline.sh
launch settings-readers          bash scripts/check-settings-readers.sh
launch saas-env-doc              bash scripts/check-saas-env-doc.sh
launch auth-md-parity            g_auth_md_parity
launch apex-discovery-drift      bash scripts/check-apex-discovery-drift.sh
launch openapi-drift             g_openapi_drift
launch gate-fixtures             g_gate_fixtures
if [ "$NO_NET" != "1" ]; then
  launch published-symbols       g_published_symbols
  launch unpublished-versions    g_unpublished
fi
wait

# ---- Stage 2: full test suite, isolated ----
if [ "$NO_TEST" != "1" ]; then
  echo "stage 2: full test suite (isolated — no parallel load) …"
  run_fg test g_test
fi

# ---- Report ----
echo ""
printf '%-28s %-7s %5s\n' "GATE" "RESULT" "TIME"
printf '%s\n' "------------------------------------------------"

failed=()
for name in "${GATE_NAMES[@]}"; do
  rc="$(cat "$LOG_DIR/$name.exit" 2>/dev/null || echo 1)"
  secs="$(cat "$LOG_DIR/$name.secs" 2>/dev/null || echo '?')"
  if [ "$rc" = "0" ]; then
    printf '%-28s %-7s %4ss\n' "$name" "PASS" "$secs"
  else
    printf '%-28s %-7s %4ss\n' "$name" "FAIL" "$secs"
    failed+=("$name")
  fi
done
printf '%s\n' "------------------------------------------------"

total="${#GATE_NAMES[@]}"
if [ "${#failed[@]}" -eq 0 ]; then
  if [ "$NO_TEST" = "1" ]; then
    echo "RESULT: PASS (tests skipped — Stage 2 not run; not a clean pre-PR pass)"
  else
    echo "RESULT: PASS — all $total gates green."
  fi
  exit 0
fi

echo "RESULT: FAIL — ${#failed[@]} of $total gates failed: ${failed[*]}"
echo ""
for name in "${failed[@]}"; do
  echo "▼ $name  (.ci-local/$name.log — last $FAIL_TAIL lines)"
  tail -n "$FAIL_TAIL" "$LOG_DIR/$name.log" 2>/dev/null | sed 's/^/    /'
  echo ""
done
echo "Full logs: .ci-local/<gate>.log   Re-run one gate, e.g.: bash scripts/check-schema-drift.sh"
echo "Note: a 'type' failure can cascade into openapi-drift/test (incomplete SDK dist) — fix type first."
exit 1
