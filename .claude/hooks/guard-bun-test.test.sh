#!/usr/bin/env bash
# Cases for `guard-bun-test.sh`.
#
# It is a GATE, and a gate nobody can exercise is one edit from silently
# inverting. The mention-vs-invocation cases are not hypothetical: the first
# version denied the commit that introduced it, and then denied the patch that
# fixed that, because the command text merely CONTAINED the string it matches.
#
# Run: bash .claude/hooks/guard-bun-test.test.sh
set -uo pipefail

HOOK="$(dirname "${BASH_SOURCE[0]}")/guard-bun-test.sh"
pass=0
fail=0

# verdict <command> [permission_mode] -> "deny" | "ask" | "allow"
#
# ⚠️ THREE-WAY, and it has to be. This read `deny` vs "anything else" until
# 2026-08-26, when the hook gained an `ask` decision. A two-way reading scores
# every `ask` as `allow`, which makes "the hatch asked" and "the hatch granted
# itself" the SAME observation -- and granting itself is the defect this change
# exists to fix.
#
# Mutation, applied and observed: collapse the case back to
# `deny -> deny; * -> allow` and five cases redden immediately (`wanted ask, got
# allow`), because `ask` becomes a verdict this function can never return. That
# is the intended behaviour -- the collapse cannot pass quietly.
#
# The residual risk it does NOT cover, stated because a check that oversells
# itself is this file's own failure mode: collapsing the verdict AND rewriting
# those cases back to `check allow` would go green again. Nothing here can catch
# a simultaneous edit to both sides. What is pinned is that the verdict alone
# cannot be narrowed silently.
#
# The mode is threaded through because the hook allowlists the modes in which
# `ask` actually reaches a human; the default here is `default`, the ordinary
# interactive one.
verdict() {
  local out
  out="$(jq -nc --arg c "$1" --arg m "${2-default}" \
    '{tool_input:{command:$c}} + (if $m == "" then {} else {permission_mode:$m} end)' \
    | bash "$HOOK")"
  case "$out" in
    *'"permissionDecision":"deny"'*) printf 'deny' ;;
    *'"permissionDecision":"ask"'*)  printf 'ask' ;;
    *) printf 'allow' ;;
  esac
}

check() {
  local want="$1" cmd="$2" label="$3" mode="${4-default}" got
  got="$(verdict "$cmd" "$mode")"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf '  ok   %s\n' "$label"
  else
    fail=$((fail + 1))
    printf '  FAIL %s -- wanted %s, got %s\n' "$label" "$want" "$got"
  fi
}

echo "guard-bun-test.sh"

# --- invocations that must be refused ---------------------------------------
check deny 'bun test' 'bare run shares one global'
check deny 'bun test --parallel' 'whole suite, one worker per core'
check deny 'cd packages/web && bun test' 'hidden behind a &&'
check deny 'bun run test' 'package script expands to the whole suite'
check deny 'bun run test:api' 'so does the api script'
check deny 'bun run --filter @atlas/api test' 'and the filtered form'
check deny 'bun test --no-isolate --changed=origin/main' 'no-isolate is refused even when scoped'

# ⚠️ THE LAUNDERING CASE, 2026-08-26. The allow-list asked "does ANY argument
# look like a test file", not "are they ALL", so one named file waved through
# any number of directory globs beside it. This exact shape ran five times in
# one session at 32 workers a go and took the box down; the guard never fired.
check deny 'bun test --parallel src/app/admin/brain/__tests__/ src/ui/components/admin/__tests__/coverage-statement.test.ts' 'a named file does not launder a directory glob'
check deny 'bun test --parallel src/ui/components/admin/brain-coverage/' 'a bare directory glob is a full-worker run'
check deny 'bun test --parallel packages/api/src/lib/brain/__tests__/' 'the 102-file directory from the last recurrence'
check allow 'bun test src/a.test.ts src/b.test.ts' 'several named files are still one worker each'
check ask 'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'an explicit small worker cap ASKS -- it is not granted outright'

# --- found by an independent spec review, 2026-08-26 -------------------------
# Each of these was ALLOW against the first draft of the quantifier fix.
# ⚠️ REAL paths. The first draft of these used `src/lib/zzz/` and `src/**/`,
# neither of which exists from the repo root -- so the globs stayed literal,
# the case arm caught them, and both passed WITHOUT the glob rule working at
# all. Delete the rule and they still passed. Against a path that matches,
# bash expands before the loop sees it, which is what `set -f` now prevents.
# 108 files as of 2026-08-26.
check deny 'bun test --parallel packages/api/src/lib/brain/__tests__/*.test.ts' 'a glob matching 108 REAL files is not a named file'
check deny 'bun test --parallel packages/api/src/lib/*/__tests__/*.test.ts' 'a two-level real glob, 618 files'
check deny 'bun test --parallel src/f{1..500}.test.ts' 'brace expansion carries no glob metachar and still becomes 500 files'
check deny 'bun test --parallel=8' 'a worker cap with NO target is still the whole suite'
check deny 'bun test --parallel=6' 'even at the sanctioned 6, no target means everything'
check deny 'bun test --parallel=32 packages/api/src/lib/brain/__tests__/' 'a cap that is the default spelled longhand is not a cap'
# The shape a human had to stop by hand: the variable across an UNBOUNDED run.
check deny 'TEST_DATABASE_URL=postgres://x bun test --parallel --changed=origin/main' 'the variable across the changed graph -- 874 files today'
check deny 'TEST_DATABASE_URL=postgres://x bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'a cap does not make a directory of pg suites safe'
check ask 'bun test --parallel=6 packages/api/src/lib/brain/__tests__/' 'the memory own number, with a target -- still asks'

# --- redirections are not arguments (found by USING the guard, 2026-08-26) ---
# The all-positionals-must-be-files rule counted `2>&1` as a non-file argument,
# so the single most common shape in the whole local loop was denied.
check allow 'bun test src/a.test.ts 2>&1' 'stderr redirect'
check allow 'bun test src/a.test.ts > out.log' 'stdout to a file, target skipped'
check allow 'bun test src/a.test.ts 2>/dev/null' 'attached redirect'
check allow 'cd packages/api && bun test src/a.test.ts 2>&1 | tail -8' 'the real everyday shape'
check deny 'bun test --parallel src/lib/ 2>&1' 'a redirect does not launder a directory either'

# --- found by an adversarial review of the fix, 2026-08-26 ------------------
check deny 'export TEST_DATABASE_URL=postgres://x && bun test --parallel=6 packages/api/src/lib/brain/__tests__/' 'an exported env var survives segment splitting'
# ⚠️ ...but a SINGLE named pg suite with the variable set is the sanctioned
# shape, and the hook's own deny text instructs it. An earlier ordering denied
# that instruction verbatim — caught by trying to follow it.
check allow 'TEST_DATABASE_URL=postgres://x bun test packages/api/src/lib/brain/__tests__/condition-2-attribution-pg.test.ts' 'one named pg suite is what the deny text tells you to run'
check allow 'cd packages/api && TEST_DATABASE_URL=postgres://x bun test src/a-pg.test.ts 2>&1' 'the same, as actually typed'
check deny 'bun test --parallel=6 --parallel=64 packages/api/src/lib/brain/__tests__/' 'the MAX cap wins, not the first one grep finds'

# The over-scrub regression: apostrophes in prose on separate lines must not
# pair across the newline and delete the invocation between them.
check deny 'echo "it is fine"
bun test --parallel
echo "that is all"' 'a bare parallel run between two echoes still denies'

# --- invocations that must be allowed ---------------------------------------
check allow 'bun test --parallel --changed=origin/main' 'the sanctioned pre-flight'
check allow 'bun test packages/web/src/a.test.ts' 'a single named file'
check allow 'bun test src/b.test.tsx' 'a single named tsx file'
check allow 'bun run lint' 'an unrelated script'

# --- MENTIONS, which are data and not invocations ---------------------------
# Each of these blocked a real command during development.
check allow "git commit -m 'docs: never use bun test --parallel bare'" 'a commit message naming it'
check allow 'echo "bun test --parallel"' 'an echo naming it'
check allow "grep -rn 'bun test' docs/" 'a grep for it'
# ⚠️ 2026-08-26: the third time this guard blocked its own fix. A -m body that
# spans lines is the everyday shape, and the scrubber was line-oriented.
# ⚠️ A multi-line `-m` body quoting the command is DENIED, and that is the
# decision rather than a defect.
#
# Making it pass needs the scrubber to let a quoted span cross newlines, which
# was tried (\x01 join) and made the guard strictly worse: two apostrophes on
# separate lines then paired across the newline and deleted the invocation
# between them, turning a DENY on main into an ALLOW. Over-scrubbing is a false
# ALLOW; that is the failure that takes the box down. This one is a false DENY,
# which costs a rephrase.
#
# The sanctioned way to write such a message is `git commit -F -` with a
# heredoc, which the heredoc pass handles and the next case pins.
check deny 'git commit -m "fix: a guard

  bun test --parallel packages/api/src/lib/brain/__tests__/

was going straight past it"' 'a multi-line -m body FAILS CLOSED, by choice'
check allow 'cat > /tmp/x.md <<EOF
Run bun test --parallel here.
EOF' 'a heredoc documenting it'
check allow "python3 - <<'PY'
s = 'bun test --parallel'
PY" 'a quoted heredoc containing it'

# --- the escape hatch is TWO conditions, not one (2026-08-26) ---------------
# The memory states it as: "If a full local run is ever genuinely necessary,
# ask first, and cap the workers (`bun test --parallel=6`)." The hook enforced
# only the cap and converted "ask first" into a standing self-grant. These
# cases pin the other half.
#
# Every case in this block was observed FAILING against the pre-change hook
# (`git show main:.claude/hooks/guard-bun-test.sh`), which returned nothing at
# all on these shapes and so scored `allow` against a wanted `ask`/`deny`.

# The shape that motivated the change: inside the memory's letter -- capped at
# 6, with an explicit target -- and it is the ENTIRE MONOREPO. ALLOW yesterday.
check ask   'bun test --parallel=6 packages/' 'the whole monorepo at the sanctioned cap is exactly what should stop to ask'
check deny  'bun test --parallel=6 packages/' 'and under bypass, where ask does not prompt, it denies instead' bypassPermissions

# ⚠️ MEASURED, not assumed. In a live session on 2026-08-26 with
# permission_mode=bypassPermissions, a PreToolUse hook returning `ask` did NOT
# prompt -- the command ran silently. A `deny` control on a sibling sentinel
# blocked in the same session, so the hook was loaded; bypass swallows `ask`
# specifically. Hence: allowlist the modes, deny everything else.
check ask   'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'auto mode: a hook ask forces a prompt the classifier cannot silently approve' auto
check ask   'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'acceptEdits still prompts for Bash' acceptEdits
check deny  'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'bypassPermissions cannot show a prompt, so the hatch stays shut' bypassPermissions
check deny  'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'dontAsk is not on the allowlist -- unlisted means shut' dontAsk
check deny  'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'plan is not on the allowlist either' plan
check deny  'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'an UNKNOWN mode fails closed, not open' some-future-mode
# The field is a common input field, not a guaranteed one. Absent == unknown.
check deny  'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'no permission_mode at all fails closed' ''

# The hatch is a hatch, not a hole: everything that denied before still denies,
# in every mode. A cap with no target is still the whole suite.
check deny  'bun test --parallel=6' 'no target still denies even in a mode that can ask'
check deny  'bun test --parallel' 'and a bare parallel run is never a hatch candidate'
check deny  'TEST_DATABASE_URL=postgres://x bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'the pg variable still wins over the hatch, before the ask'
check allow 'bun test --parallel --changed=origin/main' 'the sanctioned pre-flight is untouched by the hatch change'
check allow 'bun test packages/web/src/a.test.ts' 'and so is a single named file'

# ⚠️ 6 IS THE NUMBER THE RECORD NAMES, and nothing pinned it until now.
# Mutation: change the hook's `[ "$cap" -le 6 ]` to `-le 7` and this case is the
# ONLY one that reddens. Before it existed, that mutation SURVIVED the whole
# suite -- 41 green with the cap silently raised. (`--parallel=32 <dir>` only
# catches a raise past 32; `--parallel=8` denies for having no target, not for
# the cap.) An invented cap of 8 is precisely the mistake this guard's own
# history records, so the boundary is now load-bearing.
check deny  'bun test --parallel=7 packages/api/src/lib/brain/__tests__/' 'one over the record number is not the record number'

# --- THE FLEET CEILING (2026-08-26) -----------------------------------------
# The per-command rules are stateless. Three agents each at a legal
# `--parallel=6` is 18 workers, every command individually allowed -- the shape
# that actually took the box down. These cases drive the REAL counter against
# REAL processes; nothing here is faked with an injected count, because the
# counter's predicate is the part most likely to be wrong.
#
# Budget is driven by ATLAS_GUARD_WORKER_BUDGET so the boundary can be crossed
# with two or three processes instead of twelve. Spawning twelve to test a guard
# that exists to stop the box being overloaded would be its own joke.
#
# Mutations applied to the hook and observed, 2026-08-26:
#   drop `[ "$comm" = "bun" ]`          -> 1 red  (the self-match case)
#   `if false` on the ceiling            -> 4 red
#   charge every run 1, ignore the cap   -> 1 red
#   default budget 12 -> 5               -> 3 red
#   spawner produces no real workers     -> 1 red, LOUD: the suite refuses to run
#                                           the dependent cases rather than pass
#                                           them on an empty box
#
# ⚠️ The first of those SURVIVED on the first attempt, and the case was the
# problem, not the rule -- see the fixture note further down. It is recorded
# here because "the mutation reddened it" is the only evidence any of these
# cases are worth their line, and one of them had none.

SPAWNED=""
cleanup_spawned() {
  # shellcheck disable=SC2086
  [ -n "$SPAWNED" ] && kill $SPAWNED 2>/dev/null
  SPAWNED=""
}
trap cleanup_spawned EXIT

# count as the HOOK counts: comm == bun AND the cmdline carries the worker flag.
countable() {
  local n=0 p comm
  for p in /proc/[0-9]*; do
    [ -r "$p/comm" ] || continue
    read -r comm < "$p/comm" 2>/dev/null || continue
    [ "$comm" = "bun" ] || continue
    tr '\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q -- '--test-worker' && n=$((n + 1))
  done
  printf '%s' "$n"
}

# spawn_bun_workers <n> -- real bun processes carrying the flag, and it BLOCKS
# until the counter can actually see them.
#
# ⚠️ This wait is not politeness, it is the difference between a falsifier and a
# decoration. If a spawn silently failed, the live count would be 0 and the
# ALLOW case below would go green while proving nothing -- the precise shape
# that put two dead-path cases into this file's history. So the count is
# asserted before any case runs, and a shortfall is a FAIL, not a shrug.
spawn_bun_workers() {
  local want="$1" i tries=0
  for i in $(seq 1 "$want"); do
    bun -e 'await Bun.sleep(30000)' '--test-worker' >/dev/null 2>&1 &
    SPAWNED="$SPAWNED $!"
  done
  while [ "$(countable)" -lt "$want" ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 100 ]; then
      printf '  FAIL could not spawn %d countable workers (saw %s) -- fleet cases below would prove nothing\n' \
        "$want" "$(countable)"
      fail=$((fail + 1))
      return 1
    fi
    sleep 0.1
  done
  return 0
}

# check_fleet <want> <budget> <cmd> <label>
check_fleet() {
  local want="$1" bud="$2" cmd="$3" label="$4" out got
  out="$(jq -nc --arg c "$cmd" '{tool_input:{command:$c},permission_mode:"default"}' \
    | ATLAS_GUARD_WORKER_BUDGET="$bud" bash "$HOOK")"
  case "$out" in
    *'"permissionDecision":"deny"'*) got=deny ;;
    *'"permissionDecision":"ask"'*)  got=ask ;;
    *) got=allow ;;
  esac
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$label"
  else
    fail=$((fail + 1)); printf '  FAIL %s -- wanted %s, got %s\n' "$label" "$want" "$got"
  fi
}

if spawn_bun_workers 2; then
  printf '  (%s live bun workers)\n' "$(countable)"

  # The ceiling sits ABOVE every allowance -- that is the whole design. Each of
  # these shapes is unconditionally permitted by the per-command rules.
  check_fleet deny 2 'bun test packages/web/src/a.test.ts' 'a single named file cannot add to an already-full box'
  check_fleet deny 2 'bun test --parallel --changed=origin/main' 'nor can the sanctioned pre-flight -- --changed does not skip the ceiling'
  check_fleet deny 2 'bun test --parallel=6 packages/api/src/lib/brain/__tests__/' 'nor the capped hatch, which never reaches the ask'
  # ...and it must not fire when there is room. 2 live + 1 = 3, budget 3.
  check_fleet allow 3 'bun test packages/web/src/a.test.ts' 'but with room to spare it stays out of the way'
fi
cleanup_spawned

# Predicted cost, with nothing running at all: --parallel=6 is charged 6, not 1.
check_fleet deny 4 'bun test --parallel=6 packages/api/src/lib/brain/__tests__/' 'a capped run is charged its CAP up front, on an idle box'
check_fleet ask  6 'bun test --parallel=6 packages/api/src/lib/brain/__tests__/' 'and exactly fits a budget of 6'

# ⚠️ THE SELF-MATCH CASE. The counter's predicate is `comm == "bun"`, not "the
# command line mentions --test-worker", and this is why: the Bash tool wraps
# every command in `bash -c '<command text>'`, so a cmdline-TEXT scan counts the
# shell running the check. During design, a `pkill -f` on that pattern killed
# this session's own shell (exit 144).
#
# A `bash` process carrying the flag in its argv must count ZERO. With a budget
# of 1, a one-worker run fits only if it counts zero.
#
# Mutation: drop the `[ "$comm" = "bun" ] || continue` line from the hook and
# this case reddens (the shell counts, 1 + 1 > 1, deny).
# ⚠️ `bash -c 'sleep 30' '--test-worker'` DOES NOT WORK as this fixture, and it
# sat here green and inert until a mutation exposed it. bash execs a lone simple
# command in place, so that process becomes comm=`sleep`, cmdline=`[sleep 30]` --
# the flag is GONE and the case passed without the rule under test doing
# anything. Deleting the `comm` predicate left it green. A second command
# defeats the exec optimisation and the argv survives:
#   comm=bash  cmdline=[bash -c sleep 30; : --test-worker]
# Verified by reading /proc/<pid>/comm and /proc/<pid>/cmdline for both forms.
bash -c 'sleep 30; :' '--test-worker' >/dev/null 2>&1 &
SPAWNED="$SPAWNED $!"
# and assert the fixture is what it claims to be, before relying on it.
sleep 0.3
if ! tr '\0' ' ' < "/proc/$!/cmdline" 2>/dev/null | grep -q -- '--test-worker'; then
  printf '  FAIL self-match fixture does not carry the flag -- the case below would prove nothing\n'
  fail=$((fail + 1))
fi
check_fleet allow 1 'bun test packages/web/src/a.test.ts' 'a SHELL that merely mentions the worker flag is not a worker'
cleanup_spawned

# The default budget is Matt's number, not a measurement, and it is 12. Nothing
# can pin a policy number to a fact -- what IS pinned is that it is not tiny:
# with nothing running, the sanctioned cap of 6 must still reach the ask.
# Mutation: default budget 12 -> 5 and this reddens.
check ask 'bun test --parallel=6 packages/api/src/lib/brain/__tests__/' 'the default budget leaves room for one capped run'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
