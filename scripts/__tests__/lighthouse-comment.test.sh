#!/usr/bin/env bash
# Adversarial fixture suite for .github/scripts/lighthouse-comment.js (#5174).
#
# ## What this exists to hold
#
# The renderer emits a CLAIM about a CI run, and #4899 was a false one: for three
# months and 1200+ runs the comment said *"No reports found"* on runs that had
# produced nine reports. Fixing it took two review rounds and surfaced SIX
# separate false-or-overreaching message claims — FOUR of them introduced by the
# fix for a previous one. Its verification lived in a throwaway out-of-tree
# harness (138 assertions, 48 killed mutations) that nobody could re-run, so the
# class-closure was guarded by review attention: the thing that had just failed.
#
# So this suite is not "does a table render". It is the RATCHET: every wording
# that was retired for asserting a cause the signal cannot establish is pinned
# here, over RENDERED BODIES.
#
# ⚠️ THE RATCHET RUNS OVER RENDERED OUTPUT, NEVER OVER THE SOURCE, and that is
# load-bearing rather than convenient. The renderer's own comments NAME the
# retired wordings, in order to explain why they are retired — so a lexical scan
# of the source would flag its own documentation, and the only ways out are
# deleting the explanation or exempting the file. A guard must parse as the
# READER parses, and the reader reads the comment.
#
# ⚠️ EVERY RATCHET CASE CARRIES A POSITIVE CONTROL. A ratchet alone is satisfied
# by a renderer that returns the empty string, which is the strongest possible
# way to contain no forbidden phrase.
#
# `set -uo pipefail` without `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RENDERER="$ROOT/.github/scripts/lighthouse-comment.js"
WORKFLOW="$ROOT/.github/workflows/lighthouse.yml"

[ -f "$RENDERER" ] || { echo "::error::renderer under test not found at $RENDERER" >&2; exit 2; }
[ -f "$WORKFLOW" ] || { echo "::error::$WORKFLOW not found" >&2; exit 2; }
command -v bun >/dev/null || { echo "::error::bun is not on PATH; the renderer cannot be evaluated" >&2; exit 2; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

# --- The driver ---------------------------------------------------------------
# Injects a stub `core` so warnings are observable, and writes three artifacts
# the bash below can grep. `buildBody` reads the report tree relative to CWD, so
# the driver runs inside the fixture tree.
DRIVER="$TMPROOT/driver.js"
cat >"$DRIVER" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const warnings = [];
const core = {
  warning: (m) => warnings.push(String(m)),
  info: (m) => warnings.push(`info: ${String(m)}`),
};
const { buildBody } = require(process.env.RENDERER);
const out = buildBody({ fs, path, core, env: process.env });
fs.writeFileSync("body.md", out.body);
fs.writeFileSync("warnings.txt", warnings.join("\n"));
fs.writeFileSync("meta.json", JSON.stringify({ anyTables: out.anyTables, rowCounts: out.rowCounts }));
JS

CASE_N=0
TREE=""
# new_tree — an empty report tree (no directories at all).
new_tree() {
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE"
}

# populate FORM_FACTOR — a manifest with two representative runs plus a
# per-run report carrying real LCP/CLS numbers.
#
# ⚠️ Every number here is DIFFERENT. A fixture with equal scores is passed by a
# renderer that reads the wrong summary key, and a fixture whose LCP equals its
# CLS is passed by one that swaps the two audit ids.
populate() {
  local ff="$1" dir="$TREE/lighthouse-reports/$1"
  mkdir -p "$dir"
  cat >"$dir/lhr-1.json" <<'JS'
{ "audits": { "largest-contentful-paint": { "numericValue": 1234.6 },
              "cumulative-layout-shift": { "numericValue": 0.0721 } } }
JS
  cat >"$dir/lhr-2.json" <<'JS'
{ "audits": { "largest-contentful-paint": { "numericValue": 2500 },
              "cumulative-layout-shift": { "numericValue": 0.31 } } }
JS
  cat >"$dir/manifest.json" <<JS
[
  { "url": "http://localhost:8080/", "isRepresentativeRun": true,
    "jsonPath": "$dir/lhr-1.json",
    "summary": { "performance": 0.97, "accessibility": 0.94, "best-practices": 0.91, "seo": 0.88 } },
  { "url": "http://localhost:3000/demo", "isRepresentativeRun": true,
    "jsonPath": "$dir/lhr-2.json",
    "summary": { "performance": 0.62, "accessibility": 0.71, "best-practices": 0.83, "seo": 0.55 } },
  { "url": "http://localhost:8080/pricing", "isRepresentativeRun": false,
    "jsonPath": "$dir/lhr-1.json", "summary": { "performance": 0.11 } }
]
JS
}

# render DESKTOP_OUTCOME MOBILE_OUTCOME — sets $BODY / $WARNINGS / $META.
BODY=""; WARNINGS=""; META=""
render() {
  local d="$1" m="$2" err
  err=$( cd "$TREE" && RENDERER="$RENDERER" DESKTOP_OUTCOME="$d" MOBILE_OUTCOME="$m" \
         bun "$DRIVER" 2>&1 ) || {
    fail "the renderer THREW for outcomes ($d/$m) — nothing below this line was tested"
    printf '%s\n' "$err" | sed 's/^/       | /' >&2
    BODY=""; WARNINGS=""; META=""
    return 1
  }
  BODY=$(cat "$TREE/body.md")
  WARNINGS=$(cat "$TREE/warnings.txt")
  META=$(cat "$TREE/meta.json")
}

# render_unset — the same, with BOTH outcome variables ABSENT rather than empty.
#
# ⚠️ A separate path because `''` and "not set at all" reach the EMPTY_STATE
# lookup differently — one is the `''` key, the other is `undefined ?? ''` — and
# a renderer that handled only the first would render a native
# `Object.prototype` member for a step that never started. `unset` rather than
# `env -u`, which does not reliably unset under bun.
render_unset() {
  local err
  err=$( cd "$TREE" && unset DESKTOP_OUTCOME MOBILE_OUTCOME
         RENDERER="$RENDERER" bun "$DRIVER" 2>&1 ) || {
    fail "the renderer THREW with the outcome vars unset"
    printf '%s\n' "$err" | sed 's/^/       | /' >&2
    return 1
  }
  BODY=$(cat "$TREE/body.md")
  WARNINGS=$(cat "$TREE/warnings.txt")
  META=$(cat "$TREE/meta.json")
}

has() { # has NAME PHRASE
  if printf '%s' "$BODY" | grep -qF -- "$2"; then pass "$1"; else
    fail "$1 — rendered body does not contain '$2'"
    printf '%s\n' "$BODY" | sed 's/^/       | /' >&2
  fi
}
hasnt() { # hasnt NAME PHRASE
  if printf '%s' "$BODY" | grep -qF -- "$2"; then
    fail "$1 — rendered body contains '$2'"
    printf '%s\n' "$BODY" | grep -nF -- "$2" | sed 's/^/       | /' >&2
  else pass "$1"; fi
}

echo "lighthouse-comment.test.sh — the Lighthouse comment renderer + wording ratchet (#5174)"

# ============================================================================
# 1. POSITIVE CONTROL — a populated tree renders both tables with real numbers.
#    Everything below is vacuous without this.
# ============================================================================
new_tree; populate desktop; populate mobile
render success success
has "both tables render their header" "| Surface | Perf | A11y | Best Practices | SEO | LCP | CLS |"
has "the desktop heading renders" "### Desktop"
has "the mobile heading renders" "### Mobile"
# Distinct numbers per column, so a swapped summary key cannot pass.
has "scores come from the right summary keys" "| \`/\` | 97 | 94 | 91 | 88 |"
has "a second representative run renders its own row" "| \`/demo\` | 62 | 71 | 83 | 55 |"
# LCP is rounded to ms, CLS to 2dp — different formatters, different values, so
# swapping the two audit ids fails rather than rendering plausibly.
has "LCP renders as rounded milliseconds" "1235 ms"
has "CLS renders to two decimal places" "0.07"
hasnt "a NON-representative run is filtered out" "| 11 |"
has "the footer points at the artifact when a table rendered" \
  "Full HTML reports are in the \`lighthouse-reports\` artifact on this run"
if printf '%s' "$META" | grep -qF '"anyTables":true'; then
  pass "anyTables is true when rows rendered"
else
  fail "anyTables should be true — meta was $META"
fi
if [ -z "$WARNINGS" ]; then
  pass "a healthy render emits NO warnings"
else
  fail "a healthy render emitted warnings: $WARNINGS"
fi

# ============================================================================
# 2. THE FIVE EMPTY-STATE OUTCOMES — exact sentence per outcome, and the
#    retired wording each replaced.
# ============================================================================
new_tree
render failure failure
has "outcome=failure says only that the step exited non-zero" "_Run failed._"
hasnt "…and does NOT reach for #4899's own sentence" "No reports found"
if printf '%s' "$META" | grep -qF '"anyTables":false'; then
  pass "anyTables is false with no tables"
else
  fail "anyTables should be false — meta was $META"
fi
has "the empty footer describes the observation and still points somewhere" \
  "No table could be built."
hasnt "RETIRED: the empty footer must not assert no artifact exists" \
  "No artifact was produced"

new_tree
render success success
has "outcome=success names what was READ, not what was written" \
  "No reports found. \`lhci autorun\` reported success but no representative runs could be read"
hasnt "RETIRED: 'wrote no manifest.json' — a manifest of [] reads the same way" \
  "wrote no manifest.json"

new_tree
render cancelled cancelled
has "outcome=cancelled says reports may still be in the artifact" \
  "Run cancelled. No representative runs could be read"
hasnt "RETIRED: 'before reports were written' — upload writes manifest.json LAST" \
  "before reports were written"
hasnt "RETIRED: 'superseded' — there is no concurrency: block, so no run can be" \
  "superseded"

new_tree
render skipped skipped
has "outcome=skipped points at the job and asserts nothing about it" \
  "Lighthouse did not run — see the earlier steps in this job."
hasnt "RETIRED: 'because an earlier step failed' — a skipped step does not say why" \
  "because an earlier step failed"

new_tree
render "" ""
has "an EMPTY outcome renders the did-not-run sentence" \
  "Lighthouse did not run — see the earlier steps in this job."

new_tree
render_unset
has "an ABSENT outcome renders the same sentence, not an inherited prototype member" \
  "Lighthouse did not run — see the earlier steps in this job."
# ⚠️ WEAKER THAN IT READS, and recorded rather than deleted. With the vars unset
# the key is `""`, which IS an own property of EMPTY_STATE — so the
# `EMPTY_STATE[key] ?? fallback` mutant this line targets renders no native
# function here either. The assertion that actually discriminates is the
# `constructor`/`toString` case below; this one is a cheap belt.
hasnt "…and never renders a native function into the comment" "native code"

new_tree
render "constructor" "toString"
has "an Object.prototype key is reported as unrecognized, not resolved" \
  "Unrecognized step outcome \`constructor\`."
hasnt "…and does not render the prototype member itself" "native code"

# ============================================================================
# 3. FAILED-BUT-POPULATED — the branch that named a cause twice and was wrong
#    both times.
# ============================================================================
new_tree; populate desktop; populate mobile
render failure success
has "a failed-but-populated form factor gets the non-zero banner" \
  "\`lhci autorun\` exited non-zero for desktop."
has "…and says the rows are the manifest's representative runs" \
  "The rows below are the representative runs from the manifest it wrote"
has "…and its rows still render" "| \`/\` | 97 | 94 | 91 | 88 |"
hasnt "RETIRED: naming an \`error\`-level assertion as the cause" "error\`-level"
hasnt "RETIRED: 'a budget assertion failed' — unreachable while every one is warn" \
  "budget assertion failed"
hasnt "RETIRED: 'everything the run wrote' — the rows are 3 of 9 entries" \
  "everything the run wrote"
hasnt "RETIRED: 'see the failing step above' — this also fires on a cancelled job" \
  "see the failing step above"
# The banner is per-form-factor: the SUCCEEDING one must not carry it.
if [ "$(printf '%s' "$BODY" | grep -cF 'exited non-zero for')" = "1" ]; then
  pass "the banner appears on the failed form factor only"
else
  fail "the non-zero banner appeared on both form factors, or on neither"
fi

# ============================================================================
# 4. THE READER-DISAGREEMENT CLASS — manifests that the verify step and the
#    comment used to read differently.
# ============================================================================
new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
echo '[]' >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
has "an EMPTY manifest array renders the success empty state, not a crash" \
  "No reports found."
hasnt "…and still does not claim nothing was written" "wrote no manifest.json"
# ⚠️ `[]` REACHES the counted warning, and the count is the whole point of that
# arm — it is the "lhci wrote nothing" end of the discrimination
# `readManifest`'s docstring describes, and the shape `lighthouse.yml` calls
# "#4899's shape one layer in". Unasserted, `parsed.length === 1` could relax to
# `<= 1` and render "has 0 entry" with nothing noticing.
if printf '%s' "$WARNINGS" | grep -qF "has 0 entries but none with isRepresentativeRun: true"; then
  pass "an EMPTY manifest array reaches the counted warning, and says zero"
else
  fail "empty-array manifest emitted no counted warning — warnings were: $WARNINGS"
fi

# ⚠️ THE FILTER-TO-ZERO ARM, which returned a bare `[]` with no warning while the
# reader's own docstring claimed it had no silent path. The COUNT is the number
# that separates "lhci wrote nothing" from "lhci wrote nine and none was
# representative" — two different bugs with two different fixes.
new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
printf '%s' '[{ "url": "http://localhost:8080/", "isRepresentativeRun": false }, { "url": "http://localhost:8080/pricing", "isRepresentativeRun": false }]' \
  >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
if printf '%s' "$WARNINGS" | grep -qF "has 2 entries but none with isRepresentativeRun: true"; then
  pass "a manifest with entries but NO representative run warns, and says how many it saw"
else
  fail "filter-to-zero emitted no counted warning — warnings were: $WARNINGS"
fi

# …and the singular, because "1 entries" is the tell of a template nobody read.
new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
printf '%s' '[{ "url": "http://localhost:8080/", "isRepresentativeRun": false }]' \
  >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
if printf '%s' "$WARNINGS" | grep -qF "has 1 entry but none with isRepresentativeRun: true"; then
  pass "…and pluralises the count correctly"
else
  fail "singular entry count wrong — warnings were: $WARNINGS"
fi

# ⚠️ A REPRESENTATIVE ENTRY WITH NO `url`. `readManifest`'s filter is deliberately
# only `r && r.isRepresentativeRun`, matched to the verify step's tolerance, so
# this survives it. `new URL(undefined)` threw, the catch returned `undefined`, and
# the row rendered `` `undefined` `` as a SURFACE NAME — while `anyTables` went
# true and the footer asserted real reports existed.
new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
printf '%s' '[{ "isRepresentativeRun": true, "summary": { "performance": 0.5 } }]' \
  >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
has "a manifest entry with no url renders a placeholder, not \`undefined\`" "| \`(unnamed)\` |"
hasnt "…and never renders the word undefined as a surface" "| \`undefined\` |"
if printf '%s' "$WARNINGS" | grep -qF "has no url"; then
  pass "…and warns, so the placeholder is not the only trace"
else
  fail "a url-less entry emitted no warning — warnings were: $WARNINGS"
fi

# ⚠️ AN AUDIT PRESENT BUT NON-NUMERIC — `scoreDisplayMode: "error"` has no
# `numericValue`, which the renderer's own docstring calls "the realistic case
# rather than an exotic one". No case reached it, so deleting that warning killed
# nothing. The CLS value stays numeric so the row proves the two cells are read
# independently.
new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
cat >"$TREE/lighthouse-reports/desktop/lhr-1.json" <<'JS'
{ "audits": { "largest-contentful-paint": { "scoreDisplayMode": "error" },
              "cumulative-layout-shift": { "numericValue": 0.44 } } }
JS
printf '%s' '[{ "url": "http://localhost:8080/", "isRepresentativeRun": true, "jsonPath": "'"$TREE"'/lighthouse-reports/desktop/lhr-1.json", "summary": { "performance": 0.5 } }]' \
  >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
has "a non-numeric audit renders a dash while its sibling still renders" "| – | 0.44 |"
if printf '%s' "$WARNINGS" | grep -qF 'audit `largest-contentful-paint` has no numeric value'; then
  pass "…and warns per audit, naming which one"
else
  fail "a non-numeric audit emitted no warning — warnings were: $WARNINGS"
fi

# An unparseable per-run report — the third untested warning arm.
new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
echo 'not json' >"$TREE/lighthouse-reports/desktop/lhr-1.json"
printf '%s' '[{ "url": "http://localhost:8080/", "isRepresentativeRun": true, "jsonPath": "'"$TREE"'/lighthouse-reports/desktop/lhr-1.json", "summary": { "performance": 0.5 } }]' \
  >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
if printf '%s' "$WARNINGS" | grep -qF "audit read failed for"; then
  pass "an unparseable per-run report warns rather than dashing silently"
else
  fail "an unparseable per-run report emitted no warning — warnings were: $WARNINGS"
fi

# A manifest entry whose jsonPath is missing entirely — the fourth.
new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
printf '%s' '[{ "url": "http://localhost:8080/", "isRepresentativeRun": true, "summary": { "performance": 0.5 } }]' \
  >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
if printf '%s' "$WARNINGS" | grep -qF "has no usable jsonPath"; then
  pass "a manifest entry with no jsonPath warns before LCP/CLS render as dashes"
else
  fail "a jsonPath-less entry emitted no warning — warnings were: $WARNINGS"
fi

new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
echo '{ "not": "an array" }' >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
if printf '%s' "$WARNINGS" | grep -qF "is not an array"; then
  pass "a non-array manifest WARNS rather than failing silently"
else
  fail "a non-array manifest emitted no warning — warnings were: $WARNINGS"
fi

new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
printf '%s' '[null, { "url": "http://localhost:8080/", "isRepresentativeRun": true, "summary": { "performance": 0.5 } }]' \
  >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
has "a manifest with a NULL entry is as tolerant as the verify step's some()" \
  "| \`/\` | 50 |"

new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
printf '%s' '[{ "url": "http://localhost:8080/", "isRepresentativeRun": true, "jsonPath": "/nope/gone.json", "summary": { "performance": 0.5 } }]' \
  >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
has "a missing per-run report renders LCP/CLS as a dash" "| 50 | – | – | – | – | – |"
if printf '%s' "$WARNINGS" | grep -qF "report file missing for lighthouse-reports/desktop"; then
  pass "…and WARNS, so the dash is not the only trace"
else
  fail "a missing per-run report emitted no warning — warnings were: $WARNINGS"
fi

new_tree; mkdir -p "$TREE/lighthouse-reports/desktop"
echo 'not json at all' >"$TREE/lighthouse-reports/desktop/manifest.json"
render success success
if printf '%s' "$WARNINGS" | grep -qF "manifest read failed for lighthouse-reports/desktop"; then
  pass "an unparseable manifest WARNS rather than throwing away the comment"
else
  fail "an unparseable manifest emitted no warning — warnings were: $WARNINGS"
fi

new_tree
render success success
if printf '%s' "$WARNINGS" | grep -qF "no manifest at lighthouse-reports/desktop/manifest.json"; then
  pass "a MISSING manifest warns — the residual trace for a drifted report path"
else
  fail "a missing manifest emitted no warning — warnings were: $WARNINGS"
fi

# ============================================================================
# 5. THE MARKER — the comment is upserted by finding it, so it must be stable.
# ============================================================================
new_tree; populate desktop
render success success
has "the comment carries its idempotency marker" "<!-- atlas-lighthouse-budget #2009 -->"
if [ "$(printf '%s\n' "$BODY" | head -1)" = "<!-- atlas-lighthouse-budget #2009 -->" ]; then
  pass "…on the FIRST line, where listComments' body.includes finds it either way"
else
  fail "the marker is not the first line of the body"
fi

# ============================================================================
# 6. THE WIRING — the two ways this refactor could be silently wrong.
# ============================================================================
# ⚠️ `github-script` evaluates its script from the ACTION's directory, so a
# relative require does not resolve. That failure appears only at workflow
# runtime, on a PR that touches the filtered paths — the exact invisibility class
# #5174 exists to close, so it is asserted here rather than trusted.
if grep -qF '${process.env.GITHUB_WORKSPACE}/.github/scripts/lighthouse-comment.js' "$WORKFLOW"; then
  pass "lighthouse.yml requires the renderer by ABSOLUTE workspace path"
else
  fail "lighthouse.yml does not require \${GITHUB_WORKSPACE}/.github/scripts/lighthouse-comment.js — a relative require does not resolve inside github-script"
fi
# The whole point of moving the file out of YAML was to put it under a gate.
# `.github/` is in neither oxlint path list by default, so extracting there
# without this wiring would satisfy the letter of the refactor and leave the
# acceptance criterion unmet.
for key in lint lint:type-aware; do
  # ⚠️ `$ROOT/package.json`, not a bare relative path. Both invocation sites run
  # from the repo root today, so a CWD-relative read works — and would silently
  # read a DIFFERENT package.json, or exit 2, the moment anyone ran this suite
  # from elsewhere. A wiring assertion that depends on the caller's CWD is not
  # one.
  value=$(SCRIPT_KEY="$key" ROOT_DIR="$ROOT" bun -e 'const p = JSON.parse(await Bun.file(`${Bun.env.ROOT_DIR}/package.json`).text()); console.log(p.scripts?.[Bun.env.SCRIPT_KEY] ?? "")') || {
    echo "::error::could not read package.json scripts.$key" >&2; exit 2; }
  if grep -qE '(^| )\.github/scripts/( |$|")' <<<"$value"; then
    pass "package.json $key lints .github/scripts/ — the renderer is under a gate"
  else
    fail "package.json $key does not lint .github/scripts/ — value: ${value:-<missing>}"
  fi
done
# …and the YAML must not have grown a second copy of the renderer.
if [ "$(grep -c 'function tableForFormFactor' "$WORKFLOW")" = "0" ]; then
  pass "the renderer does not live in the workflow any more"
else
  fail "lighthouse.yml still defines tableForFormFactor — the extraction was undone or duplicated"
fi

# ⚠️ AN ABSOLUTE LITERAL, for the reason `check-docs-brain-snippets.test.sh`
# is the counter-example: a count derived from the cases cannot notice a deleted
# case.
EXPECTED_CASES=60
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES assertions ran"
else
  fail "expected $EXPECTED_CASES assertions, $TOTAL ran — one was added or deleted without updating EXPECTED_CASES"
fi

echo ""
echo "lighthouse-comment.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
