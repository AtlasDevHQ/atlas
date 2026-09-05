#!/usr/bin/env bash
# Adversarial fixture suite for .github/scripts/merge-test-timings.ts.
#
# ## What this exists to hold
#
# The merge's job is to REFUSE the refreshes that would ship a balancer worse
# than the stale file they replace. The refusals are the product, and each one
# is pinned here with a positive control beside it, because a script that dies
# on every input passes every refusal case on its own.
#
# The one added after #5383: a sweep that ran without Postgres. It writes a
# well-formed file in which every `-pg` suite is a ~10ms entry, ci.yml asked the
# operator to catch it by reading the artifact, and the refresh now runs on a
# schedule with nobody reading anything. So the median of the MEASURED `-pg`
# durations has a floor, and the floor is a number this suite can miss from
# both sides.
#
# `set -uo pipefail` without `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MERGE="$ROOT/.github/scripts/merge-test-timings.ts"

[ -f "$MERGE" ] || { echo "::error::script under test not found at $MERGE" >&2; exit 2; }
command -v bun >/dev/null || { echo "::error::bun is not on PATH" >&2; exit 2; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

# --- Fixture generator --------------------------------------------------------
# shards <dir> <pg_ms>   — four disjoint shard files, each with three plain
# suites (~300ms) and two -pg suites at <pg_ms>. Baseline holds all twenty plus
# one file no shard measured.
mk_shards() {
  local dir="$1" pg_ms="$2"
  mkdir -p "$dir"
  for n in 1 2 3 4; do
    cat >"$dir/measured-$n.json" <<JSON
{"version":1,"files":{
  "src/a$n.test.ts":300,"src/b$n.test.ts":250,"src/c$n.test.ts":400,
  "src/x$n-pg.test.ts":$pg_ms,"src/y$n-pg.test.ts":$pg_ms
}}
JSON
  done
  cat >"$dir/baseline.json" <<'JSON'
{"version":1,"files":{"src/a1.test.ts":1,"src/x1-pg.test.ts":9000,"src/orphan-pg.test.ts":8000}}
JSON
}

OUT="$TMPROOT/out.txt"
run() {
  local expected="$1" label="$2" dir="$3"; shift 3
  bun "$MERGE" --out "$dir/merged.json" --baseline "$dir/baseline.json" "$@" >"$OUT" 2>&1
  local code=$?
  if [ "$code" -eq "$expected" ]; then pass "$label (exit $code)"; else fail "$label — expected exit $expected, got $code"; sed 's/^/       /' "$OUT" >&2; fi
}
expect_grep() { if grep -qF -- "$1" "$OUT"; then pass "$2"; else fail "$2 — output lacks '$1'"; sed 's/^/       /' "$OUT" >&2; fi; }

echo "merge-test-timings.test.sh — refresh merge refusals"

# --- 1. A sweep with a database merges (positive control for everything below) ----
D="$TMPROOT/ok"; mk_shards "$D" 4300
run 0 "database: -pg median 4300ms merges" "$D" --expect-shards 4 "$D"/measured-*.json
expect_grep "-pg suites measured: 8, median 4300ms" "database: reports the measured -pg median"
expect_grep "orphan-pg.test.ts" "database: names the baseline file no shard measured"
if bun -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).files; process.exit(f["src/x1-pg.test.ts"]===4300 && f["src/orphan-pg.test.ts"]===8000 ? 0 : 1)' "$D/merged.json"; then
  pass "database: measured values win, unmeasured baseline entries are carried over"
else
  fail "database: merged file does not carry the expected values"
fi

# --- 2. A sweep WITHOUT a database is refused, and the floor is a number -----------
D="$TMPROOT/nodb"; mk_shards "$D" 12
run 1 "no database: -pg median 12ms is refused" "$D" --expect-shards 4 "$D"/measured-*.json
expect_grep "WITHOUT a database" "no database: says what happened"
expect_grep "TEST_DATABASE_URL" "no database: names the variable to check"
[ -f "$D/merged.json" ] && fail "no database: wrote merged.json anyway" || pass "no database: wrote nothing"

D="$TMPROOT/floor-below"; mk_shards "$D" 499
run 1 "floor: 499ms is below the 500ms floor" "$D" --expect-shards 4 "$D"/measured-*.json
D="$TMPROOT/floor-at"; mk_shards "$D" 500
run 0 "floor: 500ms is at the floor and merges" "$D" --expect-shards 4 "$D"/measured-*.json

# The baseline carries real -pg durations. They must NOT rescue a dry sweep:
# only what the shards measured enters the median.
D="$TMPROOT/baseline-rescue"; mk_shards "$D" 12
cat >"$D/baseline.json" <<'JSON'
{"version":1,"files":{"src/p1-pg.test.ts":9000,"src/p2-pg.test.ts":9000,"src/p3-pg.test.ts":9000,"src/p4-pg.test.ts":9000,"src/p5-pg.test.ts":9000,"src/p6-pg.test.ts":9000,"src/p7-pg.test.ts":9000,"src/p8-pg.test.ts":9000,"src/p9-pg.test.ts":9000}}
JSON
run 1 "no database: baseline -pg durations do not rescue a dry sweep" "$D" --expect-shards 4 "$D"/measured-*.json

# --- 3. No -pg suite measured at all is a refusal, not a vacuous pass ---------------
D="$TMPROOT/nopg"; mkdir -p "$D"
for n in 1 2 3 4; do echo "{\"version\":1,\"files\":{\"src/a$n.test.ts\":300}}" >"$D/measured-$n.json"; done
echo '{"version":1,"files":{}}' >"$D/baseline.json"
run 1 "no -pg suites: refused" "$D" --expect-shards 4 "$D"/measured-*.json
expect_grep "no -pg suite was measured" "no -pg suites: says so"

# --- 4. The #5383 refusals still hold --------------------------------------------------
D="$TMPROOT/missing"; mk_shards "$D" 4300
run 1 "missing shard: three files for --expect-shards 4" "$D" --expect-shards 4 "$D"/measured-1.json "$D"/measured-2.json "$D"/measured-3.json
expect_grep "expected 4 shard file(s), found 3" "missing shard: counts them"

D="$TMPROOT/empty"; mk_shards "$D" 4300
echo '{"version":1,"files":{}}' >"$D/measured-4.json"
run 1 "empty shard: a leg that measured nothing" "$D" --expect-shards 4 "$D"/measured-*.json
expect_grep "measured 0 files" "empty shard: says so"

D="$TMPROOT/collide"; mk_shards "$D" 4300
cp "$D/measured-1.json" "$D/measured-4.json"
run 1 "collision: two shards claiming one file" "$D" --expect-shards 4 "$D"/measured-*.json
expect_grep "was measured by both" "collision: names the overlap"

echo "merge-test-timings.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
