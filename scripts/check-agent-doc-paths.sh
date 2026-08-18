#!/usr/bin/env bash
# check-agent-doc-paths.sh — a doc may not name a path, a command, or a count
# that does not exist (#5299).
#
# ## Why this exists
#
# The 2026-08-17 harness audit (#5298) found three false claims in the agent
# docs. All three were a documented path that no longer existed, and all three
# were found BY HAND. `docs/agents/practices.md` states the bar — *a rule with no
# gate and no measurement is a note* — and, until this file, that page's own
# claims were unenforced, which is the failure mode it describes.
#
# The audit then found six more of the same class one level down: the burn
# deleted 26 commands and left six live references to them, in
# `.claude/commands/`, `docs/development/` and shipped TypeScript.
#
# ## Three requirements, each from a way the HAND CHECK failed
#
# 1. **Never truncate a finding.** The manual grep piped through `cut -c1-140`.
#    It MATCHED `deps-update.md:96` and `release.md:117` — the `/pr`, `/reset`
#    and `/changelog` references simply sat past column 140, so the visible
#    prefix was declared a false positive. Every finding here prints the
#    complete matched line.
# 2. **Scan the whole repo.** The manual scan covered `.claude/**` and
#    `docs/agents/**`. Three of the six live references were in
#    `docs/development/**` and one was in shipped TypeScript. A hand-listed set
#    of directories is another claim nobody verifies, so this scans every
#    tracked text file (see EXCLUDED below for the two archives, and why).
# 3. **Paths are not the only thing that rots.** Five of those six were
#    references to a deleted COMMAND, which a path-only check misses entirely.
#    And the same audit found "14 chat components" against 42 on disk. So this
#    gate has three checks, not one:
#
#      paths     a backticked repo-rooted path that resolves to nothing
#      commands  a backticked `/name` that is no live command, skill or route
#      counts    a registered count phrase whose number ≠ the derived count
#
# ## What resolves, and why each rule is here
#
# PATHS. A candidate is a backticked token whose first segment is a real
# top-level directory (`packages/`, `docs/`, `.claude/`, …) — the separator the
# audit validated: every real finding was repo-rooted and every false positive
# was not. It resolves if ANY of these hold:
#
#   • it exists on disk;
#   • it is gitignored (`git check-ignore`) — CLAUDE.md's *"never edit
#     `create-atlas/templates/nextjs-standalone/src/`"* names a path that is
#     absent in a fresh checkout BECAUSE THAT IS THE RULE BEING STATED. Flagging
#     it would demand deleting a true and load-bearing warning;
#   • some tracked path ENDS WITH it at a segment boundary. This is the
#     abbreviation rule, and it is the one that makes a whole-repo scan usable.
#     Docs legitimately write `plugins/secrets.ts` for
#     `packages/api/src/lib/plugins/secrets.ts` and `scripts/mutate.ts` for
#     `packages/api/scripts/mutate.ts` — and `plugins/`, `scripts/`, `docs/` and
#     `public/` are all ALSO top-level directory names, so the repo-rooted rule
#     alone (measured: 230 findings) cannot tell an abbreviation from a claim.
#     Suffix matching is self-tuning rather than lax: a 2-segment abbreviation
#     matches easily, while `packages/api/src/lib/semantic.ts` — one of the three
#     real audit findings — would need a tracked path ending in all five
#     segments, and stays red;
#   • the same, with a known source extension appended (`plugins/duckdb/src/profiler`
#     for `…/profiler.ts`).
#
# Truncated at the first segment containing a glob or placeholder metacharacter,
# so `packages/api/src/lib/content-mode/*` checks the directory and
# `plugins/<name>/` checks `plugins`. Placeholders are not flagged; the directory
# they hang off still is, which is where the wrong-package moves showed up.
#
# COMMANDS. A candidate is a backticked single-segment `/name`. It resolves to a
# live `.claude/commands/<name>.md`, a live `.claude/skills/<name>/`, a string
# literal in tracked source (which is what an HTTP route looks like: `/health`,
# `/sse`, `/claim`), a Next.js app-router segment directory, or an allowlist
# entry. Measured on this repo: 197 candidates, 29 unresolved, and the residue is
# genuinely external — Telegram BotFather commands, upstream plugin skills.
#
# ⚠️ A HISTORICAL reference is not a false positive to be exempted. A doc
# describing what an audit found may legitimately name a deleted command; the
# convention is to write it WITHOUT backticks so it does not read as a live
# command. The hand-check confirmed that reads better anyway, and the failure
# message says so.
#
# COUNTS. Only the phrases in COUNT_CLAIMS below are checked, each against a
# derivation from the tree. This is deliberately a short registry and not a
# general "numbers in prose" check: a gate that claimed to verify counts while
# checking a heuristic subset would be making exactly the kind of unbacked claim
# it exists to catch. What is NOT registered is not checked, and the summary line
# says how many phrases are.
#
# Exit codes: 0 clean · 1 one or more findings · 2 this gate could not look.
#
# Allowlist: scripts/agent-doc-paths-allowlist.txt (every entry needs a reason).
# Adversarial fixtures: scripts/__tests__/check-agent-doc-paths.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A seam, so the fixture suite can point this at a throwaway git tree rather than
# rewriting tracked source.
ROOT="${AGENT_DOC_PATHS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ALLOWLIST="${AGENT_DOC_PATHS_ALLOWLIST:-$ROOT/scripts/agent-doc-paths-allowlist.txt}"

die() { echo "::error::[agent-doc-paths] $1" >&2; exit 2; }

[ -n "$ROOT" ] && [ -d "$ROOT" ] || die "ROOT '$ROOT' is not a directory."
cd "$ROOT" || die "could not enter ROOT '$ROOT'."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "'$ROOT' is not a git work tree — this gate reads the tracked file set via git."

# The two archives. Both are point-in-time records where a reference to a
# since-deleted path is CORRECT — `.claude/research/ROADMAP.md` is the record of
# measured findings this repo keeps deliberately, and `docs/research/` holds
# dated audits (persona-audit.md is stamped 2026-03-24 and names the docs pages
# it found missing, which is its whole product). Excluding them is a scan-set
# decision, not an allowlist: nothing inside them is a claim about today.
EXCLUDES=(':(exclude).claude/research' ':(exclude)docs/research')

# ── the allowlist ────────────────────────────────────────────────────────────
# Format, three whitespace-separated fields then a required `# reason`:
#   <kind> <file-glob|*> <token|*>   # why this is not a defect
# `kind` is `path`, `command`, `count`, or `*` for all three. An entry without a
# reason is a FAILURE, not a warning: the reason is the only thing that keeps the
# list from becoming a place to put findings.
#
# ⚠️ A `*` in the TOKEN field exempts a whole file, and exists for exactly one
# situation: a file whose content is deliberately-broken INPUT rather than a
# claim — this gate's own fixture suite, and this gate's own allowlist (whose
# token column is, necessarily, a list of paths that do not exist). Committing
# the fixture suite is what first turned this gate red on itself, which is the
# same shape check-gate-fixtures-wired.sh documents: the gate's fixtures are its
# subject. Use a specific token everywhere else.
ALLOW_KIND=(); ALLOW_FILE=(); ALLOW_TOKEN=()
if [ -f "$ALLOWLIST" ]; then
  lineno=0
  while IFS= read -r raw || [ -n "$raw" ]; do
    lineno=$((lineno + 1))
    case "$raw" in ''|'#'*) continue ;; esac
    body="${raw%%#*}"
    reason="${raw#"$body"}"
    # shellcheck disable=SC2086 # deliberate word-splitting into the three fields
    # ⚠️ `set -f` first: a glob field (`.claude/skills/impeccable/*`, or a bare
    # `*`) would otherwise be EXPANDED against the cwd here, turning one entry
    # into dozens of fields and failing the arity check on a valid line.
    set -f
    set -- $body
    set +f
    if [ "$#" -ne 3 ]; then
      die "$ALLOWLIST:$lineno: expected '<kind> <file-glob> <token>  # reason', got: $raw"
    fi
    if [ -z "${reason//[#[:space:]]/}" ]; then
      die "$ALLOWLIST:$lineno: entry has no reason after '#'. An allowlist entry without a reason is a finding in hiding: $raw"
    fi
    case "$1" in path|command|count|'*') ;; *) die "$ALLOWLIST:$lineno: unknown kind '$1' (expected 'path', 'command', 'count' or '*')." ;; esac
    ALLOW_KIND+=("$1"); ALLOW_FILE+=("$2"); ALLOW_TOKEN+=("$3")
  done < "$ALLOWLIST"
fi

is_allowed() { # is_allowed KIND FILE TOKEN
  local kind="$1" file="$2" tok="$3" i
  for i in "${!ALLOW_KIND[@]}"; do
    [ "${ALLOW_KIND[$i]}" = "$kind" ] || [ "${ALLOW_KIND[$i]}" = "*" ] || continue
    [ "${ALLOW_TOKEN[$i]}" = "$tok" ] || [ "${ALLOW_TOKEN[$i]}" = "*" ] || continue
    # shellcheck disable=SC2053 # glob match on the left is the point
    [[ "${ALLOW_FILE[$i]}" = "*" || "$file" == ${ALLOW_FILE[$i]} ]] || continue
    return 0
  done
  return 1
}

# ── the tracked-path universe ────────────────────────────────────────────────
TRACKED="$(mktemp)"; UNIVERSE="$(mktemp)"
trap 'rm -f "$TRACKED" "$UNIVERSE"' EXIT
git ls-files > "$TRACKED" || die "git ls-files failed."
# Directories are references too (`ee/src/proactive/`), and git tracks no
# directory entries — derive every ancestor path from the file list.
{ cat "$TRACKED"; awk -F/ '{p=""; for (i=1;i<NF;i++) { p=(p==""?$i:p"/"$i); print p }}' "$TRACKED"; } | sort -u > "$UNIVERSE"

TRACKED_N=$(wc -l < "$TRACKED")
# ⚠️ VACUITY FLOOR. A gate whose product is the negative "no doc names a missing
# path" must not emit it after reading nothing — the failure this whole family of
# guards exists to refuse.
[ "$TRACKED_N" -gt 0 ] || die "git ls-files returned no files — this gate would report 'clean' having verified NOTHING."

TOPDIRS="$(git ls-tree -d --name-only HEAD 2>/dev/null | tr '\n' '|' | sed 's/|$//')"
if [ -z "$TOPDIRS" ]; then
  # No commit yet (a fixture tree that only staged files) — derive from the index.
  TOPDIRS="$(awk -F/ 'NF>1 {print $1}' "$TRACKED" | sort -u | tr '\n' '|' | sed 's/|$//')"
fi
[ -n "$TOPDIRS" ] || die "could not derive the top-level directory set — every path candidate would be filtered out and the gate would pass vacuously."

echo "check-agent-doc-paths.sh — $TRACKED_N tracked files, top-level dirs: ${TOPDIRS//|/ }"

# A tree at or above this size is the real repo, not a fixture — see the scan-set
# floors below. Fixture trees are a few dozen files; this repo is thousands.
BIG_TREE=200

FINDINGS=0

report() { # report FILE LINE MESSAGE
  # The complete matched line, never a window onto it (requirement 1).
  local file="$1" line="$2" msg="$3" full
  full="$(sed -n "${line}p" "$file" 2>/dev/null)"
  echo "::error file=$file,line=$line::$msg" >&2
  echo "  $file:$line: $msg" >&2
  echo "      | $full" >&2
  FINDINGS=$((FINDINGS + 1))
}

# ── check 1: repo-rooted paths ───────────────────────────────────────────────
EXTS=(.ts .tsx .js .mjs .cjs .md .mdx .json .yml .yaml .sh .sql .css .txt)

resolves_as_suffix() { # resolves_as_suffix TOKEN
  local tok="$1" esc
  esc="$(printf '%s' "$tok" | sed 's/[.[\*^$+?(){}|]/\\&/g')"
  grep -qE "(^|/)${esc}\$" "$UNIVERSE"
}

path_resolves() { # path_resolves TOKEN
  local tok="$1" ext
  [ -e "$tok" ] && return 0
  # Both forms: a `foo/` .gitignore rule matches the path only when git can see
  # it is a directory, and the path does not exist — so the trailing slash is
  # what makes `examples/nextjs-standalone/.next` resolve at all.
  git check-ignore -q "$tok" 2>/dev/null && return 0
  git check-ignore -q "$tok/" 2>/dev/null && return 0
  resolves_as_suffix "$tok" && return 0
  for ext in "${EXTS[@]}"; do
    resolves_as_suffix "$tok$ext" && return 0
  done
  return 1
}

PATH_CANDIDATES=0
while IFS= read -r row; do
  [ -n "$row" ] || continue
  file="${row%%$'\t'*}"; rest="${row#*$'\t'}"
  line="${rest%%$'\t'*}"; tok="${rest#*$'\t'}"
  PATH_CANDIDATES=$((PATH_CANDIDATES + 1))
  is_allowed path "$file" "$tok" && continue
  path_resolves "$tok" && continue
  report "$file" "$line" "names \`$tok\`, which is not a path in this repo (no file or directory, and nothing tracked ends with it)."
  echo "      → fix the path, or — if this is a HISTORICAL reference to something deleted — drop the backticks so it does not read as a live path." >&2
  echo "      → if it is deliberately illustrative, add it to scripts/agent-doc-paths-allowlist.txt with a reason." >&2
done < <(
  git grep -I -n -o -E '`[^`]+`' -- . "${EXCLUDES[@]}" 2>/dev/null |
  awk -v TOP="$TOPDIRS" '
    {
      i = index($0, ":"); f = substr($0, 1, i - 1); rest = substr($0, i + 1);
      j = index(rest, ":"); ln = substr(rest, 1, j - 1); tok = substr(rest, j + 1);
      gsub(/^`|`$/, "", tok);
      if (tok ~ /[[:space:]]/) next;
      if (tok !~ ("^(" TOP ")/")) next;
      # A trailing citation is not part of the path: file.ts:155-226, file.ts:fn(…)
      sub(/:[A-Za-z_][A-Za-z0-9_.-]*(\(.*)?$/, "", tok);
      sub(/:[0-9]+([-,][0-9]+)*$/, "", tok);
      sub(/[\\,;:.)\]!?]+$/, "", tok);
      sub(/\/$/, "", tok);
      # Truncate at the first glob/placeholder segment; the prefix is still a claim.
      n = split(tok, seg, "/"); out = "";
      for (k = 1; k <= n; k++) {
        if (seg[k] ~ /[*?\[\]{}<>$|]|\.\.\.|…/) break;
        out = (out == "" ? seg[k] : out "/" seg[k]);
      }
      if (out == "" || out !~ /\//) next;   # a bare top-level dir claims nothing
      print f "\t" ln "\t" out;
    }' | sort -u
)

# ⚠️ SECOND VACUITY FLOOR, on the SCAN SET rather than the extractor (the
# extractor has its own self-test above, which runs on every tree). A repo of
# this size that yields no repo-rooted candidate means the pathspec or the
# exclusions swallowed the scan — every check would then pass while verifying
# nothing. The threshold exists because a fixture tree legitimately has few
# candidates and must not be forced to fabricate them.
if [ "$TRACKED_N" -ge "$BIG_TREE" ] && [ "$PATH_CANDIDATES" -eq 0 ]; then
  die "no repo-rooted path candidates across $TRACKED_N tracked files. A tree this size cites hundreds, so the scan set is broken, not clean."
fi

# ── check 2: commands and skills ─────────────────────────────────────────────
# Route literals: what an HTTP route looks like in source. `/health` appears as
# "/health" somewhere in the code that serves it; `/pr` does not appear anywhere.
ROUTE_LITERALS="$(mktemp)"; APP_SEGMENTS="$(mktemp)"
trap 'rm -f "$TRACKED" "$UNIVERSE" "$ROUTE_LITERALS" "$APP_SEGMENTS"' EXIT
# Two filters, and each one was measured against a way this check went wrong.
#
# ⚠️ COMMENT LINES ARE STRIPPED. A markdown backtick inside a TS comment looks
# exactly like a route in source — the comment `* as \`/review-panel\` Step 6` in
# a test file made a DELETED COMMAND resolve, silently, which is this gate's own
# failure mode.
#
# ⚠️ A ROUTE SEGMENT, NOT A WORD STARTING WITH A SLASH. The match must be
# preceded by a quote (the start of a path string: `"/health"`) or by another
# path segment (`/api/v1/tables`, `/{id}/retract`, `/cards/*/render`,
# `/integrations/:platform/install-form`). Half this repo's routes are
# sub-segments, so a start-of-string-only match reported 27 live routes as
# missing commands; but accepting a bare `/name` anywhere in source is too much
# the other way — `<InlineCode>/ship-issue</InlineCode>` in a blog page then
# resolves a command that was deleted, which is the finding, not the exemption.
git grep -I -h -E "/[a-z][a-z0-9-]*" -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.json' '*.yml' '*.yaml' '*.sh' '*.sql' '*.css' 2>/dev/null |
  grep -vE '^[[:space:]]*(//|\*|/\*|#)' |
  grep -o -E "[]\"'\`A-Za-z0-9_})*]/[a-z][a-z0-9-]*" |
  sed -E 's/^.//' | sort -u > "$ROUTE_LITERALS"
# Next.js app-router segments: `/create-org` is a directory, not a string.
grep -oE '(^|/)app/(\([^/]*\)/)*[a-z][a-z0-9-]*/(page|route)\.(tsx?|jsx?)$' "$TRACKED" |
  sed -E 's:.*/([a-z][a-z0-9-]*)/(page|route)\..*:/\1:' | sort -u > "$APP_SEGMENTS"

command_resolves() { # command_resolves /NAME
  local tok="$1" name="${1#/}"
  [ -f ".claude/commands/$name.md" ] && return 0
  [ -d ".claude/skills/$name" ] && return 0
  grep -qxF -- "$tok" "$ROUTE_LITERALS" && return 0
  grep -qxF -- "$tok" "$APP_SEGMENTS" && return 0
  return 1
}

CMD_CANDIDATES=0
while IFS= read -r row; do
  [ -n "$row" ] || continue
  file="${row%%:*}"; rest="${row#*:}"
  line="${rest%%:*}"; tok="${rest#*:}"
  tok="${tok//\`/}"
  CMD_CANDIDATES=$((CMD_CANDIDATES + 1))
  is_allowed command "$file" "$tok" && continue
  command_resolves "$tok" && continue
  report "$file" "$line" "names the command \`$tok\`, and no .claude/commands/${tok#/}.md, no .claude/skills/${tok#/}/, no route literal and no app-router segment matches it."
  echo "      → 26 commands were deleted on 2026-08-17. If this is a HISTORICAL reference, drop the backticks so it does not read as a live command." >&2
  echo "      → if it is an external command (a Telegram BotFather command, an upstream plugin skill), add it to scripts/agent-doc-paths-allowlist.txt with a reason." >&2
done < <(git grep -I -n -o -E '`/[a-z][a-z0-9-]*`' -- . "${EXCLUDES[@]}" 2>/dev/null | sort -u)

if [ "$TRACKED_N" -ge "$BIG_TREE" ] && [ "$CMD_CANDIDATES" -eq 0 ]; then
  die "no \`/name\` candidates across $TRACKED_N tracked files. A tree this size is full of them, so the scan set is broken, not clean."
fi

# ── check 3: registered counts ───────────────────────────────────────────────
# Each row: <phrase>|<derivation>. The derivation is evaluated here, so the
# number in prose is checked against the tree rather than against another
# sentence. Keep the phrase distinctive enough that a number immediately before
# it is unambiguously a claim about that set.
count_commands()  { ls -1 .claude/commands/*.md 2>/dev/null | wc -l; }
count_adrs()      { ls -1 docs/adr/[0-9]*.md 2>/dev/null | wc -l; }
count_contexts()  { awk '/^\| Context \| Governed by/{t=1;next} t&&/^\| --- /{next} t&&/^\|/{n++} t&&!/^\|/{t=0} END{print n+0}' CONTEXT-MAP.md 2>/dev/null; }
count_adapters()  { ls -1 plugins/chat/src/adapters/*.ts 2>/dev/null | grep -vcE '\.test\.ts$|/index\.ts$'; }
# The ci-local roster. This number was a hand-maintained census in `.claude/commands/ci.md`
# that had to be rewritten three times in the PR that added check-gate-fixtures-wired,
# and again here when this gate joined stage 1. Every gate reaches the run through
# a `launch` or `run_fg` line, so the roster derives.
count_gates()     { grep -cE '^[[:space:]]*(launch|run_fg) ' scripts/ci-local.sh 2>/dev/null; }

COUNT_CLAIMS=(
  "operational runbooks|count_commands"
  "bounded contexts|count_contexts"
  "system-wide decisions|count_adrs"
  "chat-platform adapters|count_adapters"
  "ci-local gates|count_gates"
)

word_to_num() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    one) echo 1 ;; two) echo 2 ;; three) echo 3 ;; four) echo 4 ;; five) echo 5 ;;
    six) echo 6 ;; seven) echo 7 ;; eight) echo 8 ;; nine) echo 9 ;; ten) echo 10 ;;
    eleven) echo 11 ;; twelve) echo 12 ;; thirteen) echo 13 ;; fourteen) echo 14 ;;
    fifteen) echo 15 ;; sixteen) echo 16 ;; seventeen) echo 17 ;; eighteen) echo 18 ;;
    nineteen) echo 19 ;; twenty) echo 20 ;;
    *) printf '%s\n' "$1" ;;
  esac
}

NUMWORDS='one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty'
for claim in "${COUNT_CLAIMS[@]}"; do
  phrase="${claim%%|*}"; fn="${claim##*|}"
  expected="$("$fn")"
  if ! [ "$expected" -gt 0 ] 2>/dev/null; then
    die "the derivation for \"$phrase\" ($fn) produced '$expected'. A count claim checked against zero would pass nothing and fail everything — fix the derivation."
  fi
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    file="${row%%:*}"; rest="${row#*:}"; line="${rest%%:*}"; hit="${rest#*:}"
    stated="$(word_to_num "$(printf '%s' "$hit" | awk '{print $1}')")"
    [ "$stated" = "$expected" ] && continue
    is_allowed count "$file" "$phrase" && continue
    report "$file" "$line" "states \"$hit\" but the tree has $expected. ($fn)"
    echo "      → update the number, or the set it counts. Registered count phrases live in scripts/check-agent-doc-paths.sh." >&2
  done < <(git grep -I -n -o -iE "(${NUMWORDS}|[0-9]+)[[:space:]]+${phrase}" -- . "${EXCLUDES[@]}" 2>/dev/null | sed 's/^\([^:]*\):\([0-9]*\):/\1:\2:/' | sort -u)
done

# ── verdict ──────────────────────────────────────────────────────────────────
echo ""
echo "  paths:    $PATH_CANDIDATES repo-rooted candidates checked"
echo "  commands: $CMD_CANDIDATES \`/name\` candidates checked"
echo "  counts:   ${#COUNT_CLAIMS[@]} registered phrases checked (an unregistered count is NOT checked)"
echo "  allowlist: ${#ALLOW_KIND[@]} entries"

if [ "$FINDINGS" -gt 0 ]; then
  echo "" >&2
  echo "FAIL: $FINDINGS reference(s) name something that does not exist." >&2
  exit 1
fi
echo "check-agent-doc-paths.sh: no doc names a path, command or registered count that does not exist."
