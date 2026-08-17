#!/usr/bin/env bash
# check-gate-fixtures-wired.sh — every adversarial fixture suite under
# scripts/__tests__/ must be RUN BY A WORKFLOW, not just by ci-local.sh (#5296).
#
# ## The class this closes, which is this repo's own, one level up
#
# `scripts/ci-local.sh` GLOBS `scripts/__tests__/*.test.sh`. `.github/workflows/ci.yml`
# ENUMERATES them by hand, one named step each. So a new suite runs locally and
# SILENTLY NEVER RUNS IN CI — and CLAUDE.md is explicit that remote CI on the PR
# is the gate, not a local `/ci`. A fixture suite that only ever runs locally is a
# guard that measures nothing on the gate that decides whether code ships.
#
# ⚠️ **It was tracked by a COMMENT, and the comment is why this exists.** `ci.yml`
# carried a hand-maintained census — *"There are 23 now, all covered: 22 named in
# this workflow plus scan-image.test.sh in image-scan.yml"* — which is a count a
# human has to re-derive on every addition. In the single PR that added this
# script that sentence had to be rewritten THREE times (20 → 22 → 23), and its
# accuracy was never checked by anything. Per this repo's own ratchet — *"when an
# audit finds the same class of drift in two separate runs, that's the signal to
# promote the check to a CI guard"* — a census edited three times in one change has
# cleared that bar.
#
# So: the census is DELETED and this guard replaces it. A number nothing verifies
# is exactly the shape the mutation gate exists to refuse, and it was sitting in
# the workflow that runs the mutation gate.
#
# ## What counts as wired
#
# Any `.github/workflows/*.yml` that names the suite's path. Not only `ci.yml` —
# `scan-image.test.sh` legitimately lives in `image-scan.yml`, and a future suite
# may belong to a workflow of its own. The question is "does SOME workflow run
# it", which is the property that matters.
#
# Exit codes: 0 every suite is wired · 1 one or more is not · 2 this gate could
# not look (the directory or the workflows are missing).
#
# Adversarial fixtures: scripts/__tests__/check-gate-fixtures-wired.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A seam, so the fixture suite can point this at a throwaway tree rather than
# rewriting tracked source.
ROOT="${GATE_FIXTURES_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

FIXTURE_DIR="$ROOT/scripts/__tests__"
WORKFLOW_DIR="$ROOT/.github/workflows"

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

echo "check-gate-fixtures-wired.sh — ${#FIXTURES[@]} fixture suite(s) vs ${#WORKFLOWS[@]} workflow file(s)"

UNWIRED=()
for fixture in "${FIXTURES[@]}"; do
  rel="scripts/__tests__/$(basename "$fixture")"
  wired=""
  for wf in "${WORKFLOWS[@]}"; do
    # `grep -qF` on the repo-relative PATH, not the bare basename: a workflow
    # COMMENT mentioning the file by name would satisfy a basename match, and a
    # comment does not run anything. The path as written in a `run:` line is the
    # thing that executes it.
    if grep -qF -- "$rel" "$wf"; then
      wired="$(basename "$wf")"
      break
    fi
  done
  if [ -n "$wired" ]; then
    printf '  ok   %-46s %s\n' "$(basename "$fixture")" "$wired"
  else
    echo "::error file=$rel::no workflow under .github/workflows/ runs $rel — it passes locally via ci-local.sh's glob and NEVER runs in CI, which is the gate that decides whether code ships." >&2
    UNWIRED+=("$rel")
  fi
done

echo ""
if [ "${#UNWIRED[@]}" -gt 0 ]; then
  echo "FAIL: ${#UNWIRED[@]} fixture suite(s) run locally but never in CI:" >&2
  for f in "${UNWIRED[@]}"; do echo "  - $f" >&2; done
  echo "Fix: add a step to the drift job in .github/workflows/ci.yml naming the path." >&2
  exit 1
fi
echo "check-gate-fixtures-wired.sh: all ${#FIXTURES[@]} fixture suite(s) are run by a workflow."
