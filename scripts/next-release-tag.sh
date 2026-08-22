#!/usr/bin/env bash
# next-release-tag.sh — resolve the version `/release` is about to tag, from the
# RELEASE tag train only (#5384).
#
# Usage:
#   scripts/next-release-tag.sh              # infer the next patch
#   scripts/next-release-tag.sh v0.2.16      # validate an explicit version
#
# Prints the resolved version on stdout, and only that — `/release` reads it.
# Everything explanatory goes to stderr.
#
# ## Why this is a script and not a line in the runbook
#
# `/release` Step 2 used to infer inline:
#
#     git tag -l 'v*.*.*' --sort=-v:refname | head -1
#
# The glob is matched against the WHOLE tag name, and this repo runs ~20 other
# tag trains — every published `@useatlas/*` package plus the sandbox and
# connector trains. `vercel-sandbox-v0.0.5` matches `v*.*.*`, and version-sorts
# above `v0.2.15`. On 2026-08-22, cutting `v0.2.15`, the runbook's own command
# named `vercel-sandbox-v0.0.5` as the most recent release tag; a bare
# `/release` would have inferred `vercel-sandbox-v0.0.6`.
#
# Nothing downstream would have objected. That string is a plausible version, it
# does not already exist, and the annotated tag, the `prod` fast-forward, the
# GitHub Release and the changelog entry all proceed normally against it — onto
# a train that is not prod's. The runbook's own rule ("tags are immutable; if a
# release goes wrong, ship a forward patch") makes it unrecoverable. An
# unvalidated inference feeding an irreversible action is the wrong shape.
#
# ## What "the release train" means here
#
# ADR-0008's FORMAT rule: `^v[0-9]+\.[0-9]+\.[0-9]+$` — no pre-release, no build
# metadata, no fourth part, no package prefix. The glob is anchored so a
# prefixed train cannot enter, and the regex is applied to the survivors so the
# glob's `*` (which matches dots and letters) cannot smuggle `v0.3.0-rc.1` in
# either. Both are needed; neither alone is the rule.
#
# ⚠️ The FORMAT rule only. ADR-0008 also has a BUMP rule — new feature → minor,
# bug fix → patch — and this script does not implement it and cannot: no tag
# name says what the diff did. Inference always bumps the PATCH, which is the
# safe direction (understating a release is recoverable; the version it would
# otherwise consume is still free). A minor or major is passed explicitly.
#
# THE SAME REGEX GATES BOTH PATHS. An inferred version goes through `emit()`,
# the identical validate-then-print used for an explicit argument, before the
# caller ever sees it — that was the asymmetry #5384 turned on, where only the
# argument was checked and only the inference was wrong.
#
# Exit codes, which a caller has to be able to tell apart:
#   0  resolved — the version is on stdout
#   1  refused  — a version was produced but is not taggable (wrong shape, or
#                 already exists). Nothing on stdout.
#   2  cannot run — no git, the root is not a repository root, or this clone
#                 cannot be trusted to see the tags it would be answering from.
#                 Nothing on stdout.
#   3  no tag on the release train. NOT a silent `v0.0.1`: this repo carries
#                 hundreds of tags, so "none of them are ours" is a fact worth
#                 stating rather than a blank slate to guess from. The genuine
#                 first release passes v0.0.1 explicitly, which is also where
#                 the runbook asks for a human confirmation.
#
# Adversarial fixtures: scripts/__tests__/next-release-tag.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A seam, so the fixture suite can point this at a throwaway repo rather than
# fabricating tags in the tracked tree.
ROOT="${NEXT_RELEASE_TAG_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# The release train, both halves. Keep these two in lockstep — the glob narrows,
# the regex decides.
RELEASE_GLOB='v[0-9]*.[0-9]*.[0-9]*'
RELEASE_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

say()    { echo "[next-release-tag] $1" >&2; }
die()    { echo "::error::[next-release-tag] $1" >&2; exit 2; }
refuse() { echo "::error::[next-release-tag] $1" >&2; exit 1; }

[ $# -le 1 ] || die "usage: next-release-tag.sh [<version>] — got $# arguments."

command -v git >/dev/null 2>&1 || die "git is not on PATH."

ROOT_ABS="$(cd "$ROOT" 2>/dev/null && pwd -P)" || die "$ROOT does not exist."
TOPLEVEL="$(git -C "$ROOT_ABS" rev-parse --show-toplevel 2>/dev/null)" \
  || die "$ROOT_ABS is not a git repository — cannot read the tag train."
TOPLEVEL_ABS="$(cd "$TOPLEVEL" && pwd -P)" || die "cannot resolve $TOPLEVEL."
[ "$TOPLEVEL_ABS" = "$ROOT_ABS" ] \
  || die "$ROOT_ABS is not a repository root (its repository is $TOPLEVEL_ABS) — refusing to read another tree's tags."

# ⚠️ THE LOCAL TAG LIST IS THIS SCRIPT'S ONLY ORACLE, and no local check can
# prove it matches the remote's — which is why `/release` Step 1 fetches tags
# before this runs. What IS checkable is positive evidence that this clone was
# configured never to fetch them: then "no release train" is not a fact about
# the repo, it is this script being blind, and its own remedy ("pass v0.0.1
# explicitly") sails through `tag_exists` — blind for the same reason — to tag
# a version that ALREADY EXISTS on the remote. That is #5384's own class one
# step over, so it is a refusal rather than a guess.
#
# A repo with no remote at all (every fixture, a detached tree) is trusted:
# there is nothing it can be out of date with.
TAGOPT="$(git -C "$ROOT_ABS" config --get remote.origin.tagOpt 2>/dev/null || true)"
[ "$TAGOPT" != "--no-tags" ] \
  || die "$ROOT_ABS was cloned with --no-tags, so it cannot see the release train. Run 'git fetch --tags origin' before releasing."

tag_exists() { [ -n "$(git -C "$ROOT_ABS" tag -l "$1")" ]; }

# The single validation site. Both the explicit argument and the inferred value
# come through here, so neither can ship on weaker checks than the other.
emit() {
  local version="$1" origin="$2"
  [[ "$version" =~ $RELEASE_RE ]] \
    || refuse "$origin '$version' is not a release version — must match ${RELEASE_RE} (no pre-release, no build metadata; ADR-0008). Other tag trains in this repo, e.g. vercel-sandbox-v0.0.5, are not release versions."
  ! tag_exists "$version" \
    || refuse "$origin '$version' already exists. Tags are immutable — don't retag, ship a forward patch."
  printf '%s\n' "$version"
  exit 0
}

if [ $# -eq 1 ]; then
  emit "$1" "explicit version"
fi

# ── inference ───────────────────────────────────────────────────────────────

LATEST=""
while IFS= read -r tag; do
  [[ "$tag" =~ $RELEASE_RE ]] || continue
  LATEST="$tag"
  break
done < <(git -C "$ROOT_ABS" tag -l "$RELEASE_GLOB" --sort=-v:refname)

if [ -z "$LATEST" ]; then
  # ⚠️ An empty train is the ONE place shallowness matters. `--depth` truncates
  # commits, not tags, so a shallow clone that fetched tags sees the whole train
  # and answers correctly — refusing on shallowness alone would block a release
  # from a perfectly-sighted checkout. But an empty train read out of a shallow
  # clone is ambiguous exactly where it is expensive: "there is no release yet"
  # and "this clone was never shown one" produce the same output, and only the
  # first makes the v0.0.1 remedy safe.
  if [ "$(git -C "$ROOT_ABS" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    die "no tag on the release train, but $ROOT_ABS is a shallow clone — that is a blind spot, not a fact. Run 'git fetch --tags origin' (or --unshallow) and try again."
  fi
  TOTAL="$(git -C "$ROOT_ABS" tag -l | grep -c . || true)"
  echo "::error::[next-release-tag] no tag on the release train (${RELEASE_RE}); $TOTAL tag(s) in this repo belong to other trains. If this really is the first release, pass v0.0.1 explicitly — per ADR-0008 that starts the pre-launch v0.0.x train, and the runbook asks you to confirm it with a human first." >&2
  exit 3
fi

IFS='.' read -r MAJOR MINOR PATCH <<<"${LATEST#v}"
# Base 10 explicitly: a zero-padded patch like v0.2.08 is a valid release
# version by the regex above, and `$((08 + 1))` is an arithmetic error.
NEXT="v${MAJOR}.${MINOR}.$((10#$PATCH + 1))"

say "latest release tag $LATEST → next $NEXT (patch bump, release train only; pass a version explicitly for a minor)"
emit "$NEXT" "inferred version"
