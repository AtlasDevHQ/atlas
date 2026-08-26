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
# Always allowed: a single named file, and `--changed=<ref>` (the sanctioned
# pre-flight). Remote CI on the PR is the real gate.
set -uo pipefail

cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
[ -n "$cmd" ] || exit 0

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

  args="$(printf '%s' "$seg" | sed -E 's/.*\bbun[[:space:]]+test\b//')"

  # An explicit target file is always fine -- one file, one worker.
  if printf '%s' "$args" | grep -qE '(^|[[:space:]])[^[:space:]-][^[:space:]]*\.test\.(ts|tsx)([[:space:]]|$)'; then
    continue
  fi
  # --changed=<ref> bounds the run to the branch's source graph.
  if printf '%s' "$args" | grep -qE -- '--changed(=|[[:space:]])'; then
    continue
  fi

  if printf '%s' "$args" | grep -qE -- '--parallel'; then
    deny "BLOCKED: \`bun test --parallel\` with no --changed is a WHOLE-SUITE run -- one worker per core (nproc=$(nproc) here). It exhausts file descriptors and can hang the machine.

Scope it:
  bun test --parallel --changed=origin/main    # branch's source graph
  bun test path/to/one.test.ts                 # single file

Remote CI on the PR is the gate."
  fi

  deny "BLOCKED: bare \`bun test\` is forbidden (CLAUDE.md > Tests). Without --parallel every file shares ONE global and one module registry, so a suite can pass on state a sibling left behind.

Use:
  bun test --parallel --changed=origin/main    # scoped pre-flight
  bun test path/to/one.test.ts                 # single file (allowed as-is)"
done <<< "$segments"

exit 0
