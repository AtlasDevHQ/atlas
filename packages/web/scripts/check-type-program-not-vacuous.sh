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
#
# Parameterized for the adversarial fixture suite at root
# scripts/__tests__/check-type-program-not-vacuous.test.sh, which points the
# guard at a scaffolded synthetic tree instead of mutating the real tsconfigs:
#   TYPE_PROGRAM_GUARD_ROOT     — project dir to check (default: packages/web)
#   TYPE_PROGRAM_GUARD_MIN      — minimum src-file floor (default: 450)
#   TYPE_PROGRAM_GUARD_TEST_MIN — minimum test-file floor for the test-check
#                                 program (default: 200)

cd "${TYPE_PROGRAM_GUARD_ROOT:-$(dirname "$0")/..}"

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

# Must mirror the FIRST `tsgo --noEmit` invocation of the `type` script in
# package.json (the main-program check, implicit tsconfig.json; the script's
# second invocation is the test-check program, floored separately below) —
# if that first invocation ever grows `-p`/flags, change both.
files=$("$TSGO" --noEmit --listFilesOnly) || {
  echo "check-type-program-not-vacuous: FAIL — '$TSGO --noEmit --listFilesOnly' exited non-zero." >&2
  exit 1
}

# tsgo prints absolute paths; count this project's src files. -F because the
# resolved path is a literal, not a pattern.
# grep -c prints 0 before exiting 1 on no-match; only exit 1 is expected.
count=$(printf '%s\n' "$files" | grep -cF "$(pwd -P)/src/") || {
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

# The program is ~580 src files today. 450 allows real code shrinkage but
# trips on partial vacuation (a reference claiming a whole subtree like
# src/ui/** would drop hundreds of files), not just the total wipe-out.
min="${TYPE_PROGRAM_GUARD_MIN:-450}"
# A non-numeric floor would make `-lt` error out and the if-branch silently
# skip — a guard that cannot run must fail, not pass.
case "$min" in
  '' | *[!0-9]*)
    echo "check-type-program-not-vacuous: FAIL — non-numeric TYPE_PROGRAM_GUARD_MIN '$min'; guard could not run." >&2
    exit 1
    ;;
esac

if [ "$count" -lt "$min" ]; then
  echo "check-type-program-not-vacuous: FAIL — only $count files under $(pwd -P)/src in the type program (expected >= $min)." >&2
  echo "A tsconfig 'references'/include/exclude change likely re-vacuated the program (see #4447)," >&2
  echo "or tsgo's --listFilesOnly output format changed — inspect the raw file list." >&2
  exit 1
fi

# Also assert the test project (the tsgolint routing artifact the main
# config references — see tsconfig.test.json) still loads as a program, so
# the #4443 file->program routing can't silently break either.
"$TSGO" -p tsconfig.test.json --listFilesOnly > /dev/null || {
  echo "check-type-program-not-vacuous: FAIL — tsconfig.test.json no longer loads as a program (tsgolint test-file routing is broken; see #4443/#4447)." >&2
  exit 1
}

# #4450: floor the TEST-CHECK program the same way. Its file set is
# glob-driven (tsconfig.test.json's include, reused by tsconfig.test-check.json),
# so include/exclude rot — tests adopting a new suffix, an added exclude, a
# test root outside src/ — would shrink what `tsgo -p tsconfig.test-check.json`
# checks while the web `type` gate stays green: the exact #4447 failure mode,
# one config over. ~284 test files today; 200 allows churn but trips on rot.
test_files=$("$TSGO" -p tsconfig.test-check.json --listFilesOnly) || {
  echo "check-type-program-not-vacuous: FAIL — 'tsgo -p tsconfig.test-check.json --listFilesOnly' exited non-zero (the test type-check gate cannot run; see #4450)." >&2
  exit 1
}
test_count=$(printf '%s\n' "$test_files" | grep -cE '\.test\.(ts|tsx)$|/__tests__/') || {
  status=$?
  if [ "$status" -gt 1 ]; then
    echo "check-type-program-not-vacuous: FAIL — grep exited $status while counting test files; guard could not run." >&2
    exit 1
  fi
}
case "$test_count" in
  '' | *[!0-9]*)
    echo "check-type-program-not-vacuous: FAIL — non-numeric test-file count '$test_count'; guard could not run." >&2
    exit 1
    ;;
esac
test_min="${TYPE_PROGRAM_GUARD_TEST_MIN:-200}"
case "$test_min" in
  '' | *[!0-9]*)
    echo "check-type-program-not-vacuous: FAIL — non-numeric TYPE_PROGRAM_GUARD_TEST_MIN '$test_min'; guard could not run." >&2
    exit 1
    ;;
esac
if [ "$test_count" -lt "$test_min" ]; then
  echo "check-type-program-not-vacuous: FAIL — only $test_count test files in the test-check program (expected >= $test_min); tsconfig.test.json's include has rotted (see #4450)." >&2
  exit 1
fi

echo "check-type-program-not-vacuous: OK ($count src files, $test_count test files in the type programs)"
