#!/usr/bin/env bash
# Adversarial fixture suite for the release-version resolver (#5384).
#
# The gate under test is `scripts/next-release-tag.sh`, which answers the one
# question `/release` Step 2 asks before doing something irreversible: *what
# version am I about to tag?*
#
# The defect, why the pattern is anchored, and what each exit code means are
# written once, in the gate's own header — read `scripts/next-release-tag.sh`
# first. What follows is only what this suite adds: which properties are pinned,
# and why each fixture is built the way it is.
#
# ## The fixture that proves the defect is real
#
# `the historical glob really does pick the wrong train` runs the OLD command
# against the same fixture repo and REQUIRES it to return a non-release tag. If
# that ever stops holding, this suite no longer reproduces #5384 and says so
# loudly rather than passing on a fixture that agrees by construction.
#
# Exit codes under test: 0 resolved (version on stdout) · 1 rejected · 2 cannot
# run · 3 no tag on the release train.
#
# Run locally: bash scripts/__tests__/next-release-tag.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/next-release-tag.sh"

[ -f "$GATE" ] || { echo "::error::missing $GATE" >&2; exit 2; }

PASS=0
FAIL=0
SKIP=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }
# A skip still counts as a case that RAN, so the floor below stays a constant
# whether or not this clone can support the real-tree case.
skip() { echo "  skip $1"; SKIP=$((SKIP + 1)); }

TMPROOT="$(mktemp -d)" || exit 2
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

# The tracked tree must be untouched — this suite only writes under mktemp -d.
TREE_SNAPSHOT="$(git -C "$ROOT" status --porcelain)" || exit 2

echo "next-release-tag.test.sh — release-version resolver (#5384)"

# ── fixture repos ───────────────────────────────────────────────────────────
# A throwaway repo with a single commit and whatever tags the case needs. The
# gate reads a repo through NEXT_RELEASE_TAG_ROOT precisely so fixtures never
# have to fabricate tags in the tracked tree.
make_repo() {
  local name="$1"
  shift
  local dir="$TMPROOT/$name"
  mkdir -p "$dir" || return 2
  git -C "$dir" init -q -b main >/dev/null 2>&1 || return 2
  git -C "$dir" -c user.email=fixture@atlas.test -c user.name=fixture \
    commit -q --allow-empty -m "fixture" >/dev/null 2>&1 || return 2
  local t
  for t in "$@"; do
    git -C "$dir" tag "$t" >/dev/null 2>&1 || return 2
  done
  printf '%s\n' "$dir"
}

# The tag set this repo actually had on 2026-08-22, trimmed to the trains that
# matter: the release train, plus two of the ~20 package trains that the old
# glob swallowed.
REAL_SHAPE=(v0.2.13 v0.2.14 v0.2.15 vercel-sandbox-v0.0.4 vercel-sandbox-v0.0.5 yaml-context-v0.0.5)

ERRFILE="$TMPROOT/stderr"
run_gate() { # run_gate <repo> [args…] → sets OUT, ERR, STATUS
  local repo="$1"
  shift
  STATUS=0
  OUT="$(NEXT_RELEASE_TAG_ROOT="$repo" bash "$GATE" "$@" 2>"$ERRFILE")" || STATUS=$?
  ERR="$(cat "$ERRFILE")"
}

expect_version() { # expect_version <name> <repo> <want> [args…]
  local name="$1" repo="$2" want="$3"
  shift 3
  run_gate "$repo" "$@"
  if [ "$STATUS" -eq 0 ] && [ "$OUT" = "$want" ]; then
    pass "$name → $want"
  else
    fail "$name — expected exit 0 and '$want', got exit $STATUS and '$OUT'"
    printf '%s\n' "$ERR" | sed 's/^/       | /' >&2
  fi
}

expect_status() { # expect_status <name> <repo> <want-exit> [args…]
  local name="$1" repo="$2" want="$3"
  shift 3
  run_gate "$repo" "$@"
  if [ "$STATUS" -ne "$want" ]; then
    fail "$name — expected exit $want, got $STATUS"
    printf '%s\n' "$OUT$ERR" | sed 's/^/       | /' >&2
    return
  fi
  # A refusal that still prints a version on stdout is the dangerous half of the
  # bug wearing a different hat: /release reads stdout.
  if [ -n "$OUT" ]; then
    fail "$name — exited $want but still printed '$OUT' on stdout"
    return
  fi
  pass "$name (exit $want)"
}

# ── 1. the regression itself ────────────────────────────────────────────────

REPO_REAL="$(make_repo real "${REAL_SHAPE[@]}")" || { echo "::error::fixture setup failed" >&2; exit 2; }

expect_version "inference reads the release train, not vercel-sandbox (#5384)" "$REPO_REAL" v0.2.16

# The falsifier. If this stops failing the old way, the fixture above has
# stopped reproducing #5384 and its green means nothing.
HISTORICAL="$(git -C "$REPO_REAL" tag -l 'v*.*.*' --sort=-v:refname | head -1)"
if [ "$HISTORICAL" = "vercel-sandbox-v0.0.5" ]; then
  pass "the historical glob really does pick the wrong train (got '$HISTORICAL')"
else
  fail "fixture no longer reproduces #5384 — the old glob returned '$HISTORICAL', expected vercel-sandbox-v0.0.5"
fi

# ── 2. inference picks the highest RELEASE version, by version order ────────

REPO_TEENS="$(make_repo teens v0.2.9 v0.2.10)" || exit 2
expect_version "version order, not lexical order" "$REPO_TEENS" v0.2.11

REPO_MINOR="$(make_repo minor v0.9.1 v0.10.0)" || exit 2
expect_version "a higher minor wins over a longer-lived one" "$REPO_MINOR" v0.10.1

# Not a blessing of `v0.2.08` as a tag anyone should cut — it is on-train only
# because the regex #5384 names (`[0-9]+`) admits it, and deviating from that
# regex is exactly what the issue forbids. What this pins is the arithmetic:
# `$((08 + 1))` is a base-8 error that would abort the resolver mid-inference.
REPO_ZEROPAD="$(make_repo zeropad v0.2.08)" || exit 2
expect_version "a zero-padded patch bumps in base 10, not octal" "$REPO_ZEROPAD" v0.2.9

# ── 3. near-misses that clear the glob but not the version rule ─────────────
# These sort ABOVE the real latest, so an unfiltered glob would hand each one to
# an irreversible tag. ADR-0008 admits no pre-release tags and no metadata.

REPO_NEAR="$(make_repo near v0.2.15 v0.3.0-rc.1 v0.3.0.1 v1.2.3+build)" || exit 2
expect_version "pre-release / four-part / metadata tags are not the release train" "$REPO_NEAR" v0.2.16

# ── 4. an empty release train never becomes a guess ─────────────────────────
# 218 tags and none of them ours is exactly the disguise the defect wore, so it
# gets its own exit code rather than silently defaulting to the first release.

REPO_OTHER="$(make_repo other vercel-sandbox-v0.0.5 yaml-context-v0.0.5 chat-v1.2.3)" || exit 2
expect_status "tags exist but none on the release train → exit 3, no guess" "$REPO_OTHER" 3

REPO_BARE="$(make_repo bare)" || exit 2
expect_status "no tags at all → exit 3, not v0.0.1 on stdout" "$REPO_BARE" 3

# ── 5. the explicit-argument path ───────────────────────────────────────────

expect_version "an explicit in-train version is echoed" "$REPO_REAL" v0.3.0 v0.3.0

expect_status "an explicit version that already exists is refused" "$REPO_REAL" 1 v0.2.15

for bad in 0.2.16 v0.2 v0.2.16.1 v0.2.16-rc.1 'v0.2.16+build' V0.2.16 vercel-sandbox-v0.0.6 '' 'v0.2.*'; do
  expect_status "malformed explicit version '$bad' is refused" "$REPO_REAL" 1 "$bad"
done

expect_status "two arguments is a usage error, not a release" "$REPO_REAL" 2 v0.3.0 v0.3.1

# ── 6. one validator, both paths ────────────────────────────────────────────
# The acceptance criterion behind #5384: the INFERRED version must clear the
# same bar as an explicitly-passed one, before anything irreversible happens.
# Feeding the inference back in through the argument path is the cheapest way to
# state that as a test rather than as a comment.

run_gate "$REPO_REAL"
INFERRED="$OUT"
if [ "$STATUS" -eq 0 ] && [ -n "$INFERRED" ]; then
  run_gate "$REPO_REAL" "$INFERRED"
  if [ "$STATUS" -eq 0 ] && [ "$OUT" = "$INFERRED" ]; then
    pass "the inferred version passes the explicit path's own validation ($INFERRED)"
  else
    fail "the inferred version '$INFERRED' is rejected by the explicit path (exit $STATUS)"
  fi
else
  fail "inference did not produce a version to re-validate (exit $STATUS)"
fi

# ── 7. cannot-run is distinguishable from rejected ──────────────────────────

mkdir -p "$TMPROOT/not-a-repo"
expect_status "a root that is not a git repository is exit 2, not a version" "$TMPROOT/not-a-repo" 2

# ── 8. the real repository ──────────────────────────────────────────────────
# The acceptance criterion is falsifiable against THIS tree, not only fixtures:
# with vercel-sandbox-v0.0.5 present, inference must land on the release train.
# Skips when the clone has no release tags (a shallow/tagless CI checkout) —
# absence of tags is not evidence of a defect.
if [ "$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ] \
  || [ -z "$(git -C "$ROOT" tag -l 'v[0-9]*.[0-9]*.[0-9]*')" ]; then
  skip "this clone cannot see the release train (shallow or tagless checkout)"
else
  run_gate "$ROOT"
  if [ "$STATUS" -eq 0 ] && [[ "$OUT" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    pass "against the real tree, inference is on the release train ($OUT)"
  else
    fail "against the real tree, inference returned exit $STATUS / '$OUT'"
  fi
fi

# ── 9. a clone that cannot see the tags refuses ─────────────────────────────
# The dangerous half is not exit 3 itself, it is that exit 3's own remedy would
# then be accepted: `tag_exists` is blind in exactly the state that produced the
# empty train, so `v0.0.1` would validate and be tagged over a tag that already
# exists on the remote. Both paths must refuse, and refuse with 2 (cannot see)
# rather than 3 (nothing there).

CLONE_SRC="file://$REPO_REAL"

# (a) Configured never to fetch tags. 6 tags upstream, 0 locally — so BOTH
# paths must refuse, including the explicit one: `tag_exists` is blind here, so
# an existing version would validate clean.
if git clone -q --no-tags "$CLONE_SRC" "$TMPROOT/notags" 2>/dev/null; then
  expect_status "a --no-tags clone refuses on the inference path" "$TMPROOT/notags" 2
  expect_status "a --no-tags clone refuses on the explicit path too" "$TMPROOT/notags" 2 v0.2.15
else
  skip "could not build a --no-tags clone fixture"
  skip "could not build a --no-tags clone fixture (explicit path)"
fi

# (b) Shallow AND showing an empty train — the one state where "no release yet"
# and "never shown one" are the same output. Built by cloning --no-tags --depth
# 1 and then UNSETTING tagOpt, so what is under test is shallowness alone and
# not the config check above; the case would otherwise pass for the wrong
# reason. Asserted by construction below.
if git clone -q --no-tags --depth 1 "$CLONE_SRC" "$TMPROOT/shallow" 2>/dev/null \
  && git -C "$TMPROOT/shallow" config --unset remote.origin.tagOpt \
  && [ "$(git -C "$TMPROOT/shallow" rev-parse --is-shallow-repository)" = "true" ] \
  && [ -z "$(git -C "$TMPROOT/shallow" config --get remote.origin.tagOpt)" ] \
  && [ -z "$(git -C "$TMPROOT/shallow" tag -l)" ]; then
  expect_status "a shallow clone reading an empty train refuses rather than reporting one" "$TMPROOT/shallow" 2
else
  skip "could not build a shallow, tagless, tagOpt-cleared clone fixture"
fi

# (c) The counter-case that keeps (b) from over-refusing: shallow, but the tags
# ARE there. This repo's own CI and this session's checkout are both shallow —
# a resolver that refused on shallowness alone would block every release from
# them. It must answer.
if git clone -q --depth 1 "$CLONE_SRC" "$TMPROOT/shallow-tagged" 2>/dev/null \
  && [ "$(git -C "$TMPROOT/shallow-tagged" rev-parse --is-shallow-repository)" = "true" ] \
  && [ -n "$(git -C "$TMPROOT/shallow-tagged" tag -l 'v[0-9]*.[0-9]*.[0-9]*')" ]; then
  expect_version "a shallow clone that CAN see the train still answers" "$TMPROOT/shallow-tagged" v0.2.16
else
  skip "could not build a shallow clone that carries tags"
fi

# ── 10. the runbook cannot quietly go back to inferring inline ──────────────
# The resolver is only the fix if `/release` actually calls it. Nothing stopped
# a later edit from re-inlining a `git tag -l` — the runbook is prose, and prose
# is what #5384 was. Both docs legitimately QUOTE the old glob while explaining
# the defect, so the discriminator is position: inside a fenced block it is an
# instruction to run, in prose it is a citation.

RUNBOOK="$ROOT/.claude/commands/release.md"
if [ -f "$RUNBOOK" ]; then
  if grep -q 'scripts/next-release-tag\.sh' "$RUNBOOK"; then
    pass "the runbook calls the resolver"
  else
    fail "$RUNBOOK no longer names scripts/next-release-tag.sh — Step 2 is inferring some other way"
  fi

  # Every line inside a ``` fence, i.e. everything the runbook presents as a
  # command rather than as an explanation.
  FENCED="$(awk '/^```/ { inblock = !inblock; next } inblock' "$RUNBOOK")"
  if [ -z "$FENCED" ]; then
    fail "found no fenced blocks in $RUNBOOK — this check would pass vacuously"
  elif printf '%s\n' "$FENCED" | grep -q "git tag -l"; then
    fail "a fenced block in $RUNBOOK runs 'git tag -l' — that is the inline inference #5384 replaced"
    printf '%s\n' "$FENCED" | grep "git tag -l" | sed 's/^/       | /' >&2
  else
    pass "no fenced block in the runbook infers the version with git tag -l"
  fi
else
  fail "missing $RUNBOOK — the resolver has no caller to check"
fi

# ── the case count must match ───────────────────────────────────────────────
#
# Without this, a vanished case is invisible: the summary prints whatever ran,
# and "26 passed, 0 failed" reads exactly like success. `check-caddyfile.test.sh`
# states the rule and names the counter-example — a floor derived from the run
# moves with the deletion it is supposed to catch, so this is an ABSOLUTE
# literal. SKIP is in the total for the same reason: a case that turns itself
# off must not be able to shrink the denominator.
#
# 24 unconditional cases, plus 5 that skip on a clone that cannot host them
# (one real-tree case, four clone-shape cases).
# The tracked-tree check is deliberately NOT in the total — it runs after this
# line so that it observes every case's writes, including this one's.
EXPECTED_CASES=29
if [ "$((PASS + FAIL + SKIP))" -ne "$EXPECTED_CASES" ]; then
  fail "expected $EXPECTED_CASES cases, ran $((PASS + FAIL + SKIP)) — a case VANISHED (a setup fault returning early?), which is not a pass"
fi

# ── the suite must not have touched the tracked tree ────────────────────────

if [ "$(git -C "$ROOT" status --porcelain)" = "$TREE_SNAPSHOT" ]; then
  pass "the tracked tree is unchanged"
else
  fail "the suite modified the tracked tree"
fi

echo
echo "next-release-tag.test.sh: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ] || exit 1
