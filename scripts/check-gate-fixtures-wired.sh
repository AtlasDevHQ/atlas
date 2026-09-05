#!/usr/bin/env bash
# check-gate-fixtures-wired.sh — every adversarial fixture suite under
# scripts/__tests__/ must be RUN BY A WORKFLOW, not just by ci-local.sh (#5296).
#
# ## The class this closes, and how the shape changed
#
# CLAUDE.md is explicit that remote CI on the PR is the gate, not a local `/ci`.
# A fixture suite that only ever runs locally is a guard that measures nothing
# on the gate that decides whether code ships.
#
# When this was written, `ci.yml` ENUMERATED every suite as a named step while
# `ci-local.sh` GLOBBED the directory, so a new suite ran locally and silently
# never in CI — tracked by a hand-maintained census in a comment that had to be
# rewritten three times in the single PR that added this script. Both sides now
# run `scripts/run-gate-fixtures.sh`, which globs the directory, so a new suite
# is wired by construction. What a glob cannot guarantee is the REMAINDER:
#
#   • the runner itself must be invoked by some workflow outside a comment —
#     otherwise every suite it would run is unwired at once;
#   • a suite the runner SKIPS (`scripts/gate-fixtures-exclude.txt`: the CI
#     runner lacks a tool it needs) must be named by some OTHER workflow, the
#     one that installs the tool — `scan-image.test.sh` in image-scan.yml;
#   • an exclusion entry naming a suite the directory no longer has is stale.
#
# ## What counts as wired
#
# Any `.github/workflows/*.yml` that names the path OUTSIDE A COMMENT. Comments
# are stripped before matching because the first cut of this gate did not, and
# `image-scan.yml` and `lighthouse.yml` both carried a comment with the full
# path to a real suite — deleting either `run:` step left the gate green off
# the prose alone.
#
# Exit codes: 0 every suite is wired · 1 one or more is not, or an exclusion
# entry is stale · 2 this gate could not look (the directory or the workflows
# are missing, or an exclusion entry is malformed).
#
# Adversarial fixtures: scripts/__tests__/check-gate-fixtures-wired.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A seam, so the fixture suite can point this at a throwaway tree rather than
# rewriting tracked source.
ROOT="${GATE_FIXTURES_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

FIXTURE_DIR="$ROOT/scripts/__tests__"
WORKFLOW_DIR="$ROOT/.github/workflows"
RUNNER_REL="scripts/run-gate-fixtures.sh"
EXCLUDE_FILE="$ROOT/scripts/gate-fixtures-exclude.txt"

die() { echo "::error::[gate-fixtures-wired] $1" >&2; exit 2; }

[ -d "$FIXTURE_DIR" ] || die "missing $FIXTURE_DIR — this gate cannot verify anything."
[ -d "$WORKFLOW_DIR" ] || die "missing $WORKFLOW_DIR — this gate cannot verify anything."

shopt -s nullglob
FIXTURES=("$FIXTURE_DIR"/*.test.sh)
WORKFLOWS=("$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml)
shopt -u nullglob

# ⚠️ VACUITY FLOORS, both directions. A gate whose product is the negative
# "every suite is wired" must not emit it after finding no suites — the failure
# this whole family of guards exists to refuse.
if [ "${#FIXTURES[@]}" -eq 0 ]; then
  die "no *.test.sh under $FIXTURE_DIR — the glob found nothing, so this gate verified NOTHING."
fi
if [ "${#WORKFLOWS[@]}" -eq 0 ]; then
  die "no workflow files under $WORKFLOW_DIR — every suite would read as unwired for the wrong reason."
fi

# `sed 's/#.*//'` is crude — it would also cut a `#` inside a quoted string —
# but the error direction is LOUD: over-stripping can only make a real `run:`
# line unmatched, which reports a wired suite as unwired and fails the build.
# It cannot manufacture a false pass.
#
# ⚠️ PROCESS SUBSTITUTION, not a pipe: `sed … | grep -q` under `set -o pipefail`
# INVERTS — `grep -q` exits on its first match, `sed` takes SIGPIPE, and the
# pipeline's status is non-zero, so a MATCH reads as NO MATCH. Measured: it
# reported 18 of 24 suites unwired.
# workflow_naming <path> — the basename of the first workflow that names
# <path> outside a comment, or empty.
workflow_naming() {
  local needle="$1" wf
  for wf in "${WORKFLOWS[@]}"; do
    if grep -qF -- "$needle" <(sed 's/#.*//' "$wf"); then
      basename "$wf"; return 0
    fi
  done
  return 1
}

EXCLUDED=()
if [ -f "$EXCLUDE_FILE" ]; then
  while IFS= read -r line; do
    entry="$(printf '%s' "$line" | sed 's/#.*//' | tr -d '[:space:]')"
    [ -n "$entry" ] || continue
    if ! printf '%s' "$entry" | grep -qE '^[A-Za-z0-9_.-]+\.test\.sh$'; then
      die "$EXCLUDE_FILE: '$entry' is not a *.test.sh basename."
    fi
    EXCLUDED+=("$entry")
  done <"$EXCLUDE_FILE"
fi

in_list() { local needle="$1" item; shift; for item in "$@"; do [ "$item" = "$needle" ] && return 0; done; return 1; }

RUNNER_WF="$(workflow_naming "$RUNNER_REL" || true)"

echo "check-gate-fixtures-wired.sh — ${#FIXTURES[@]} fixture suite(s) vs ${#WORKFLOWS[@]} workflow file(s); runner wired by: ${RUNNER_WF:-NOTHING}"

UNWIRED=()
for fixture in "${FIXTURES[@]}"; do
  name="$(basename "$fixture")"
  rel="scripts/__tests__/$name"
  if in_list "$name" ${EXCLUDED[@]+"${EXCLUDED[@]}"}; then
    wired="$(workflow_naming "$rel" || true)"
    if [ -n "$wired" ]; then
      printf '  ok   %-46s %s (excluded from the runner)\n' "$name" "$wired"
    else
      echo "::error file=$rel::$name is excluded from $RUNNER_REL and no workflow under .github/workflows/ names it — it NEVER runs in CI, the gate that decides whether code ships." >&2
      UNWIRED+=("$rel")
    fi
  elif [ -n "$RUNNER_WF" ]; then
    printf '  ok   %-46s %s (via %s)\n' "$name" "$RUNNER_WF" "$RUNNER_REL"
  else
    echo "::error file=$rel::no workflow under .github/workflows/ runs $RUNNER_REL, so $name NEVER runs in CI — it passes locally via ci-local.sh and never on the gate that decides whether code ships." >&2
    UNWIRED+=("$rel")
  fi
done

STALE=()
for e in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do
  if [ ! -f "$FIXTURE_DIR/$e" ]; then
    echo "::error file=scripts/gate-fixtures-exclude.txt::$e is excluded but scripts/__tests__/ has no such suite — delete the entry." >&2
    STALE+=("$e")
  fi
done

echo ""
if [ "${#UNWIRED[@]}" -gt 0 ] || [ "${#STALE[@]}" -gt 0 ]; then
  [ "${#UNWIRED[@]}" -gt 0 ] && { echo "FAIL: ${#UNWIRED[@]} fixture suite(s) run locally but never in CI:" >&2; for f in "${UNWIRED[@]}"; do echo "  - $f" >&2; done; }
  [ "${#STALE[@]}" -gt 0 ] && echo "FAIL: ${#STALE[@]} stale entr(y/ies) in scripts/gate-fixtures-exclude.txt." >&2
  echo "Fix: keep $RUNNER_REL invoked from ci.yml's gate-fixtures job; an excluded suite needs a step in the workflow that installs its tool." >&2
  exit 1
fi
echo "check-gate-fixtures-wired.sh: all ${#FIXTURES[@]} fixture suite(s) are run by a workflow."
