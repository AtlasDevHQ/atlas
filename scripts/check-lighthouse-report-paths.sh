#!/usr/bin/env bash
# check-lighthouse-report-paths.sh — the Lighthouse report path was duplicated
# EIGHT ways, and #4899 was born of exactly that shape: a `mv` target that no
# longer agreed with what lhci wrote (#5174).
#
# `lighthouserc.js`'s `upload.outputDir` is the source of truth. Every other site
# is a copy, and the copies fail SILENTLY in the direction that matters: if a
# copy moves and the rc config does not, `lhci` writes where it always did, the
# "Verify reports landed" step looks in the new place, finds nothing, and the
# comment renders its empty state — which is #4899's sentence, on a green run.
#
# ## The SSOT is EXECUTED, not grepped
#
# `outputDir` is a template literal interpolating a validated form factor, so a
# regex over the source would be pinning the spelling rather than the value.
# `require()`-ing the config with `LH_FORM_FACTOR` set yields the real derived
# path — and `lighthouse.yml` already shells to inline `node -e` for the same
# reason, so this is in-house style.
#
# ## The form-factor list is DERIVED FROM THE CONFIG'S OWN VALIDATION
#
# `Object.keys(PROFILES)` is not exported, so the config will not hand over its
# allowlist. But it THROWS `LH_FORM_FACTOR must be one of desktop, mobile; got:
# …` on an unknown value, and that message is generated from `PROFILES` itself.
# Parsing it is a derivation; writing `desktop mobile` here would be a ninth copy
# of the thing this gate exists to stop, in the gate. If the throw ever stops
# happening this exits 2 — an environment fault, not a verdict.
#
# ⚠️ The reverse direction is what nothing checked before: `lighthouserc.js`
# rejects an UNKNOWN form factor loudly, but a third profile ADDED to `PROFILES`
# gets no workflow step, no verify-loop iteration and no comment table, in
# silence. The `for ff in …` list and the renderer's `FORM_FACTORS` are both
# asserted against the config's list, so that class is closed too.
#
# ## Exit codes
#
#   0  every copy agrees
#   1  a copy DISAGREES — the verdict
#   2  this gate could not run (a missing file, an unparseable config)
#
# The split matters: `check-caddyfile.sh` established it, and collapsing them
# would make "I could not look" indistinguishable from "I looked and it is
# fine".
#
# Adversarial fixtures: scripts/__tests__/check-lighthouse-report-paths.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# An optional root argument, purely so the fixture suite can point this at a
# throwaway tree instead of rewriting tracked source (#5172's lesson — the same
# seam `check-caddyfile.sh` documents).
ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"

RC_CONFIG="$ROOT/lighthouserc.js"
WORKFLOW="$ROOT/.github/workflows/lighthouse.yml"
RENDERER="$ROOT/.github/scripts/lighthouse-comment.js"
GITIGNORE="$ROOT/.gitignore"
DOCS="$ROOT/apps/docs/content/self-hosted/contributing/ci.mdx"

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

die() { echo "::error::[lighthouse-paths] $1" >&2; exit 2; }

for f in "$RC_CONFIG" "$WORKFLOW" "$RENDERER" "$GITIGNORE" "$DOCS"; do
  [ -f "$f" ] || die "missing $f — this gate cannot verify the path closure."
done

command -v bun >/dev/null || die "bun is not on PATH; the config and renderer cannot be evaluated."

# ⚠️ **STDERR IS CAPTURED SEPARATELY, NEVER MERGED INTO THE DATA.** Every `bun -e`
# below has its stdout PARSED — a form-factor list, a path, a tab-separated
# table — so a single line bun writes to stderr on the SUCCESS path (a
# deprecation notice, a cold-start install log) becomes a data element. The worst
# case is not a cosmetic one: `ALLOWED`'s vacuity floor compares the DERIVED
# COUNT against 2, so stderr noise can carry a one-element derivation past the
# floor that exists to catch it. On the failure path the diagnostic is exactly
# what we want, and `die` prints it.
BUN_ERR="$(mktemp)"
trap 'rm -f "$BUN_ERR"' EXIT

# noise_check LABEL — a non-empty stderr on a SUCCESSFUL run is a warning, not a
# verdict, but it must not pass unremarked: it means the parsed stdout may have
# been polluted.
noise_check() {
  [ -s "$BUN_ERR" ] || return 0
  echo "::warning::[lighthouse-paths] $1 wrote to stderr on success — parsed output may be polluted:" >&2
  sed 's/^/  /' "$BUN_ERR" >&2
  : >"$BUN_ERR"
}

echo "check-lighthouse-report-paths.sh — lighthouserc.js is the SSOT for the report tree"

# --- 1. The form-factor allowlist, derived from the config's own throw --------
ALLOWED_RAW=$(
  cd "$ROOT" && LH_FORM_FACTOR=__not_a_form_factor__ bun -e '
    try {
      require("./lighthouserc.js");
    } catch (err) {
      const m = /must be one of ([^;]+);/.exec(String(err && err.message));
      if (m) {
        process.stdout.write(m[1].split(", ").join("\n"));
        process.exit(0);
      }
      process.stderr.write(`threw, but not the allowlist error: ${String(err && err.message)}\n`);
      process.exit(1);
    }
    process.stderr.write("lighthouserc.js accepted an invalid LH_FORM_FACTOR — the validation is gone\n");
    process.exit(1);
  ' 2>"$BUN_ERR"
) || die "could not derive the form-factor allowlist from lighthouserc.js: $(cat "$BUN_ERR")"
noise_check "the form-factor derivation"

mapfile -t ALLOWED <<<"$ALLOWED_RAW"
# ⚠️ A VACUITY FLOOR. An empty or one-element derivation would make every
# comparison below trivially agree — the same "an awk that matched nothing must
# not read as agreement" rule check-security-headers-drift.sh enforces.
if [ "${#ALLOWED[@]}" -lt 2 ]; then
  die "derived ${#ALLOWED[@]} form factor(s) from lighthouserc.js ('$ALLOWED_RAW'); expected at least 2 (desktop + mobile), so this gate would be vacuous."
fi
echo "  form factors (derived from lighthouserc.js): ${ALLOWED[*]}"

# --- 2. The SSOT path per form factor, and their common root -----------------
ROOTS=()
for ff in "${ALLOWED[@]}"; do
  OUT=$(
    cd "$ROOT" && LH_FORM_FACTOR="$ff" bun -e '
      const cfg = require("./lighthouserc.js");
      const dir = cfg && cfg.ci && cfg.ci.upload && cfg.ci.upload.outputDir;
      if (typeof dir !== "string" || dir === "") {
        process.stderr.write("ci.upload.outputDir is missing or not a string\n");
        process.exit(1);
      }
      process.stdout.write(dir);
    ' 2>"$BUN_ERR"
  ) || die "could not read ci.upload.outputDir for '$ff': $(cat "$BUN_ERR")"
  noise_check "the outputDir read for '$ff'"
  # The form factor must be the LAST segment, or "the root" is not well defined
  # and the workflow's `dir="<root>/$ff"` shape is wrong rather than merely
  # out of date.
  case "$OUT" in
    */"$ff") ROOTS+=("${OUT%/"$ff"}") ;;
    *) fail "lighthouserc.js outputDir for '$ff' is '$OUT', which does not end in '/$ff' — the workflow builds its paths as <root>/<form-factor>"; ROOTS+=("$OUT") ;;
  esac
done

REPORT_ROOT="${ROOTS[0]}"
for r in "${ROOTS[@]}"; do
  if [ "$r" != "$REPORT_ROOT" ]; then
    fail "lighthouserc.js derives more than one report root ('$REPORT_ROOT' and '$r'); every consumer assumes one"
  fi
done
[ -n "$REPORT_ROOT" ] || die "derived an EMPTY report root; every grep below would match everything."
echo "  report root (derived): $REPORT_ROOT"

# --- 3. The renderer agrees, by evaluation ----------------------------------
RENDERER_OUT=$(
  cd "$ROOT" && bun -e '
    const m = require("./.github/scripts/lighthouse-comment.js");
    if (typeof m.reportDir !== "function" || !Array.isArray(m.FORM_FACTORS)) {
      process.stderr.write("the renderer no longer exports reportDir() + FORM_FACTORS\n");
      process.exit(1);
    }
    process.stdout.write(
      [m.REPORT_ROOT, m.FORM_FACTORS.map((f) => `${f.key}\t${m.reportDir(f.key)}`).join("\n")].join("\n"),
    );
  ' 2>"$BUN_ERR"
) || die "could not evaluate the renderer's report paths: $(cat "$BUN_ERR")"
noise_check "the renderer evaluation"

RENDERER_ROOT=$(printf '%s\n' "$RENDERER_OUT" | head -1)
if [ "$RENDERER_ROOT" = "$REPORT_ROOT" ]; then
  pass "the renderer's REPORT_ROOT matches lighthouserc.js ($REPORT_ROOT)"
else
  fail "the renderer's REPORT_ROOT is '$RENDERER_ROOT' but lighthouserc.js derives '$REPORT_ROOT' — the comment would read an empty directory and render #4899's sentence"
fi

RENDERER_KEYS=$(printf '%s\n' "$RENDERER_OUT" | tail -n +2 | cut -f1 | LC_ALL=C sort | paste -sd' ' -)
CONFIG_KEYS=$(printf '%s\n' "${ALLOWED[@]}" | LC_ALL=C sort | paste -sd' ' -)
if [ "$RENDERER_KEYS" = "$CONFIG_KEYS" ]; then
  pass "the renderer renders a table for every form factor lighthouserc.js profiles ($CONFIG_KEYS)"
else
  fail "the renderer's FORM_FACTORS are '$RENDERER_KEYS' but lighthouserc.js profiles '$CONFIG_KEYS' — a profiled form factor with no table is measured and never reported"
fi

while IFS=$'\t' read -r key dir; do
  [ -n "$key" ] || continue
  if [ "$dir" = "$REPORT_ROOT/$key" ]; then
    pass "renderer reportDir('$key') = $dir"
  else
    fail "renderer reportDir('$key') is '$dir', expected '$REPORT_ROOT/$key'"
  fi
done < <(printf '%s\n' "$RENDERER_OUT" | tail -n +2)

# --- 4. The workflow's literals ---------------------------------------------
# ⚠️ **ANCHORED ON THE WHOLE LINE, not a substring, and an earlier draft of this
# block got that wrong in a way that mattered.** `grep -qF` is unanchored, so
# with `REPORT_ROOT=lighthouse-reports` both `name: lighthouse-reports-desktop`
# and `path: lighthouse-reports/desktop` MATCHED and PASSED while disagreeing
# with the config — the second narrowing the artifact to one form factor, a real
# regression this gate would have blessed. It caught a moved root and not an
# EXTENDED one, so two of the eight sites were unpinned while the header claimed
# eight. Two of the four literals are self-terminating (`dir="…/$ff"` closes on a
# quote, `find … -maxdepth 2` on the flag); the other two are not, and a
# whole-line anchor covers all four uniformly rather than by case analysis.
#
# `REPORT_ROOT` is derived from the config and contains no regex metacharacters
# today; `escape_re` keeps that from being an assumption.
escape_re() { printf '%s' "$1" | sed -e 's/[][\.*^$(){}?+|/]/\\&/g'; }
RE_ROOT="$(escape_re "$REPORT_ROOT")"

wf_line() { # wf_line DESCRIPTION EXTENDED_REGEX
  if grep -qE -- "$2" "$WORKFLOW"; then
    pass "lighthouse.yml $1"
  else
    fail "lighthouse.yml $1 — no line matching '$2'; it no longer agrees with lighthouserc.js"
  fi
}

# These two are substring-safe by construction (a closing quote / a following
# flag terminates them), so a literal match is already exact.
if grep -qF -- "dir=\"$REPORT_ROOT/\$ff\"" "$WORKFLOW"; then
  pass "lighthouse.yml the verify step's per-form-factor dir: dir=\"$REPORT_ROOT/\$ff\""
else
  fail "lighthouse.yml the verify step's per-form-factor dir does not contain 'dir=\"$REPORT_ROOT/\$ff\"' — it no longer agrees with lighthouserc.js"
fi
if grep -qF -- "find $REPORT_ROOT -maxdepth 2" "$WORKFLOW"; then
  pass "lighthouse.yml the verify step's diagnostic listing: find $REPORT_ROOT -maxdepth 2"
else
  fail "lighthouse.yml the verify step's diagnostic listing does not contain 'find $REPORT_ROOT -maxdepth 2' — it no longer agrees with lighthouserc.js"
fi
# …and these two are not: an extended root is a superset and would match a
# substring test.
wf_line "the artifact path is exactly $REPORT_ROOT/" "^[[:space:]]*path:[[:space:]]*${RE_ROOT}/[[:space:]]*$"
wf_line "the artifact name is exactly $REPORT_ROOT" "^[[:space:]]*name:[[:space:]]*${RE_ROOT}[[:space:]]*$"

# The verify step's own form-factor loop. Derived list, joined the way bash
# writes it.
WF_LOOP="for ff in $(printf '%s\n' "${ALLOWED[@]}" | paste -sd' ' -); do"
if grep -qF -- "$WF_LOOP" "$WORKFLOW"; then
  pass "lighthouse.yml verifies every profiled form factor ($WF_LOOP)"
else
  fail "lighthouse.yml has no '$WF_LOOP' — a form factor profiled in lighthouserc.js would be measured and never verified"
fi

# One `LH_FORM_FACTOR:` step env per form factor, and no others.
WF_FACTORS=$(grep -oE 'LH_FORM_FACTOR: [a-zA-Z0-9_-]+' "$WORKFLOW" | awk '{print $2}' | LC_ALL=C sort -u | paste -sd' ' -)
if [ "$WF_FACTORS" = "$CONFIG_KEYS" ]; then
  pass "lighthouse.yml runs lhci once per profiled form factor ($CONFIG_KEYS)"
else
  fail "lighthouse.yml runs LH_FORM_FACTOR '$WF_FACTORS' but lighthouserc.js profiles '$CONFIG_KEYS'"
fi

# --- 5. .gitignore, and the customer-facing claim ----------------------------
if grep -qxF -- "$REPORT_ROOT/" "$GITIGNORE"; then
  pass ".gitignore ignores $REPORT_ROOT/"
else
  fail ".gitignore has no '$REPORT_ROOT/' line — a local Lighthouse run would offer generated reports for commit"
fi

# ⚠️ The eighth copy, and the one the issue's list omitted: apps/docs asserts
# this path to CUSTOMERS. #5170 already had to fix a different false claim in
# this same file, so it is not a hypothetical drift site.
if grep -qF -- "$REPORT_ROOT/" "$DOCS"; then
  pass "apps/docs ci.mdx describes $REPORT_ROOT/"
else
  fail "apps/docs/content/self-hosted/contributing/ci.mdx no longer mentions '$REPORT_ROOT/' — the documented artifact path has drifted from the config"
fi

echo ""
echo "check-lighthouse-report-paths.sh: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "::error::[lighthouse-paths] $FAIL report-path site(s) disagree with lighthouserc.js's upload.outputDir. That config is the SSOT; fix the copies." >&2
  exit 1
fi
