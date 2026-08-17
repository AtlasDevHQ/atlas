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
#   result instead of twenty large ones. Launch it in the background and poll
#   .ci-local/RESULT (the launch-and-watch protocol in .claude/commands/ci.md)
#   — completion is observable from disk, never dependent on an agent hand-off.
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
#   Image Scan, Analyze/CodeQL, ee-stub-build) or the heavy `bun run build`
#   web build.
#
# SCHEDULE (race- and flake-safe, not max-parallel)
#   Stage 0  serial    `bun run type` — the ONLY gate that writes SDK dist/.
#                      Runs alone first so nothing reads a half-written dist/.
#   Stage 1  parallel  lint + lint:type-aware + syncpack + ~30 read-only
#                      drift/check scripts (33 launches, 2 of them net-gated).
#                      None touch dist/, so they fan out safely (CI_LOCAL_JOBS).
#   Stage 2  serial    the tree-WRITING gates (gate-fixtures, mutation-tables).
#                      Both rewrite sources in place — `mutate.ts` per mutation,
#                      and several adversarial suites per fixture — so neither can
#                      share Stage 1 with ~30 scanners reading those files.
#   Stage 3  serial    `bun run test` ALONE. The full suite flakes under CPU
#                      contention on WSL2, so it gets the machine to itself.
#
# ENV TOGGLES
#   CI_LOCAL_JOBS=N        Stage-1 concurrency (default 6).
#   CI_LOCAL_NO_TEST=1     Skip Stage 3 (gates-only fast pass). RESULT is then
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

# ⚠️ **TAKE THE WHOLE PROCESS TREE DOWN ON AN INTERRUPT. Killing this script
# alone leaves its children running, and one of them REWRITES SOURCE FILES.**
#
# Measured, twice in one session: `pkill -f ci-local.sh` killed this script;
# `check-mutation-tables.sh` two layers down did not match that pattern, was
# re-parented to init, and kept spawning `bun run scripts/mutate.ts` per spec —
# mutating the working tree for minutes after the harness appeared to stop.
# Modified files then surface in `git status` from a process the operator can no
# longer see, and a `git commit -o` naming one commits a deliberate fault
# injection as production code.
#
# `setsid` is deliberately NOT used: this must stay in the caller's job control
# so an interactive Ctrl-C reaches it at all. Instead every child is killed by
# PROCESS GROUP, which is what catches the grandchildren a name-based `pkill`
# structurally cannot.
#
# TERM, never KILL, and the wait is load-bearing: `mutate.ts` restores the
# sources it rewrote in its own signal handler, and a hard kill is precisely
# what strands a mutant on disk.
ci_local_cleanup() {
  local sig="${1:-}"
  trap - INT TERM EXIT
  # Negative PID = the whole process group. `kill 0` targets our own group,
  # which includes every gate and everything they spawned.
  kill -TERM 0 2>/dev/null || true
  for _ in $(seq 1 200); do
    # `jobs -rp` is empty once every background gate has reaped.
    [ -z "$(jobs -rp 2>/dev/null)" ] && break
    sleep 0.1
  done
  if [ -n "$sig" ]; then
    echo "" >&2
    echo "interrupted — children signalled; sources should be restored." >&2
    echo "⚠️  RUN \`git status\` before committing: mutate.ts rewrites sources in" >&2
    echo "   place, and an interrupt is the one path that can strand a mutant." >&2
    echo "interrupted" >"$LOG_DIR/RESULT" 2>/dev/null || true
    case "$sig" in
      INT) exit 130 ;;
      *) exit 143 ;;
    esac
  fi
}
trap 'ci_local_cleanup INT' INT
trap 'ci_local_cleanup TERM' TERM

LOG_DIR="$ROOT/.ci-local"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

# Machine-readable run state for the launch-and-watch protocol in
# .claude/commands/ci.md — a watcher must never depend on an agent hand-off:
#   PID     — this run's pid; liveness = `kill -0 "$(cat .ci-local/PID)"`
#   STATUS  — last stage transition, overwritten in place
#   RESULT  — the full compact report, written ATOMICALLY at the very end.
#             Its existence is the completion signal; its contents are the report.
echo "$$" >"$LOG_DIR/PID"
status() { printf '%s\n' "$*" | tee "$LOG_DIR/STATUS"; }

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
[ "$NO_TEST" = "1" ] && echo "  (CI_LOCAL_NO_TEST=1 — Stage 3 test suite skipped)"
[ "$NO_NET" = "1" ]  && echo "  (CI_LOCAL_NO_NET=1 — npm-registry gates skipped)"
if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "  TEST_DATABASE_URL set — real-Postgres *-pg.test.ts WILL run."
else
  echo "  TEST_DATABASE_URL unset — *-pg.test.ts SKIPPED (set it + db:up to exercise)."
fi

# Match CI's `bun install --frozen-lockfile`: catches a stale lockfile and
# guarantees node_modules exists (a worktree/fresh checkout would TS2307 otherwise).
status "install: bun install --frozen-lockfile" >/dev/null
printf '  bun install (frozen) … '
if bun install --frozen-lockfile >"$LOG_DIR/install.log" 2>&1; then
  echo "ok"
else
  echo "FAILED — see .ci-local/install.log"
  tail -n "$FAIL_TAIL" "$LOG_DIR/install.log"
  msg="RESULT: FAIL — dependency install failed; fix the lockfile before gates can run."
  echo "$msg"
  printf '%s\n' "$msg" >"$LOG_DIR/RESULT"
  exit 1
fi

# ---- Stage 0: the lone dist/-writer, serial ----
status "stage 0: type-check + SDK dist build (serial) …"
run_fg type g_type

# ---- Stage 1: read-only gates, parallel ----
status "stage 1: read-only drift/lint gates (parallel, jobs=$JOBS) …"
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
launch lighthouse-report-paths   bash scripts/check-lighthouse-report-paths.sh
launch pricing-parity            bash scripts/check-pricing-parity.sh
launch plugin-count              bash scripts/check-plugin-count.sh
launch plugin-lockstep           bun scripts/check-plugin-lockstep.ts
launch enforcement-parity        bash scripts/check-enforcement-parity.sh
launch schema-drift              bash scripts/check-schema-drift.sh
launch migration-rename          bash scripts/check-migration-rename-discipline.sh
launch oauth-helper-drift        bash scripts/check-oauth-helper-drift.sh
launch ee-imports                bash scripts/check-ee-imports.sh
launch twenty-resolver           bash scripts/check-twenty-resolver-imports.sh
launch no-admin-plugin           bash scripts/check-no-admin-plugin.sh
launch streaming-cors            bash scripts/check-streaming-cors.sh
launch no-legacy-connections     bash scripts/check-no-legacy-connections-sql.sh
launch brain-fact-promotion      bash scripts/check-brain-fact-promotion.sh
launch test-discipline           bash scripts/check-test-discipline.sh
launch settings-readers          bash scripts/check-settings-readers.sh
launch saas-env-doc              bash scripts/check-saas-env-doc.sh
launch brain-settings-doc        bun scripts/check-brain-settings-doc.ts
launch docs-links                bun scripts/check-docs-links.ts
launch docs-brain-snippets       bun scripts/check-docs-brain-snippets.ts
launch auth-md-parity            g_auth_md_parity
launch apex-discovery-drift      bash scripts/check-apex-discovery-drift.sh
launch openapi-drift             g_openapi_drift
if [ "$NO_NET" != "1" ]; then
  launch published-symbols       g_published_symbols
  launch unpublished-versions    g_unpublished
fi
wait

# ---- Stage 2: gates that WRITE to the tree, then the full test suite ----
#
# ⚠️ `mutation-tables` cannot live in Stage 1, and the reason is not load — it is
# CORRECTNESS. Stage 1 is labelled read-only because every gate there SCANS the
# tree, and `mutate.ts` REWRITES source files in place (apply → run → restore),
# by design. Run in parallel, a brain mutation is live on disk while
# `check-brain-fact-promotion.sh`, `check-no-legacy-connections-sql.sh`,
# `lint-type-aware` and the rest read those very files — so they go red on a line
# the developer never wrote, the developer re-runs, it passes, and they learn the
# gate is flaky. The hazard is worst exactly when the gate is doing its job:
# on a branch that touches the runner it widens to --all, which is ~16 minutes
# of continuous mutation.
#
# --affected, NOT --all: the full sweep would more than double this script. CI
# runs --all sharded four ways on push to main; here there is one machine.
# Skips entirely without TEST_DATABASE_URL.
status "stage 2: tree-writing gates (serial — these mutate sources in place) …"
# ⚠️ `gate-fixtures` MOVED HERE from Stage 1 (#5165), for the same correctness
# reason as `mutation-tables` above and not for load. Several of the adversarial
# suites REWRITE TRACKED SOURCE in place and trap-restore it, opening a ~1s
# window per fixture in which the file on disk is deliberately wrong. Run in
# parallel, Stage 1 lands inside that window while ~30 scanners are reading those
# very files, so they go red on a line the developer never wrote — the
# flake-teaching outcome the paragraph above exists to prevent. Worse, in Stage 1
# a fixture suite raced the very gate it tests.
#
# FOUR suites still write into the tree Stage 1 reads, and they are what keeps
# this row here:
#   • check-pricing-parity.test.sh     → settings.ts, entitlements.generated.ts,
#                                        llms.txt, and two docs pages (five files)
#   • check-brain-settings-doc.test.sh → settings.ts, environment-variables.mdx,
#                                        atlas-vocabulary.mdx, and the guard itself
#   • check-enforcement-parity.test.sh → billing/enforcement-parity.ts and
#                                        api/routes/admin-sso.ts
#   • check-scripts-typecheck.test.sh  → writes a deliberately BROKEN, untracked
#                                        scripts/zz-lint-probe.ts into a directory
#                                        the Stage-1 `lint` gate scans. Not
#                                        tracked source, same race.
#
# `check-docs-brain-snippets.test.sh` no longer does (#5172): the guard takes
# `--root` / `--source-glob` / `--docs-glob`, so its fixtures build throwaway
# trees under `mktemp -d` and it asserts `git status --porcelain` is unchanged
# after every case. That is the seam the other three need before this row can go
# back to Stage 1 — moving it while any of them writes tracked source would
# reintroduce the race for all of them.
run_fg gate-fixtures   g_gate_fixtures
run_fg mutation-tables bash scripts/check-mutation-tables.sh --affected origin/main

if [ "$NO_TEST" != "1" ]; then
  status "stage 3: full test suite (isolated — no parallel load) …"
  run_fg test g_test
fi

# ---- Report ----
# Rendered once, printed to stdout AND written atomically (tmp + mv) to
# .ci-local/RESULT so a watcher polling for the file can never observe it
# half-written. RESULT's existence = run finished; its contents = the report.
#
# ⚠️ The verdict logic itself lives in scripts/lib/ci-local-report.sh so it can
# be tested WITHOUT running 37 gates. It cannot be tested by invoking this
# script: `g_gate_fixtures` above runs every scripts/__tests__/*.test.sh, so
# such a test would recurse. See scripts/__tests__/ci-local-verdict.test.sh.
# shellcheck source=lib/ci-local-report.sh
. "$ROOT/scripts/lib/ci-local-report.sh"

ci_local_classify_gates

report="$(render_report)"
printf '%s\n' "$report"
printf '%s\n' "$report" >"$LOG_DIR/RESULT.tmp"
mv "$LOG_DIR/RESULT.tmp" "$LOG_DIR/RESULT"

exit "$(ci_local_exit_code)"
