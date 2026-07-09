#!/usr/bin/env bash
set -euo pipefail

# Guard against #4447: a tsconfig change can silently empty the main type
# program — project-reference semantics redirect any root file that a
# referenced composite project also claims OUT of the referencing program,
# so an over-broad include in tsconfig.test.json once left `tsgo --noEmit`
# checking zero project files while exiting green. Assert the program still
# contains a healthy number of this package's source files.
# --listFilesOnly skips the check phase, so this costs well under a second.

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

files=$("$TSGO" --noEmit --listFilesOnly) || {
  echo "check-type-program-not-vacuous: FAIL — '$TSGO --noEmit --listFilesOnly' exited non-zero." >&2
  exit 1
}

count=$(printf '%s\n' "$files" | grep -c "packages/web/src/" || true)
min=100

if [ "$count" -lt "$min" ]; then
  echo "check-type-program-not-vacuous: FAIL — only $count packages/web/src files in the type program (expected >= $min)." >&2
  echo "A tsconfig 'references'/include/exclude change likely re-vacuated the program; see #4447." >&2
  exit 1
fi

echo "check-type-program-not-vacuous: OK ($count src files in the type program)"
