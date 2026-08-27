#!/usr/bin/env bash
# PreToolUse/Bash guard: refuse local test invocations that either share global
# state (CLAUDE.md) or fan out to one worker per core and take the box down.
#
# Two separate rules, deliberately:
#   1. CORRECTNESS -- bare `bun test` shares one global across every file, so it
#      passes on state a sibling left behind. CLAUDE.md mandates --parallel.
#   2. BLAST RADIUS -- `--parallel` with no --changed is a whole-suite run:
#      one worker per core, which exhausts fds and can hang the machine.
#      `bun run test:api` reaches this shape THROUGH the package script, so
#      matching on the literal `bun test` text alone would miss it.
#
# Always allowed: NAMED test files (every positional must be one -- a glob is
# not, it expands at run time) and `--changed=<ref>` (the sanctioned pre-flight).
#
# `--parallel=N` for N <= 6 WITH an explicit target is NOT allowed outright: it
# returns `ask`, so the human decides, and it DENIES in any session where `ask`
# has not been shown to reach one. Remote CI on the PR is the real gate.
#
# Also refused: `bun test` with TEST_DATABASE_URL set -- the project memory
# names that shape specifically as the one a human stopped by hand.
# ⚠️ `-e` is deliberately ABSENT. Two spots depend on a non-zero exit being
# survivable: `[ "$cap" -le 6 ]` is expected to fail on a malformed cap, and a
# `grep | tail` pipeline can SIGPIPE, which `pipefail` reports non-zero. Adding
# `-e` turns this into a hook that exits before it can deny — failing OPEN.
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
[ -n "$cmd" ] || exit 0

# The permission mode this session is running in. PreToolUse carries it as a
# common input field -- MEASURED on 2026-08-26 by dumping the hook's stdin, not
# assumed: {"permission_mode":"bypassPermissions", ...}. It decides whether an
# `ask` from this hook can actually reach a human; see the escape hatch below.
mode="$(printf '%s' "$input" | jq -r '.permission_mode // empty' 2>/dev/null)"

deny() {
  jq -nc --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# `ask` routes to the user's own permission prompt instead of deciding for them.
# Verified against the hooks reference: `permissionDecision` takes
# allow/deny/ask/defer, and `"ask"` prompts the user to confirm.
#
# ⚠️ The reason string is written FOR THE HUMAN, not for Claude. The reference is
# explicit that for `"allow"` and `"ask"` the reason is "shown to the user but
# not Claude" (only a `"deny"` reason reaches Claude). So this text has to stand
# on its own in a prompt, and a rejected ask teaches the model nothing.
ask() {
  jq -nc --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# ---------------------------------------------------------------------------
# Strip anything that is DATA rather than a command before matching.
#
# `.tool_input.command` carries the text verbatim, so a plain grep cannot tell
# a MENTION from an INVOCATION: `git commit -m '... --parallel ...'`, an `echo`
# naming the command, and any heredoc documenting it all read identically to
# running it. Without this the guard blocks commit messages and doc edits --
# it blocked the very commit that introduced it, and then blocked the patch
# that fixed that, which is how this scrubber came to exist.
#
# Order matters: heredoc bodies first (they may themselves contain quotes),
# then quoted spans.
# ---------------------------------------------------------------------------
scrubbed="$(printf '%s\n' "$cmd" | awk '
  inhere {
    if ($0 == term) { inhere = 0 }
    next
  }
  {
    line = $0
    if (match(line, /<<-?[[:space:]]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/)) {
      tag = substr(line, RSTART, RLENGTH)
      sub(/^<<-?[[:space:]]*/, "", tag)
      gsub(/["'"'"']/, "", tag)
      if (tag != "") { inhere = 1; term = tag }
    }
    print line
  }
')"

# A mention inside quotes is an argument or a message, never the command word.
#
# ⚠️ PER LINE, deliberately. A previous commit joined every line with \x01 first
# so a quoted span could cross newlines — which fixed multi-line `git commit -m`
# bodies and BROKE the guard: two apostrophes on different lines then paired
# across the newline and deleted everything between them.
#
#     echo "it's fine"
#     bun test --parallel        <- scrubbed away entirely; ALLOW
#     echo "that's all"
#
# That is a false ALLOW, and a false ALLOW is what takes the box down. A false
# DENY costs a rephrase. So this scrubs line by line and fails closed, and a
# multi-line commit body quoting the command is written with `git commit -F -`
# and a heredoc, which the heredoc pass above already handles.
scrubbed="$(printf '%s' "$scrubbed" | sed -E "s/'[^']*'/ /g")"
scrubbed="$(printf '%s' "$scrubbed" | sed -E 's/"[^"]*"/ /g')"

# Split the compound command into segments so `cd x && bun test` is seen.
segments="$(printf '%s' "$scrubbed" | sed -E 's/(\&\&|\|\||[;|]|\n)/\n/g')"

while IFS= read -r seg; do
  [ -n "${seg// }" ] || continue

  # `bun run test`, `bun run test:api`, `bun run test:others`, and
  # `bun run --filter <pkg> test` all expand to a whole-suite `bun test --parallel`.
  if printf '%s' "$seg" | grep -qE '\bbun[[:space:]]+run[[:space:]]+(--filter[[:space:]]+\S+[[:space:]]+)?(test|test:api|test:others)([[:space:]]|$)'; then
    deny "BLOCKED: this expands to a whole-suite \`bun test --parallel\` (one worker per core; nproc=$(nproc) here), which exhausts file descriptors and can hang the machine.

Use the scoped pre-flight instead:
  cd packages/api && bun test --parallel --changed=origin/main
  bun run lint && bun run type && bun run lint:type-aware

Remote CI on the PR is the gate -- push, open a draft PR, let ci.yml run (~4 min, parallel)."
  fi

  printf '%s' "$seg" | grep -qE '\bbun[[:space:]]+test\b' || continue

  # --no-isolate trades per-file isolation for speed; at least one suite
  # (agent-compaction.test.ts) leaks module state across same-process runs.
  if printf '%s' "$seg" | grep -qE -- '--no-isolate'; then
    deny "BLOCKED: \`--no-isolate\` is forbidden (CLAUDE.md > Tests). It drops the fresh global + module registry per file, and agent-compaction.test.ts leaks module state across same-process runs today.

Drop the flag: \`bun test --parallel --changed=origin/main\`"
  fi

  # The project memory: "especially not with `TEST_DATABASE_URL` set". That run
  # points the real-Postgres suites at a live database, and the crash takes the
  # container down with the box -- destroying the database the run needed.
  args="$(printf '%s' "$seg" | sed -E 's/.*\bbun[[:space:]]+test\b//')"

  # --changed=<ref> bounds the run to the branch's source graph -- but only when
  # TEST_DATABASE_URL is absent. That graph was 874 files on a types-package
  # change today, which is whole-suite in every way that matters to the box.
  if printf '%s' "$args" | grep -qE -- '--changed(=|[[:space:]])' \
     && ! printf '%s' "$cmd" | grep -qE 'TEST_DATABASE_URL='; then
    continue
  fi

  # Count the positionals up front -- both the cap hatch and the named-file
  # allowance need them.
  #
  # ⚠️ A GLOB IS NOT A FILE. `src/lib/zzz/*.test.ts` is ONE token ending in
  # `.test.ts`, and bash expands it to N files when bun runs. Matching on the
  # suffix alone let a whole directory through under a filename -- the same
  # laundering shape as the quantifier hole, one character away.
  # ⚠️ `set -f` IS THE GLOB FIX. `for tok in $args` is unquoted, so without it
  # bash pathname-expands before the `case` arm ever sees a `*` — a glob that
  # MATCHES real files arrives as literal filenames, every one ending
  # `.test.ts`, and waltzes through. The arm below only ever fired on globs that
  # matched NOTHING, which is why its first two falsifiers used paths that do
  # not exist and passed for the wrong reason.
  positional_count=0
  nonfile_count=0
  skip_next=0
  set -f
  for tok in $args; do
    # A redirection TARGET (`out.log` in `> out.log`) is not an argument to bun.
    if [ "$skip_next" = "1" ]; then skip_next=0; continue; fi
    case "$tok" in
      -*) continue ;;
      # ⚠️ Redirections are not positionals. `bun test one.test.ts 2>&1` is the
      # most common shape there is, and counting `2>&1` as a non-file argument
      # denied it -- a gate that cries wolf on the everyday case is one people
      # route around, which is the failure mode this whole guard exists inside.
      *'>'*|*'<'*|'&'*)
        case "$tok" in
          *'>'|*'<') skip_next=1 ;;
        esac
        continue
        ;;
    esac
    positional_count=$((positional_count + 1))
    case "$tok" in
      # `{` catches brace expansion, which carries no glob metacharacter at all:
      # `src/f{1..500}.test.ts` reads as one filename and becomes 500 files.
      *'*'*|*'?'*|*'['*|*'{'*) nonfile_count=$((nonfile_count + 1)) ;;
      *.test.ts|*.test.tsx) ;;
      *) nonfile_count=$((nonfile_count + 1)) ;;
    esac
  done
  set +f


  # ---------------------------------------------------------------------
  # Named files are fine -- one file, one worker. But EVERY positional must
  # be one.
  #
  # ⚠️ This asked "does ANY argument look like a test file" until 2026-08-26,
  # which meant a single named file laundered any number of directory globs
  # beside it:
  #
  #   bun test --parallel src/app/admin/brain/__tests__/ ... coverage-statement.test.ts
  #
  # That is a full 32-worker run wearing one filename. It ran five times in a
  # single session and took the box down; this guard watched it go past every
  # time. Bare directory globs were already caught -- the mixed arg list was
  # the whole hole, which is why the fix is a quantifier and not a new rule.
  # ---------------------------------------------------------------------
  if [ "$positional_count" -gt 0 ] && [ "$nonfile_count" -eq 0 ]; then
    continue
  fi

  # TEST_DATABASE_URL, checked HERE and not earlier.
  #
  # ⚠️ Ordering is the whole point. A single named pg suite WITH the variable set
  # is exactly what the project memory sanctions — "Run a single pg suite
  # directly if you need one" — and it is what this hook's own deny text tells
  # you to do. An earlier draft ran this check before the named-file allowance
  # and so denied that instruction verbatim, which was caught by trying to
  # follow it. What is dangerous is the variable across an UNBOUNDED run: it
  # turns on every real-Postgres suite at once, and the crash takes the
  # container down with the box, destroying the database the run needed.
  #
  # Matched against the whole command rather than "$seg", because segments split
  # on `&&` and `export X=1 && bun test …` would otherwise put the assignment
  # out of view while bun still inherited it. Known limit either way: a variable
  # already exported in the parent shell, or sitting in `.env`, is invisible.
  if printf '%s' "$cmd" | grep -qE 'TEST_DATABASE_URL='; then
    deny "BLOCKED: TEST_DATABASE_URL is set on a run that is not bounded to named files. That turns on every real-Postgres suite at once, and when the box goes down it takes the container with it — destroying the database the run needed.

Bound it to the suite you actually want:
  TEST_DATABASE_URL=... bun test path/to/one-pg.test.ts

Remote CI runs these against a dedicated Postgres service -- that is the gate."
  fi



  # The sanctioned escape hatch, and it is TWO conditions, not one.
  #
  # The memory says: "If a full local run is ever genuinely necessary, ask
  # first, and cap the workers (`bun test --parallel=6`)." Until 2026-08-26 this
  # hook enforced only the cap and converted "ask first" into a standing grant:
  # it opened the hatch itself, silently, every time. A rule written as two
  # conditions shipped as one, and `--parallel=6 packages/` -- the whole
  # monorepo -- sat inside its letter.
  #
  # It now returns `ask`, which routes to the human's own permission prompt.
  # That is the "ask first" half, enforced rather than assumed.
  #
  # 6, not 8: 6 is the only number the record names. 8 was invented here and
  # nothing measures it.
  # The MAX of every occurrence. `head -1` let `--parallel=6 --parallel=64`
  # through on the safe one while bun (last-wins) ran 64.
  cap="$(printf '%s' "$args" | grep -oE -- '--parallel=[0-9]+' | cut -d= -f2 | sort -n | tail -1)"
  if [ -n "$cap" ] && [ "$cap" -le 6 ] 2>/dev/null && [ "$positional_count" -gt 0 ]; then
    # ⚠️ `ask` IS NOT UNIVERSALLY A PROMPT, and that is the whole reason this is
    # an allowlist rather than a plain `ask`.
    #
    # MEASURED 2026-08-26, in this repo, in a live session: with
    # `permission_mode: "bypassPermissions"`, a PreToolUse hook returning `ask`
    # did NOT prompt -- the command ran, with no notice and no log line. Under
    # bypass, `ask` IS `allow`. A control hook returning `deny` on a sibling
    # sentinel blocked in the same session, so the hook was loaded and firing;
    # it is `ask` specifically that the mode swallows.
    #
    # That is the exact failure this guard exists to prevent, wearing a gate's
    # clothes -- and every one of the three recurrences happened in an agent
    # session, which is where bypass is used. So the modes are ALLOWLISTED and
    # an unrecognised or absent mode DENIES. A mode this hook has not been shown
    # to prompt in is a mode where the hatch does not open.
    #
    # Listed on the reference's word, not on a measurement (this box only ever
    # runs bypass, so they could not be measured here): `default` and
    # `acceptEdits` prompt for Bash anyway, and `auto` is called out explicitly
    # -- a hook's `ask` "forces a permission prompt in auto mode: the classifier
    # can still deny the tool call, but it can't approve the call silently".
    # `plan`, `dontAsk` and headless are left OUT deliberately: nothing states
    # they prompt, and the cost of being wrong is one-directional.
    #
    # Worth stating plainly, because it bounds the risk of the whole change:
    # this is MONOTONIC. Every shape that was ALLOW here is now ASK or DENY, and
    # nothing that denied before is reachable as an allow. If `ask` turned out to
    # be silently permissive in a listed mode too, the hatch would be exactly as
    # permissive as it was yesterday -- never more.
    case "$mode" in
      default|acceptEdits|auto)
        ask "A capped breadth run: --parallel=$cap over $positional_count target(s).

The project memory allows this ONLY after asking -- \"if a full local run is ever genuinely necessary, ask first, and cap the workers\". The cap is honoured; this prompt is the other half.

Worth checking before you approve:
  - Is anything else already running? Three agents at --parallel=6 is 18 workers, and each command is individually legal. That is the shape that took the box down on 2026-08-26.
  - Would --changed=origin/main, or a few named files, answer the same question?

Remote CI on the PR is the real gate." ;;
      *)
        deny "BLOCKED: the capped-breadth hatch needs a human, and this session cannot show one a prompt.

permission_mode is \"${mode:-<absent>}\". Measured 2026-08-26: under bypassPermissions a hook's \`ask\` does not prompt -- the command simply runs -- so the hatch would be granting itself, which is what it did until today.

Scope it instead:
  bun test --parallel --changed=origin/main    # branch's source graph
  bun test path/to/one.test.ts                 # single file (repeat for several)

If breadth is genuinely necessary, say so in the session and let a human run it, or run it outside this session. Remote CI on the PR is the gate." ;;
    esac
  fi

  if printf '%s' "$args" | grep -qE -- '--parallel'; then
    deny "BLOCKED: \`bun test --parallel\` with no --changed is a WHOLE-SUITE run -- one worker per core (nproc=$(nproc) here). It exhausts file descriptors and can hang the machine.

A DIRECTORY is a whole-suite run even when a named .test.ts sits beside it --
one file in the list does not bound the other arguments.

Scope it:
  bun test --parallel --changed=origin/main    # branch's source graph
  bun test path/to/one.test.ts                 # single file (repeat for several)
  bun test --parallel=4 <dir>/                 # explicit small cap, if breadth is genuinely needed

Remote CI on the PR is the gate."
  fi

  deny "BLOCKED: bare \`bun test\` is forbidden (CLAUDE.md > Tests). Without --parallel every file shares ONE global and one module registry, so a suite can pass on state a sibling left behind.

Use:
  bun test --parallel --changed=origin/main    # scoped pre-flight
  bun test path/to/one.test.ts                 # single file (allowed as-is)"
done <<< "$segments"

exit 0
