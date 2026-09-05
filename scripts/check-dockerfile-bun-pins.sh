#!/usr/bin/env bash
# check-dockerfile-bun-pins.sh — every `Dockerfile*` that pins `oven/bun:` must
# pin the SAME version `.github/workflows/ci.yml` declares as `BUN_VERSION`.
#
# ## Why this is a script and not two inline copies
#
# This check lived twice: as a `run:` block in ci.yml's drift job and as
# `g_dockerfile_pins` in scripts/ci-local.sh, with a comment in the local copy
# saying it "must match ci.yml's copy". Nothing checked that it did. The two
# already differed on one input at the time of extraction — the workflow used
# `grep -o 'oven/bun:[0-9.]*'` and the local copy `grep -oE 'oven/bun:[0-9.]+'`,
# which disagree on a bare `oven/bun:` with no digits — and the class the fold
# of #5644 was about is exactly this: a base plus a satellite for one behaviour,
# each drifting on its own. One script, called from both.
#
# ## The shape that was missed before
#
# `-name 'Dockerfile*'`, NOT `-name Dockerfile`: the exact-name form silently
# skipped `create-atlas/templates/docker/Dockerfile.sidecar`, which pins
# `oven/bun:` like the other seven and was never checked until the bun 1.4.0
# bump (#2802). A scaffold shipping a stale runtime pin is the #4891 class.
#
# ## Seams (for the fixture suite)
#
#   DOCKERFILE_PINS_ROOT   tree to scan (default: this repo)
#   EXPECTED_BUN           version to require; when unset it is READ from
#                          `$ROOT/.github/workflows/ci.yml`, so the local run and
#                          the workflow can never disagree about the expectation
#
# Exit codes: 0 every pin matches · 1 one or more pins differ · 2 this gate could
# not look (no BUN_VERSION to read, or no Dockerfile pins bun at all — a "clean"
# verdict over zero files is the vacuity this repo's gates refuse).
#
# Adversarial fixtures: scripts/__tests__/check-dockerfile-bun-pins.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${DOCKERFILE_PINS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

die() { echo "::error::[dockerfile-bun-pins] $1" >&2; exit 2; }

[ -d "$ROOT" ] || die "missing tree $ROOT — this gate cannot verify anything."

expected="${EXPECTED_BUN:-}"
if [ -z "$expected" ]; then
  wf="$ROOT/.github/workflows/ci.yml"
  [ -f "$wf" ] || die "no EXPECTED_BUN in the environment and no $wf to read it from."
  expected="$(grep -E '^[[:space:]]*BUN_VERSION:' "$wf" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"
  [ -n "$expected" ] || die "could not read a BUN_VERSION: x.y.z line from $wf."
fi

errors=0
checked=0
while IFS= read -r f; do
  grep -q 'oven/bun:' "$f" || continue
  checked=$((checked + 1))
  actual="$(grep -oE 'oven/bun:[0-9.]+' "$f" | head -1 | cut -d: -f2)"
  if [ "$actual" != "$expected" ]; then
    echo "::error file=${f#"$ROOT"/}::Dockerfile pins bun '${actual:-<none>}', expected $expected"
    errors=$((errors + 1))
  fi
done < <(find "$ROOT" -name 'Dockerfile*' -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sort)

if [ "$checked" -eq 0 ]; then
  die "no Dockerfile* under $ROOT pins oven/bun: — the scan found nothing, so this gate verified NOTHING."
fi

if [ "$errors" -gt 0 ]; then
  echo "FAIL: $errors of $checked Dockerfile(s) pin a bun version other than $expected (BUN_VERSION in .github/workflows/ci.yml)." >&2
  exit 1
fi
echo "check-dockerfile-bun-pins.sh: all $checked Dockerfile(s) pin bun $expected"
