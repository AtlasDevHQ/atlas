#!/usr/bin/env bash
# Adversarial fixture suite for .github/scripts/measure-shard-spread.ts.
#
# ## What this exists to hold
#
# The script decides, on every green `main` push, whether the four `api-tests`
# shards have drifted out of balance. The failure it must not have is the one
# a single-run check has: on 28 consecutive green runs the per-run spread
# ranged 1.11x..2.41x while the balance itself was unchanged, so a check that
# reads one run fires on runner noise and is muted within a week. Every case
# below therefore pairs a NOISE fixture (one bad run, must pass) with a DRIFT
# fixture (the same shard heavy on every run, must fail) — the second is the
# positive control for the first, because a script that always exits 0 passes
# every noise case by itself.
#
# `set -uo pipefail` without `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK="$ROOT/.github/scripts/measure-shard-spread.ts"
WORKFLOW="$ROOT/.github/workflows/ci.yml"

[ -f "$CHECK" ] || { echo "::error::script under test not found at $CHECK" >&2; exit 2; }
[ -f "$WORKFLOW" ] || { echo "::error::$WORKFLOW not found" >&2; exit 2; }
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
# gen <out> <run_id> <s1> <s2> <s3> <s4> [cancel=N] [drop=N] [page=single]
# Writes a jobs-list payload in the slurped (array-of-pages) shape the workflow
# produces, with the api-tests jobs interleaved among unrelated jobs so the
# job-pattern filter is exercised. `cancel=N` marks shard N's test step
# cancelled; `drop=N` omits shard N's job entirely; `page=single` writes one
# page object instead of an array.
GEN="$TMPROOT/gen.ts"
cat >"$GEN" <<'TS'
const [out, runId, ...rest] = process.argv.slice(2);
const secs = rest.slice(0, 4).map(Number);
const flags = Object.fromEntries(rest.slice(4).map((f) => f.split("=")));
const t0 = Date.parse("2026-09-04T12:00:00Z");
const iso = (ms: number) => new Date(t0 + ms).toISOString();
const step = (name: string, s: number, conclusion = "success") => ({
  name, status: "completed", conclusion, number: 1, started_at: iso(0), completed_at: iso(s * 1000),
});
const job = (name: string, steps: unknown[]) => ({
  run_id: Number(runId), name, conclusion: "success", steps,
});
const jobs: unknown[] = [job("lint", [step("Lint", 30)])];
secs.forEach((s, i) => {
  const n = i + 1;
  if (String(n) === flags.drop) return;
  const cancelled = String(n) === flags.cancel;
  jobs.push(job(`api-tests (${n}/4)`, [
    step("Build @useatlas/types + @useatlas/plugin-sdk", 20),
    step(`Test @atlas/api (shard ${n}/4)`, cancelled ? 5 : s, cancelled ? "cancelled" : "success"),
  ]));
  if (i === 1) jobs.push(job("type", [step("Type", 60)]));
});
const page = { total_count: jobs.length, jobs };
await Bun.write(out!, JSON.stringify(flags.page === "single" ? page : [page]));
TS
gen() { bun "$GEN" "$@"; }

# run <expected_exit> <label> <args...>  — captures output for grep
OUT="$TMPROOT/out.txt"
run() {
  local expected="$1" label="$2"; shift 2
  bun "$CHECK" "$@" >"$OUT" 2>&1
  local code=$?
  if [ "$code" -eq "$expected" ]; then pass "$label (exit $code)"; else fail "$label — expected exit $expected, got $code"; sed 's/^/       /' "$OUT" >&2; fi
}
expect_grep() { if grep -qF -- "$1" "$OUT"; then pass "$2"; else fail "$2 — output lacks '$1'"; sed 's/^/       /' "$OUT" >&2; fi; }

echo "measure-shard-spread.test.sh — api-tests shard drift gate"

# --- 1. A balanced tree passes ---------------------------------------------------
D="$TMPROOT/balanced"; mkdir -p "$D"
for i in $(seq 1 10); do gen "$D/$i.json" "$((1000 + i))" 70 72 68 71; done
run 0 "balanced: ten runs within noise" "$D"/*.json
expect_grep "within threshold" "balanced: says so"

# --- 2. One bad runner is noise, the same shard heavy every run is drift --------
D="$TMPROOT/noise"; mkdir -p "$D"
for i in $(seq 1 9); do gen "$D/$i.json" "$((2000 + i))" 70 72 68 71; done
gen "$D/10.json" 2010 70 72 170 71     # 2.5x on one run — the 2026-09-03 18:59 shape
run 0 "noise: one run at 2.5x on shard 3 does not fire" "$D"/*.json

D="$TMPROOT/drift"; mkdir -p "$D"
for i in $(seq 1 10); do gen "$D/$i.json" "$((3000 + i))" 70 105 68 71; done
run 1 "drift: shard 2 at 1.5x+ on every run fires (positive control for noise)" "$D"/*.json
expect_grep "test-timings-refresh.yml" "drift: failure names the refresh workflow"
expect_grep "spread: 1.54x" "drift: reports the measured spread"

# --- 3. The threshold is a boundary, not a region --------------------------------
D="$TMPROOT/edge"; mkdir -p "$D"
for i in $(seq 1 6); do gen "$D/$i.json" "$((4000 + i))" 75 50 60 60; done
run 0 "boundary: exactly 1.50x passes" --threshold 1.5 "$D"/*.json
run 1 "boundary: 1.50x fails at --threshold 1.49" --threshold 1.49 "$D"/*.json

# --- 4. Too few usable runs is a refusal, not a pass ------------------------------
D="$TMPROOT/few"; mkdir -p "$D"
for i in $(seq 1 4); do gen "$D/$i.json" "$((5000 + i))" 70 72 68 71; done
run 2 "few: four runs under --min-runs 5 declines" --min-runs 5 "$D"/*.json
expect_grep "need 5" "few: says how many it needed"

# --- 5. A cancelled leg or a missing shard skips THAT RUN, and only that run ------
# Three runs carry a cancelled step AND a 500s shard 1. If they were folded in,
# the shard-1 median over seven runs would be 500s and the spread would fire.
D="$TMPROOT/skip"; mkdir -p "$D"
for i in $(seq 1 4); do gen "$D/$i.json" "$((6000 + i))" 70 72 68 71; done
for i in 5 6 7; do gen "$D/$i.json" "$((6000 + i))" 500 72 68 71 cancel=2; done
run 0 "skip: cancelled legs are excluded, not averaged" --min-runs 4 "$D"/*.json
expect_grep "skip run 6005" "skip: names the skipped run"
expect_grep "cancelled" "skip: says why"
run 2 "skip: and excluded runs do not count toward --min-runs" --min-runs 5 "$D"/*.json

D="$TMPROOT/drop"; mkdir -p "$D"
for i in $(seq 1 4); do gen "$D/$i.json" "$((7000 + i))" 70 72 68 71; done
gen "$D/5.json" 7005 500 72 68 71 drop=4
run 0 "drop: a run missing a shard is skipped" --min-runs 4 "$D"/*.json
expect_grep "shard(s) 4 absent" "drop: names the absent shard"

# --- 6. Both payload shapes are read -------------------------------------------------
D="$TMPROOT/shape"; mkdir -p "$D"
for i in $(seq 1 3); do gen "$D/$i.json" "$((8000 + i))" 70 105 68 71; done
for i in 4 5 6; do gen "$D/$i.json" "$((8000 + i))" 70 105 68 71 page=single; done
run 1 "shape: slurped pages and single pages both count (drift still fires)" "$D"/*.json
expect_grep "over 6 green run(s)" "shape: all six runs were used"

# --- 7. Garbage in is a refusal ------------------------------------------------------
echo "not json" >"$TMPROOT/bad.json"
run 2 "garbage: non-JSON input declines" "$TMPROOT/bad.json"
echo '{"total_count":0}' >"$TMPROOT/nojobs.json"
run 2 "garbage: a payload without 'jobs' declines" "$TMPROOT/nojobs.json"
run 2 "garbage: no inputs at all declines"
run 2 "garbage: an unknown flag declines" --frobnicate "$TMPROOT/bad.json"

# --- 8. Wiring: ci.yml runs it outside a comment ------------------------------------
if sed 's/#.*$//' "$WORKFLOW" | grep -qF ".github/scripts/measure-shard-spread.ts"; then
  pass "wiring: ci.yml runs measure-shard-spread.ts outside a comment"
else
  fail "wiring: ci.yml does not run .github/scripts/measure-shard-spread.ts — the gate measures nothing"
fi
if sed 's/#.*$//' "$WORKFLOW" | grep -qF "test-timings-refresh.yml"; then
  pass "wiring: ci.yml dispatches the refresh outside a comment"
else
  fail "wiring: ci.yml never dispatches test-timings-refresh.yml — drift is detected and nobody is asked to fix it"
fi

echo "measure-shard-spread.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
