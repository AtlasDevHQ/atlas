#!/usr/bin/env bash
# Adversarial fixtures for scripts/check-agent-doc-paths.sh (#5299).
#
# ⚠️ "There is a test" is not the bar — *this mutant turns it red* is
# (docs/agents/practices.md). Every mutation below was APPLIED and OBSERVED, then
# reverted, on 2026-08-17:
#
#   mutation                                          →  observed
#   ────────────────────────────────────────────────     ────────────────────────
#   a real doc gains `packages/api/src/lib/semantic.ts`  gate exit 1, names
#     (the audit's own finding, re-introduced)             practices.md:99
#   report() pipes the matched line through cut -c1-140  case 6 FAIL (exit 1, but
#     (exactly what the hand check did)                    the tail is gone)
#   the route scan stops stripping comment lines         case 10 FAIL — exit 0, a
#                                                          deleted command blessed
#   the top-level-dir filter is dropped                  `lib/tools/sql.ts` and
#                                                          `db/connection.ts` both
#                                                          reported (case 4's class)
#   the suffix resolver is removed                       case 5 FAIL (exit 1 on a
#                                                          correct abbreviation)
#
# Cases 17-22 were added on 2026-08-18. Three of them cover states in which the
# gate reported "clean" while the very thing it exists to catch was present:
#
#   the trailing-comment sed is dropped                  case 17 FAIL — exit 0, a
#     from the route scan                                  deleted command blessed
#                                                          by a comment hanging off
#                                                          the END of a code line
#                                                          (case 10 covered only
#                                                          comment-ONLY lines)
#   `[ -e "$tok" ]` returns to path_resolves             case 19 FAIL — an
#                                                          UNTRACKED on-disk file
#                                                          answers the question, so
#                                                          local and CI disagree
#   the counts vacuity floor is deleted                  case 21 FAIL — exit 0
#                                                          while the summary claims
#                                                          five phrases verified and
#                                                          none was stated anywhere
#
# Cases 13c-13f were added on 2026-08-20, after TWO live claims in this repo's own
# docs were found to have been unchecked all along — both by hand, both while the
# gate reported clean:
#
#   the counts scan reverts to a raw            case 13c FAIL — exit 0 on a wrong
#     `git grep` line match                       count, because `**` sat between
#                                                 the number and the phrase
#   the line-joining window is removed          case 13d FAIL — exit 0 on a wrong
#                                                 count that wrapped across two
#                                                 lines, which is the ONLY live
#                                                 statement of it in practices.md
#   the match cursor advances past the          case 13f FAIL — exit 1 on CORRECT
#     match START instead of its END              prose, "43 …" also matching "3 …"
#
# Case 13e is their positive control. Both reds were confirmed against the OLD
# gate on 2026-08-20: with both claims mutated to a wrong number, it printed
# "no doc names a path, command or registered count that does not exist."
#
# Cases 18, 20 and 22 are the matching positive controls — a URL beside a route,
# a doc and its file committed together, every phrase stated correctly — so the
# reds above cannot be bought with a filter that simply reports more.
#
# Case 1 pins the real repo. Everything else builds a throwaway git tree,
# because the interesting answers are ones the real repo cannot produce.
#
# `set -uo pipefail`, no `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$SCRIPT_DIR/check-agent-doc-paths.sh"

[ -f "$GATE" ] || { echo "::error::gate under test not found at $GATE" >&2; exit 2; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

CASE_N=0
TREE=""

# A minimal but REAL tree: the gate reads the tracked file set through git, and
# its count derivations read four specific sets. Every case starts from this and
# then adds the one thing it is about.
new_tree() {
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE"/{docs/adr,docs/agents,packages/api/src/lib/plugins,plugins/chat/src/adapters,.claude/commands,.claude/research,scripts}
  echo "# adr" > "$TREE/docs/adr/0001-first.md"
  echo "# release runbook" > "$TREE/.claude/commands/release.md"
  echo "export const secrets = 1;" > "$TREE/packages/api/src/lib/plugins/secrets.ts"
  echo "export const slack = 1;" > "$TREE/plugins/chat/src/adapters/slack.ts"
  # Route source lives where routes live. NOT under scripts/ — the resolver
  # excludes that tree, because this suite plants deleted commands there as test
  # data and the gate must not read its own fixtures as evidence.
  mkdir -p "$TREE/packages/api/src/api/routes"
  echo 'app.get("/health", ok);' > "$TREE/packages/api/src/api/routes/server.ts"
  # The gate derives its registered counts from the tree, and refuses to check a
  # claim against a derivation of zero — so the tree must carry one of each set
  # it counts, including a ci-local roster.
  printf 'launch lint g_lint\n' > "$TREE/scripts/ci-local.sh"
  {
    echo "| Context | Governed by | Notes |"
    echo "| --- | --- | --- |"
    echo '| Only | `CONTEXT.md` § Only | one row |'
  } > "$TREE/CONTEXT-MAP.md"
  : > "$TREE/ALLOW.txt"
  ( cd "$TREE" && git init -q . && git add -A ) >/dev/null 2>&1
}

# Re-stage after writing a doc, so `git ls-files` and `git grep` can see it.
stage() { ( cd "$TREE" && git add -A ) >/dev/null 2>&1; }

run_gate() { # -> sets RC and OUT
  RC=0
  OUT=$(AGENT_DOC_PATHS_ROOT="$TREE" AGENT_DOC_PATHS_ALLOWLIST="$TREE/ALLOW.txt" bash "$GATE" 2>&1) || RC=$?
}

echo "check-agent-doc-paths.test.sh — adversarial fixtures (#5299)"

# 1. THE REAL REPO — the assertion that matters in practice. The acceptance
# criterion is that main is clean, so a violation landing later fails here too.
rc_real=0
out_real=$(bash "$GATE" 2>&1) || rc_real=$?
if [ "$rc_real" = "0" ]; then
  pass "the real repo names no missing path, command or registered count"
else
  fail "the real repo — expected exit 0, got $rc_real"
  printf '%s\n' "$out_real" | sed 's/^/       | /' >&2
fi

# 2. POSITIVE CONTROL on a synthetic tree, so case 3's red is not the only signal.
new_tree
echo 'See `plugins/chat/src/adapters/slack.ts` for the adapter.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "a doc citing a path that EXISTS passes"
else
  fail "existing-path doc — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 3. THE DEFECT this gate was filed for: a doc citing a path that is gone.
# Mutation: delete the file the doc names → this case turns red.
new_tree
echo 'See `packages/api/src/lib/semantic.ts` for the module map.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "docs/agents/x.md" \
   && printf '%s' "$OUT" | grep -qF "packages/api/src/lib/semantic.ts"; then
  pass "a doc citing a DELETED repo-rooted path is caught and named (exit $RC)"
else
  fail "deleted-path doc — expected exit 1 naming the file and the path, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 4. ⚠️ THE FALSE-POSITIVE CASE, and the whole reason the naive version was
# unusable: docs abbreviate. `lib/tools/sql.ts` is NOT repo-rooted, so it is
# never a candidate. A regression that drops the top-level-dir filter turns this
# red — which is the point of asserting it rather than trusting it.
new_tree
echo 'The validator lives in `lib/tools/sql.ts`, called from `db/connection.ts`.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "an ABBREVIATED (non-repo-rooted) reference produces no finding"
else
  fail "abbreviated reference — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 5. …and the harder half of the same class, which the repo-rooted rule alone
# gets WRONG: `plugins/` and `scripts/` are top-level directories AND common
# sub-directory names, so `plugins/secrets.ts` is a repo-rooted-looking
# abbreviation of packages/api/src/lib/plugins/secrets.ts. Measured on the real
# repo: 77 of 230 findings were this shape.
new_tree
echo 'Credentials are sealed in `plugins/secrets.ts`.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "a repo-rooted-LOOKING abbreviation that suffix-matches a real file passes"
else
  fail "suffix abbreviation — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 6. ⚠️ NEVER TRUNCATE. The hand check that missed six live references piped
# through `cut -c1-140`: it MATCHED the lines and then declared the visible
# prefix a false positive. Mutation: pipe report()'s output through
# `cut -c1-140` → this case turns red.
new_tree
{
  printf 'A line whose interesting content sits a long way to the right. '
  printf 'Padding. %.0s' $(seq 1 20)
  printf 'The mover is `packages/api/src/lib/gone.ts`, deleted last week.\n'
} > "$TREE/docs/agents/x.md"
stage; run_gate
col=$(awk '{print index($0, "gone.ts")}' "$TREE/docs/agents/x.md")
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "deleted last week." && [ "$col" -gt 140 ]; then
  pass "a finding past column $col prints the COMPLETE line (never truncated)"
else
  fail "long-line finding — expected exit 1 and the line's tail in the output (match at col $col), got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 7. A GITIGNORED path is absent BECAUSE THAT IS THE RULE BEING STATED —
# CLAUDE.md's "never edit create-atlas/templates/nextjs-standalone/src/".
new_tree
echo "packages/api/generated/" > "$TREE/.gitignore"
echo 'Never edit `packages/api/generated/` — it is regenerated at build time.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "a gitignored path is not a finding (the rule that names it stays true)"
else
  fail "gitignored path — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 8. THE SECOND CLASS: a reference to a DELETED COMMAND. Five of the six live
# references the audit found were this, and a path-only check misses all five.
new_tree
echo 'Then `/pr` to open the PR, and `/reset` afterwards.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF '/pr' && printf '%s' "$OUT" | grep -qF '/reset'; then
  pass "references to deleted COMMANDS are caught (exit $RC)"
else
  fail "deleted commands — expected exit 1 naming /pr and /reset, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 9. A LIVE command, and a route that exists in source, are both fine.
new_tree
echo 'Run `/release` when green; the API answers `/health`.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "a live command and a real route both resolve"
else
  fail "live command + route — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 10. ⚠️ A MARKDOWN BACKTICK IN A CODE COMMENT IS NOT A ROUTE. This is the gate's
# own near-miss: the first cut resolved `/review-panel` — a deleted command —
# because a TS comment in a test file mentioned it in backticks, and the route
# scan read comments. Mutation: drop the comment-stripping grep → this goes green
# and the deleted command is silently blessed.
new_tree
printf '// see the `/pr` flow for context\nexport const x = 1;\n' > "$TREE/packages/api/src/lib/note.ts"
echo 'Then `/pr` to open the PR.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF '/pr'; then
  pass "a backticked mention inside a CODE COMMENT does not resolve a command"
else
  fail "comment mention — expected exit 1 for /pr, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 11. THE CONVENTION the failure message teaches: a historical reference written
# WITHOUT backticks is not a live claim, and is not flagged.
new_tree
echo 'The old packages/api/src/lib/semantic.ts module map is gone; /pr was deleted too.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "a historical reference without backticks is not a finding"
else
  fail "un-backticked historical reference — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 12. THE ARCHIVES are excluded by scan-set decision: `.claude/research/**` is
# the record, where a reference to a since-deleted path is CORRECT.
new_tree
echo 'The audit found `packages/api/src/lib/semantic.ts` had moved.' > "$TREE/.claude/research/audit.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "the .claude/research archive is not scanned"
else
  fail "archive exclusion — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 13. COUNTS. "eight operational runbooks" against one command file on disk.
new_tree
echo 'There are eight operational runbooks in .claude/commands/.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "eight operational runbooks"; then
  pass "a registered COUNT phrase with the wrong number is caught (exit $RC)"
else
  fail "wrong count — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 13b. …and the right number passes, so case 13 is not red for some other reason.
new_tree
echo 'There is one operational runbooks entry.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "the same phrase with the DERIVED number passes"
else
  fail "correct count — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 13c. COUNTS / MARKUP. The number and the phrase separated by bold markers.
# ⚠️ THIS WAS GREEN ON A WRONG CLAIM. The scan was `git grep` on
# `<number>[[:space:]]+<phrase>`, so CLAUDE.md's bolded copy went unchecked for
# days while both unbolded copies were flagged correctly. Reverting the scan to a
# raw line match turns this case red (verified 2026-08-20: exit 0, no finding).
new_tree
printf 'There are eight **operational** runbooks in .claude/commands/.\n' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "operational runbooks"; then
  pass "a count claim interrupted by **emphasis** is still checked (exit $RC)"
else
  fail "bold-interrupted count — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 13d. COUNTS / LINE BREAK. The number ends one line, the phrase opens the next.
# ⚠️ ALSO GREEN ON A WRONG CLAIM, and on the ONLY live statement of that count in
# docs/agents/practices.md. `git grep` is line-based; prose wraps. Removing the
# line-joining window turns this case red (verified 2026-08-20: exit 0).
new_tree
printf '`.claude/commands/` now holds **eight\noperational runbooks**.\n' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "operational runbooks"; then
  pass "a count claim wrapped across a line break is still checked (exit $RC)"
else
  fail "wrapped count — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 13e. POSITIVE CONTROL for 13c/13d, so neither red is bought by a scan that
# simply reports more: the same two shapes with the DERIVED number pass.
new_tree
printf 'There is one **operational** runbooks entry, and the tree now holds **one\noperational runbooks** entry.\n' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "bold and wrapped claims with the DERIVED number both pass"
else
  fail "positive control — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 13f. NO SUB-MATCH FABRICATION. A correct two-digit count must not also match on
# its own last digit. ⚠️ The first cut of the joining scan stepped one character
# past the match START rather than its END, so a correct "43 system-wide
# decisions" produced a second, fabricated finding reading "3 system-wide
# decisions" — a gate inventing failures on prose that was right, on three
# registered phrases at once. Restoring `off = st` turns this case red.
new_tree
# new_tree already plants release.md, so twelve more make thirteen — and 13 is
# chosen because its trailing digit, 3, is what the broken cursor re-matched.
mkdir -p "$TREE/.claude/commands"
for i in $(seq 1 12); do echo "runbook $i" > "$TREE/.claude/commands/c$i.md"; done
printf 'There are 13 operational runbooks.\n' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "a correct two-digit count does not also fail on its trailing digit"
else
  fail "sub-match fabrication — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 14. THE ALLOWLIST exempts, but only where it says and only with a reason.
new_tree
echo 'The fixture builds `packages/foo` and `packages/bar`.' > "$TREE/docs/agents/x.md"
echo 'path docs/agents/x.md packages/foo   # synthetic fixture path' > "$TREE/ALLOW.txt"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "packages/bar" \
   && ! printf '%s' "$OUT" | grep -qF 'names `packages/foo`'; then
  pass "an allowlisted path is exempt and its neighbour still fails"
else
  fail "allowlist exemption — expected exit 1 naming only packages/bar, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 14b. AN ENTRY WITH NO REASON IS A HARD ERROR, not a silent exemption — the
# reason is the only thing keeping the allowlist from becoming a findings dump.
new_tree
echo 'The fixture builds `packages/foo`.' > "$TREE/docs/agents/x.md"
echo 'path docs/agents/x.md packages/foo' > "$TREE/ALLOW.txt"
stage; run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "no reason"; then
  pass "an allowlist entry with no reason fails the gate (exit 2)"
else
  fail "reasonless allowlist entry — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 14c. …and the file-glob is scoped: the same token elsewhere is still a finding.
new_tree
echo 'The fixture builds `packages/foo`.' > "$TREE/docs/agents/other.md"
echo 'path docs/agents/x.md packages/foo   # only x.md may say this' > "$TREE/ALLOW.txt"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "docs/agents/other.md"; then
  pass "an allowlist entry scoped to one file does not exempt another"
else
  fail "allowlist scoping — expected exit 1 naming other.md, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 14d. THE FILE-WIDE WILDCARD, which exists for fixture INPUT — a file whose
# broken paths are test data, not claims. It must stay scoped to its file: this
# gate went red on its own fixture suite the moment that suite was committed, and
# the fix must not be a blanket exemption.
new_tree
echo 'A fixture writes `packages/api/src/lib/gone.ts` and `/pr` on purpose.' > "$TREE/docs/agents/fixture-input.md"
echo 'A real doc names `packages/api/src/lib/gone.ts` too.' > "$TREE/docs/agents/real.md"
echo '* docs/agents/fixture-input.md * # fixture input, not a claim' > "$TREE/ALLOW.txt"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "docs/agents/real.md" \
   && ! printf '%s' "$OUT" | grep -qF "fixture-input.md"; then
  pass "a file-wide '*' exemption covers its file (paths AND commands) and no other"
else
  fail "wildcard scoping — expected exit 1 naming only real.md, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 15. ⚠️ VACUITY. A gate whose product is a NEGATIVE must not report it after
# reading nothing. An empty tree exits 2, not 0.
CASE_N=$((CASE_N + 1))
TREE="$TMPROOT/case$CASE_N"
mkdir -p "$TREE"
( cd "$TREE" && git init -q . ) >/dev/null 2>&1
: > "$TMPROOT/empty-allow.txt"
RC=0
OUT=$(AGENT_DOC_PATHS_ROOT="$TREE" AGENT_DOC_PATHS_ALLOWLIST="$TMPROOT/empty-allow.txt" bash "$GATE" 2>&1) || RC=$?
if [ "$RC" = "2" ]; then
  pass "an empty tree exits 2 (verified nothing), never 0"
else
  fail "vacuity floor — expected exit 2 on an empty tree, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 16. NOT A GIT WORK TREE — the gate reads the file set through git, so it must
# say it cannot look rather than pass.
CASE_N=$((CASE_N + 1))
TREE="$TMPROOT/case$CASE_N"
mkdir -p "$TREE"
RC=0
OUT=$(AGENT_DOC_PATHS_ROOT="$TREE" AGENT_DOC_PATHS_ALLOWLIST="$TMPROOT/empty-allow.txt" bash "$GATE" 2>&1) || RC=$?
if [ "$RC" = "2" ]; then
  pass "a non-git directory exits 2"
else
  fail "non-git root — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 17. ⚠️ THE TRAILING HALF OF CASE 10. That case proves a comment-ONLY line does
# not resolve a route. It left the identical hole one column over: a comment
# hanging off the END of a code line is not a comment-only line, so a deleted
# command named in backticks there still resolved — silently blessing every
# reference to it in the repo. Mutation: drop the trailing-comment sed from the
# route scan → this goes green.
new_tree
printf 'export const x = 1; // legacy alias for `/pr`, removed in the burn\n' \
  > "$TREE/packages/api/src/lib/plugins/note.ts"
echo 'Then `/pr` to open the PR.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF '/pr'; then
  pass "a TRAILING code comment does not resolve a command either"
else
  fail "trailing comment — expected exit 1 for /pr, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 18. …and the filter must not eat real routes. `https://` is not a comment, and
# a start-of-string route on the same line as a URL must still resolve.
new_tree
printf 'const base = "https://api.example.com/health";\napp.get("/claim", ok);\n' \
  > "$TREE/packages/api/src/api/routes/urls.ts"
echo 'Hit `/claim` and `/health` to check.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "stripping trailing comments does not eat routes beside a URL"
else
  fail "URL false positive — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 19. ⚠️ AN UNTRACKED FILE IS NOT AN ANSWER. path_resolves used to test the
# working directory first, so a file present in one checkout and absent in
# another gave two different verdicts for the same commit — green locally, red in
# CI. The file below exists on disk and is deliberately NOT staged.
new_tree
mkdir -p "$TREE/packages/api/src/lib/ghost"
echo "export const g = 1;" > "$TREE/packages/api/src/lib/ghost/only-on-disk.ts"
echo 'See `packages/api/src/lib/ghost/only-on-disk.ts` for the detail.' > "$TREE/docs/agents/x.md"
( cd "$TREE" && git add docs/agents/x.md ) >/dev/null 2>&1
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF 'only-on-disk.ts'; then
  pass "an untracked on-disk file does not resolve a reference (local == CI)"
else
  fail "untracked resolution — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 20. …and staging it — writing the doc and the file it names in ONE commit — is
# the normal workflow and must pass.
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "staging that same file in the same commit resolves it"
else
  fail "staged resolution — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 21. ⚠️ THE COUNTS VACUITY FLOOR. Checks 1 and 2 each refuse to report "clean"
# after reading nothing; check 3 did not. A registered phrase that matched
# NOWHERE produced no iterations, no finding and no warning — while the summary
# line kept printing "5 registered phrases checked". Two of the five phrases
# ("bounded contexts", "system-wide decisions") appear exactly ONCE in the real
# repo, so rewording one sentence retired two checks silently.
#
# The floor only applies to a real-sized tree (a fixture legitimately cites
# little), so this case has to build one. Mutation: delete the floor → exit 0,
# and the gate reports five phrases verified having verified none.
big_tree() { # a tree over the gate's BIG_TREE threshold, otherwise identical
  new_tree
  mkdir -p "$TREE/filler"
  for i in $(seq 1 250); do echo "filler $i" > "$TREE/filler/f$i.md"; done
  # A tree this size must cite SOMETHING, or the path and command floors fire
  # first and case 21 would pass on the wrong error. Both references below
  # resolve, so the only thing left unstated is the counts.
  {
    echo 'Secrets live in `packages/api/src/lib/plugins/secrets.ts`.'
    echo 'Run `/release` to cut a tag.'
  } > "$TREE/docs/agents/refs.md"
  ( cd "$TREE" && git add -A ) >/dev/null 2>&1
}

big_tree
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF 'appears nowhere'; then
  pass "a registered count phrase nothing states exits 2, never 0"
else
  fail "counts vacuity floor — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 22. …and the positive control, so case 21's red means the floor and not some
# other breakage: state every registered phrase, with the number DERIVED from
# this tree rather than hardcoded here.
big_tree
n_cmd=$(ls -1 "$TREE"/.claude/commands/*.md 2>/dev/null | wc -l | tr -d ' ')
n_adr=$(ls -1 "$TREE"/docs/adr/[0-9]*.md 2>/dev/null | wc -l | tr -d ' ')
n_ada=$(ls -1 "$TREE"/plugins/chat/src/adapters/*.ts 2>/dev/null | grep -vcE '\.test\.ts$|/index\.ts$')
n_gate=$(grep -cE '^[[:space:]]*(launch|run_fg) ' "$TREE/scripts/ci-local.sh")
n_ctx=$(awk '/^\| Context \| Governed by/{t=1;next} t&&/^\| --- /{next} t&&/^\|/{n++} t&&!/^\|/{t=0} END{print n+0}' "$TREE/CONTEXT-MAP.md")
{
  echo "This tree has $n_cmd operational runbooks and $n_ctx bounded contexts."
  echo "It holds $n_adr system-wide decisions, $n_ada chat-platform adapters and $n_gate ci-local gates."
} > "$TREE/docs/agents/counts.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "every registered phrase stated at its derived number passes"
else
  fail "counts positive control — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 23. ⚠️ THE RESOLVER MUST NOT ACCEPT A BARE WORD BEFORE THE SLASH. The first
# cut's preceding-character class included `A-Za-z0-9_`, so every `word/name`
# substring in tracked source became a "route": an import specifier
# ("../src/authorize-url") answered /authorize, and SIX of the 26 deleted
# commands resolved off nothing but incidental text. Measured on the real repo: a
# doc naming /pr, /reset and /changelog — the exact three requirement 1 in the
# gate's header is written about — exited 0. Mutation: put `A-Za-z0-9_` back in
# the class → this goes green and the gate stops catching deleted commands.
new_tree
printf 'import { x } from "../src/authorize-url";\nexport const y = x;\n' \
  > "$TREE/packages/api/src/lib/plugins/imports.ts"
echo 'Run `/authorize` to start.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF '/authorize'; then
  pass "an import specifier is not a route (a bare word before the slash)"
else
  fail "bare-word resolver — expected exit 1 for /authorize, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 24. …and the sub-segment route it must keep. A quoted path is split on `/`, so
# a route that is not the first segment still resolves — the property a
# start-anchored match would lose, and the reason the permissive class existed.
new_tree
printf 'app.get("/api/v1/tables", ok);\n' > "$TREE/packages/api/src/api/routes/deep.ts"
echo 'Call `/tables` for the list.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "0" ]; then
  pass "a sub-segment of a quoted route path still resolves"
else
  fail "sub-segment route — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 25. ⚠️ THE GATE'S OWN FIXTURES ARE NOT EVIDENCE. This suite plants deleted
# commands as test data in tracked files under scripts/; before that tree was
# excluded from the resolver, /pr and /reset resolved off THESE LINES and the
# gate certified every reference to them repo-wide.
new_tree
mkdir -p "$TREE/scripts/__tests__"
printf 'echo %s > "$T/x.md"\n' "'Then \`/pr\` to open it.'" > "$TREE/scripts/__tests__/probe.test.sh"
echo 'Run `/pr` to open the PR.' > "$TREE/docs/agents/x.md"
stage; run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF '/pr'; then
  pass "a command planted in scripts/ as test data does not resolve itself"
else
  fail "scripts/ exclusion — expected exit 1 for /pr, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# ⚠️ AN ABSOLUTE LITERAL, for the reason its siblings carry one. PASS+FAIL is a
# tally of the cases that RAN; nothing above notices a case that silently stopped
# running — a `sed` whose anchor drifted, an `if` that can no longer be reached.
# A suite reporting "26 passed" while three cases quietly vanished reads exactly
# like success, which is the failure this whole directory exists to refuse.
EXPECTED_CASES=33
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES cases ran"
else
  fail "case count — expected $EXPECTED_CASES cases, $TOTAL ran (a case stopped running)"
fi

echo ""
echo "check-agent-doc-paths.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
