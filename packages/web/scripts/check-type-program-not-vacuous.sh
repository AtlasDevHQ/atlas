#!/usr/bin/env bash
set -euo pipefail

# Guard against #4447: a tsconfig change can silently empty the main type
# program — project-reference semantics redirect any root file that a
# referenced composite project also claims OUT of the referencing program,
# so an over-broad include in tsconfig.test.json once left `tsgo --noEmit`
# checking zero project files while exiting green. Assert the program still
# contains a healthy number of this package's source files.
# --listFilesOnly skips the check phase, so this costs a small fraction of
# the full check.

cd "$(dirname "$0")/.."

if [ -x "node_modules/.bin/tsgo" ]; then
  TSGO="node_modules/.bin/tsgo"
elif [ -x "../../node_modules/.bin/tsgo" ]; then
  TSGO="../../node_modules/.bin/tsgo"
else
  TSGO="$(command -v tsgo)" || {
    echo "check-type-program-not-vacuous: FAIL — tsgo not found (looked in node_modules/.bin, ../../node_modules/.bin, PATH)." >&2
    exit 1
  }
fi

# Must mirror the `type` script's `tsgo --noEmit` invocation in package.json
# (same implicit tsconfig.json) — if that ever grows `-p`/flags, change both.
files=$("$TSGO" --noEmit --listFilesOnly) || {
  echo "check-type-program-not-vacuous: FAIL — '$TSGO --noEmit --listFilesOnly' exited non-zero." >&2
  exit 1
}

# grep -c prints 0 before exiting 1 on no-match; only exit 1 is expected.
count=$(printf '%s\n' "$files" | grep -c "packages/web/src/") || {
  status=$?
  if [ "$status" -gt 1 ]; then
    echo "check-type-program-not-vacuous: FAIL — grep exited $status while counting src files; guard could not run." >&2
    exit 1
  fi
}
case "$count" in
  '' | *[!0-9]*)
    echo "check-type-program-not-vacuous: FAIL — non-numeric count '$count'; guard could not run." >&2
    exit 1
    ;;
esac

# The program is ~580 src files today; 100 is a generous floor — vacuation
# drops it to ~0.
min=100

if [ "$count" -lt "$min" ]; then
  echo "check-type-program-not-vacuous: FAIL — only $count packages/web/src files in the type program (expected >= $min)." >&2
  echo "A tsconfig 'references'/include/exclude change likely re-vacuated the program (see #4447)," >&2
  echo "or tsgo's --listFilesOnly output format changed — inspect the raw file list." >&2
  exit 1
fi

echo "check-type-program-not-vacuous: OK ($count src files in the type program)"
