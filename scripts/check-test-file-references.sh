#!/bin/bash
# Verify that every `*.test.ts(x)` FILENAME mentioned in a comment or docstring
# still names a file that exists.
#
# WHY THIS EXISTS. Test files in this repo carry a lot of load-bearing prose:
# headers arguing why a suite is split from its sibling, source comments saying
# "X is pinned by foo.test.ts", ADRs naming the suite that proves a claim.
# None of it is checked by anything. When a test file is renamed or merged
# away, every pointer to it silently becomes a lie, and the next reader either
# hunts for a file that isn't there or — worse — believes a coverage claim that
# no longer holds.
#
# Measured 2026-09-04, folding 121 satellite suites into their canonical files:
# ~20 such pointers went stale in one change, 4 of them in production source
# (`lib/providers.ts`, `lib/settings.ts`, `lib/brain/staged-write.ts`,
# `api/routes/admin-email-provider.ts`). Every one had to be found by hand.
#
# WHAT IT DOES NOT DO. It does not check that the named file is *relevant*, only
# that it EXISTS. A pointer can still rot by staying valid and becoming wrong.
# This catches the cheap half, which is the half that was actually happening.
#
# PROVENANCE NOTES ARE THE POINT, NOT A VIOLATION. When a suite is merged the
# convention is to write "formerly foo.test.ts" in the target's header, so the
# history survives the move. Those deliberately name a file that no longer
# exists. The gate skips a mention when the SAME LINE (or the line above, since
# these wrap) carries a provenance marker — see PROVENANCE_RE below. That is
# the whole exemption; it is narrow on purpose, because "formerly" next to a
# name is a claim a reader can check, while a bare dangling name is not.

set -uo pipefail
cd "$(dirname "$0")/.."

# Words that mark a mention as historical rather than a live pointer.
PROVENANCE_RE='formerly|merged (in )?from|merged into|the former|renamed (from|to)|used to (be|live)|split out of|absorb(ed|s)|REMOVED:|deleted in favour of|since merged|was merged|moved (here|them)? ?from|\bmoved\b|\bborrowed\b|\babsorbed\b|\bthere from\b|its own coverage in'

# Mentions that EXPLICITLY say the file is absent. A note whose whole point is
# "this suite does not exist yet, and here is the gap that leaves" is not rot —
# it is the opposite, a named gap. Several mutation-table notes are of this
# kind, as is a header recording that an earlier draft cited the wrong name.
ABSENCE_RE='does not exist|does не exist|never existed|no such file|not add it|does not add|slice does not|an earlier version of this sentence named|which does not exist'

# Illustrative placeholders. Docs and gate scripts print example invocations
# ("bun test path/to/one.test.ts"), and a made-up name in an example is not a
# pointer to anything. Keep this list SHORT and generic-only: a name specific
# enough to be a real suite must never be added here — that is exactly the
# rot this gate exists to catch.
PLACEHOLDER_RE='^(file|a|b|i|n|one|two|name|subject|seam|thing|thing-pg|w[0-9]+|foo|bar|baz|example|my-?app|some|any|path|probe[0-9]*|sentinel)\.test\.tsx?$'

# Directories whose contents are generated or vendored.
is_scanned_path() {
  case "$1" in
    */node_modules/*|create-atlas/templates/*/*) return 1 ;;
    # `.claude/research/**` is an explicit HISTORY store — CLAUDE.md says the
    # ROADMAP archive is history and "nothing keeps it current". A past-tense
    # record naming the file that existed at the time is correct as written.
    .claude/research/*) return 1 ;;
    # Gate SELF-TESTS build synthetic fixture trees and echo fake runner output.
    # The suite names they invent are inputs to the gate under test, not pointers
    # into this repo, so scanning them reports the fixture rather than any rot.
    scripts/__tests__/*.test.sh|.claude/hooks/*.test.sh) return 1 ;;
    *.md|*.ts|*.tsx|*.js|*.sh) return 0 ;;
    *) return 1 ;;
  esac
}

# Build the set of test files that DO exist, keyed by basename.
declare -A EXISTS=()
while IFS= read -r f; do
  EXISTS["$(basename "$f")"]=1
done < <(git ls-files '*.test.ts' '*.test.tsx')

violations=0
scanned=0

while IFS= read -r file; do
  is_scanned_path "$file" || continue
  scanned=$((scanned + 1))

  # Read the whole file so context can be examined in BOTH directions. These
  # comments wrap, and the marker that makes a mention legitimate lands above
  # the name as often as below it ("moved\n * here from X", "an X on Y's
  # pattern), which this\n * slice does not add").
  mapfile -t LINES < "$file" || continue
  total=${#LINES[@]}

  for ((idx = 0; idx < total; idx++)); do
    line="${LINES[$idx]}"
    case "$line" in
      *.test.ts*) ;;
      *) continue ;;
    esac
    # Only comment / prose lines. A path in real code is already enforced by
    # the type-checker and the test runner.
    case "$line" in
      *"//"*|*"*"*|*"#"*|*'`'*|*'"'*|*"'"*) ;;
      *) continue ;;
    esac

    lo=$((idx - 3)); [ "$lo" -lt 0 ] && lo=0
    hi=$((idx + 3)); [ "$hi" -ge "$total" ] && hi=$((total - 1))
    context=""
    for ((c = lo; c <= hi; c++)); do context+="${LINES[$c]}"$'\n'; done

    for name in $(printf '%s\n' "$line" \
      | grep -oE '(^|[^A-Za-z0-9._*?$}{-])[A-Za-z0-9][A-Za-z0-9._-]*\.test\.tsx?' \
      | grep -oE '[A-Za-z0-9][A-Za-z0-9._-]*\.test\.tsx?'); do
      [ -n "${EXISTS[$name]:-}" ] && continue
      printf '%s' "$name" | grep -qE "$PLACEHOLDER_RE" && continue
      printf '%s' "$context" | grep -qiE "$PROVENANCE_RE" && continue
      printf '%s' "$context" | grep -qiE "$ABSENCE_RE" && continue
      echo "  $file:$((idx + 1)) — names '$name', which does not exist"
      echo "      $(printf '%s' "$line" | sed 's/^[[:space:]]*//' | cut -c1-140)"
      violations=$((violations + 1))
    done
  done
done < <(git ls-files)

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "check-test-file-references FAILED — $violations dangling reference(s) across $scanned file(s)."
  echo ""
  echo "Each line above names a *.test.ts file that no longer exists. Fix by either:"
  echo "  1. pointing it at the file that now holds those assertions, or"
  echo "  2. marking it historical — 'formerly <name>' — if it is a provenance note."
  echo ""
  echo "Do NOT satisfy this gate by deleting the sentence. The pointer is there"
  echo "because a reader needed it; a merge moved the target, it did not remove"
  echo "the need."
  exit 1
fi

echo "check-test-file-references passed — $scanned file(s) scanned, no dangling *.test.ts references."
