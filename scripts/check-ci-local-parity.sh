#!/usr/bin/env bash
# check-ci-local-parity.sh — the `check-*` gates `.github/workflows/ci.yml` runs
# and the ones `scripts/ci-local.sh` launches must be the SAME SET.
#
# ## The class this closes
#
# `ci-local.sh` calls itself a mirror of the required `ci` check, and CLAUDE.md
# sends an operator to it when remote CI is broken. Both files enumerate their
# gates BY HAND, in different syntaxes, and nothing compared the two lists. When
# this gate was written they had already drifted: `check-caddyfile.sh` and
# `check-template-deps.ts` ran in CI and never locally, so a Caddyfile syntax
# error or an undeclared template dependency passed every local gate and was
# found only after the push — the outcome the local run exists to prevent.
#
# `check-gate-fixtures-wired.sh` closes the same class for the FIXTURE SUITES
# (a glob locally versus a hand-kept list remotely). This is its sibling for the
# gates themselves, and the two are deliberately separate scripts: one reads a
# directory listing, this one reads two source files, and each can go red on its
# own evidence.
#
# ## Two directions, one allowlist
#
#   ci.yml   → local   every `scripts/check-*` ci.yml names must be launched by
#                      ci-local.sh. No exemptions: a gate that cannot run
#                      locally should DECLINE (exit 3) from inside ci-local.sh,
#                      where the run's verdict can carry it, not be left off.
#   local    → CI      every `scripts/check-*` ci-local.sh launches must be
#                      named by SOME workflow — not only ci.yml, because
#                      `check-runtime-stage-upgrades.sh` legitimately runs from
#                      image-scan.yml. A gate that is local-only BY DESIGN goes
#                      in `scripts/ci-local-parity-allowlist.txt` with its
#                      reason; an entry whose gate later becomes wired FAILS
#                      this gate as stale, so the allowlist cannot outlive its
#                      reasons.
#
# Comments are stripped before matching in every file read, so prose naming a
# gate never counts as running it — the lesson check-gate-fixtures-wired.sh
# learned from `image-scan.yml:249`.
#
# ## Seams (for the fixture suite)
#
#   CI_LOCAL_PARITY_ROOT   tree to read (default: this repo)
#
# Exit codes: 0 the sets agree · 1 one or more gates are on one side only, or an
# allowlist entry is stale · 2 this gate could not look (a file is missing, or a
# side names no gates at all — a "sets agree" over two empty sets is the vacuity
# this repo's gates refuse).
#
# Adversarial fixtures: scripts/__tests__/check-ci-local-parity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CI_LOCAL_PARITY_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

CI_YML="$ROOT/.github/workflows/ci.yml"
LOCAL_SH="$ROOT/scripts/ci-local.sh"
WORKFLOW_DIR="$ROOT/.github/workflows"
ALLOWLIST="$ROOT/scripts/ci-local-parity-allowlist.txt"

die() { echo "::error::[ci-local-parity] $1" >&2; exit 2; }

[ -f "$CI_YML" ] || die "missing $CI_YML — this gate cannot verify anything."
[ -f "$LOCAL_SH" ] || die "missing $LOCAL_SH — this gate cannot verify anything."

GATE_RE='scripts/check-[A-Za-z0-9_-]+\.(sh|ts)'

# gates_in <file> — the distinct `scripts/check-*` paths a file names outside
# comments. `sed 's/#.*//'` is crude (it also cuts a `#` inside a quoted string)
# but its error direction is LOUD: over-stripping can only hide a real launch,
# which reports a gate as missing and fails the build. It cannot manufacture a
# false pass.
gates_in() { sed 's/#.*//' "$1" | grep -oE "$GATE_RE" | sort -u; }

mapfile -t CI_GATES < <(gates_in "$CI_YML")
mapfile -t LOCAL_GATES < <(gates_in "$LOCAL_SH")

# ⚠️ VACUITY FLOORS, both sides.
[ "${#CI_GATES[@]}" -gt 0 ] || die "ci.yml names no scripts/check-* gate outside comments — this gate verified NOTHING."
[ "${#LOCAL_GATES[@]}" -gt 0 ] || die "ci-local.sh launches no scripts/check-* gate outside comments — this gate verified NOTHING."

shopt -s nullglob
WORKFLOWS=("$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml)
shopt -u nullglob
ALL_WF_GATES="$(for wf in "${WORKFLOWS[@]}"; do gates_in "$wf"; done | sort -u)"

# The allowlist: one `scripts/check-*` path per line, then `#` and the reason.
ALLOWED=()
if [ -f "$ALLOWLIST" ]; then
  while IFS= read -r line; do
    entry="$(printf '%s' "$line" | sed 's/#.*//' | tr -d '[:space:]')"
    [ -n "$entry" ] || continue
    if ! printf '%s' "$entry" | grep -qE "^$GATE_RE\$"; then
      die "$ALLOWLIST: '$entry' is not a scripts/check-*.sh|ts path."
    fi
    ALLOWED+=("$entry")
  done <"$ALLOWLIST"
fi

in_list() { local needle="$1" item; shift; for item in "$@"; do [ "$item" = "$needle" ] && return 0; done; return 1; }

echo "check-ci-local-parity.sh — ${#CI_GATES[@]} gate(s) in ci.yml vs ${#LOCAL_GATES[@]} launched by ci-local.sh (${#ALLOWED[@]} allowlisted local-only)"

PROBLEMS=0

# Direction 1: ci.yml → ci-local.sh. No allowlist.
for g in "${CI_GATES[@]}"; do
  if in_list "$g" "${LOCAL_GATES[@]}"; then
    printf '  ok   %-46s both\n' "$g"
  else
    echo "::error file=scripts/ci-local.sh::ci.yml runs $g but ci-local.sh never launches it — a local /ci passes on a defect remote CI rejects." >&2
    PROBLEMS=$((PROBLEMS + 1))
  fi
done

# Direction 2: ci-local.sh → some workflow, or the allowlist.
for g in "${LOCAL_GATES[@]}"; do
  in_list "$g" "${CI_GATES[@]}" && continue  # already reported above as `both`
  if printf '%s\n' "$ALL_WF_GATES" | grep -qxF -- "$g"; then
    printf '  ok   %-46s another workflow\n' "$g"
  elif in_list "$g" ${ALLOWED[@]+"${ALLOWED[@]}"}; then
    printf '  ok   %-46s local-only (allowlisted)\n' "$g"
  else
    echo "::error file=.github/workflows/ci.yml::ci-local.sh launches $g but no workflow under .github/workflows/ runs it — it verifies nothing on the gate that decides whether code ships. Wire it into ci.yml's drift job, or allowlist it in scripts/ci-local-parity-allowlist.txt with the reason it is local-only." >&2
    PROBLEMS=$((PROBLEMS + 1))
  fi
done

# The allowlist ratchet: an entry that is now wired, or no longer launched
# locally, has outlived its reason.
for g in ${ALLOWED[@]+"${ALLOWED[@]}"}; do
  if printf '%s\n' "$ALL_WF_GATES" | grep -qxF -- "$g"; then
    echo "::error file=scripts/ci-local-parity-allowlist.txt::$g is allowlisted as local-only but a workflow now runs it — delete the entry." >&2
    PROBLEMS=$((PROBLEMS + 1))
  elif ! in_list "$g" "${LOCAL_GATES[@]}"; then
    echo "::error file=scripts/ci-local-parity-allowlist.txt::$g is allowlisted but ci-local.sh no longer launches it — delete the entry." >&2
    PROBLEMS=$((PROBLEMS + 1))
  fi
done

echo ""
if [ "$PROBLEMS" -gt 0 ]; then
  echo "FAIL: $PROBLEMS parity problem(s) between .github/workflows/ci.yml and scripts/ci-local.sh (see ::error lines above)." >&2
  exit 1
fi
echo "check-ci-local-parity.sh: every one of ci.yml's ${#CI_GATES[@]} check-* gate(s) is launched by ci-local.sh, and every one of ci-local.sh's ${#LOCAL_GATES[@]} runs in a workflow or is allowlisted."
