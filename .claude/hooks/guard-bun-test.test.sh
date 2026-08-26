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

# verdict <command> -> "deny" | "allow"
verdict() {
  local out
  out="$(jq -nc --arg c "$1" '{tool_input:{command:$c}}' | bash "$HOOK")"
  if printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then
    printf 'deny'
  else
    printf 'allow'
  fi
}

check() {
  local want="$1" cmd="$2" label="$3" got
  got="$(verdict "$cmd")"
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
check allow 'bun test --parallel=4 packages/api/src/lib/brain/__tests__/' 'an explicit small worker cap is the sanctioned escape hatch'

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
# The quoted command here is a BARE directory glob, denied by every version of
# this guard. So the case can only pass if the scrubber actually recognised the
# multi-line body as data -- it cannot pass by accident through the quantifier
# hole, which is how an earlier draft of this case passed against the very
# guard it was meant to falsify.
check allow 'git commit -m "fix: a guard

  bun test --parallel packages/api/src/lib/brain/__tests__/

was going straight past it"' 'a MULTI-LINE commit body quoting the command'
check allow 'cat > /tmp/x.md <<EOF
Run bun test --parallel here.
EOF' 'a heredoc documenting it'
check allow "python3 - <<'PY'
s = 'bun test --parallel'
PY" 'a quoted heredoc containing it'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
