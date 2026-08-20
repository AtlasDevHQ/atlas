#!/usr/bin/env bash
# base-image-gate.sh — the base-image tier's policy, in one file (#5361).
#
# ── The policy ────────────────────────────────────────────────────────────────
#
# The base tier does NOT gate on the absolute CVE state of a base image, on any
# trigger. It gates on ONE thing: a runtime base image reference that this PR
# introduced or changed.
#
#   ref present at the merge-base too   report-only. A ref that did not move
#                                       cannot carry a finding this PR
#                                       introduced, and the finding does not
#                                       reach a shipped artifact anyway — every
#                                       runtime stage upgrades its OS packages
#                                       (enforced by
#                                       scripts/check-runtime-stage-upgrades.sh).
#
#   ref new or changed                  GATE, absolutely, with .trivyignore
#                                       applied. A bumped pin and a brand-new
#                                       Dockerfile on a base the tree did not
#                                       carry are the same event seen through
#                                       the ref set, and both are caught on the
#                                       PR that makes them — the cheapest moment
#                                       in the lifecycle to fix either.
#
# ── Why, and what replaces the removed blocking ───────────────────────────────
#
# The tier used to fail on any fixable HIGH/CRITICAL in a base, on every PR,
# while its own comment said it existed to "catch a bad pin on the PR that makes
# it". Those are different checks, and the absolute one blocked a docs-only PR
# (#5359) on util-linux CVEs that no Atlas artifact has ever carried — the
# runner-stage `apt-get upgrade` removes them before anything reaches Railway.
# The same package did it twice in eight days.
#
# The BUILT-image tier is the gate of record, on every trigger. It reads the
# finished artifact, which is the only surface a customer receives, and it runs
# unconditionally on `push: main`, `schedule` and `workflow_dispatch`. World-
# disclosed CVEs are owned there and by the Monday cron, not by blocking
# unrelated PRs.
#
# What the base tier still does that nothing else can: DISCOVERY. It walks every
# Dockerfile in the tree, so a new Dockerfile on a base nobody enumerated enters
# the matrix automatically; the built-images matrix is a hardcoded list of three.
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#
#   base-image-gate.sh matrix --mode report-only
#   base-image-gate.sh matrix --mode gate-all
#   base-image-gate.sh matrix --mode diff --base-tree <dir>
#
#     Prints a compact JSON matrix — [{ref, label, gated}] — for the workflow's
#     `strategy.matrix`. `label` drops the digest: a digest-pinned ref makes an
#     unreadable check name, and the SARIF category must stay stable across a
#     digest bump or code scanning treats the same image as a brand-new analysis
#     and never closes the old alerts.
#
#     report-only  nothing gates. Every non-pull_request trigger.
#     gate-all     everything gates. The FAIL-SAFE for a pull_request whose
#                  merge-base tree could not be read — an unknown baseline must
#                  read as "everything is new", never as "nothing changed".
#     diff         gate refs absent from <dir>'s runtime-base set.
#
#   base-image-gate.sh scan <image-ref> <category> <gated> [out-dir]
#
#     Runs scripts/scan-image.sh and applies the policy above to its verdict.
#     A SCANNER failure (any exit other than 0 or 1) always fails, gated or not:
#     report-only is a statement about vulnerability verdicts, not about the
#     scanner having run.
#
# Env: BASE_IMAGE_ROOT — head tree to discover from (default: repo root).
#      Honoured by list-runtime-base-images.sh; used by the fixtures.
#
# Adversarial fixtures: scripts/__tests__/scan-image.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

die() { echo "::error::[base-image-gate] $1" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || die "jq not found on PATH — the matrix cannot be built without it"

cmd_matrix() {
  local mode="" base_tree=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode)      mode="${2:-}"; shift 2 ;;
      --base-tree) base_tree="${2:-}"; shift 2 ;;
      *)           die "unknown argument to 'matrix': $1" ;;
    esac
  done

  case "$mode" in
    report-only|gate-all) ;;
    diff) [ -n "$base_tree" ] || die "--mode diff requires --base-tree" ;;
    *) die "--mode must be one of: report-only, gate-all, diff (got '${mode:-}')" ;;
  esac

  local head_images
  head_images="$(bash "$SCRIPT_DIR/list-runtime-base-images.sh")"
  [ -n "$head_images" ] || die "discovery returned no runtime base images — nothing would be scanned."

  local base_images=""
  if [ "$mode" = "diff" ]; then
    # ⚠️ FAIL SAFE, and the direction matters. If the merge-base tree cannot be
    # read — a missing checkout, a Dockerfile the current parser rejects — the
    # honest answer is "we do not know what was there before", and the only safe
    # reading of that is that every ref is new. Falling back to report-only
    # would turn an infrastructure failure into a silently ungated PR.
    if ! base_images="$(BASE_IMAGE_ROOT="$base_tree" bash "$SCRIPT_DIR/list-runtime-base-images.sh" 2>&1)"; then
      echo "::warning::could not resolve runtime base images at the merge-base tree ($base_tree) — gating every ref instead of assuming nothing changed" >&2
      printf '%s\n' "$base_images" | sed 's/^/  /' >&2
      mode="gate-all"
      base_images=""
    fi
  fi

  {
    echo "base-image-gate matrix (mode: $mode)"
    echo "  discovered at head:"
    printf '%s\n' "$head_images" | sed 's/^/    /'
    if [ "$mode" = "diff" ]; then
      echo "  present at merge-base:"
      printf '%s\n' "$base_images" | sed 's/^/    /'
    fi
  } >&2

  jq -R -s -c \
    --arg mode "$mode" \
    --arg base "$base_images" \
    '
      ($base | split("\n") | map(select(length > 0))) as $baseset
      | split("\n") | map(select(length > 0)) | map({
          ref: .,
          label: (. | split("@")[0] | gsub("[/:]"; "-")),
          gated: (
            if   $mode == "gate-all"    then true
            elif $mode == "report-only" then false
            else ([.] - $baseset) | length > 0
            end
          )
        })
    ' <<<"$head_images"
}

cmd_scan() {
  local image="${1:-}" category="${2:-}" gated="${3:-}" out_dir="${4:-./trivy-results}"

  [ -n "$image" ] && [ -n "$category" ] && [ -n "$gated" ] \
    || die "usage: base-image-gate.sh scan <image-ref> <category> <gated> [out-dir]"
  case "$gated" in
    true|false) ;;
    *) die "<gated> must be 'true' or 'false' (got '$gated')" ;;
  esac

  local rc=0
  bash "$SCRIPT_DIR/scan-image.sh" "$image" "$category" "$out_dir" || rc=$?

  if [ "$rc" -eq 0 ]; then
    return 0
  fi

  # Not a vulnerability verdict — a DB fetch error, an unreadable image.
  # scan-image.sh has already said so. Never softened by report-only mode.
  if [ "$rc" -ne 1 ]; then
    echo "::error::scanner failure while scanning $image — this is not a report-only outcome" >&2
    return "$rc"
  fi

  if [ "$gated" = "false" ]; then
    cat >&2 <<EOF
::notice::REPORT-ONLY: $image carries fixable HIGH/CRITICAL OS-package findings, but this PR did not introduce or change that reference, so it does not block (#5361).
::notice::Nothing here reaches a shipped artifact: every runtime stage upgrades its OS packages (scripts/check-runtime-stage-upgrades.sh enforces that). The built-image tier is the gate of record, and the Monday cron owns CVEs disclosed against an unchanged, digest-pinned base.
EOF
    return 0
  fi

  cat >&2 <<EOF
::error::BLOCKED: this PR introduces or changes the runtime base image $image, and it carries fixable HIGH/CRITICAL OS-package vulnerabilities.
::error::The tree did not carry this reference before, so every finding above is one this PR adds. Fix it here — this is the cheapest moment in its lifecycle.
::error::Options, in order of preference:
::error::  1. pick a base without them, or a newer tag/digest of the same one;
::error::  2. clear them in the runtime stage (apt-get upgrade / apk upgrade), which is what every other Dockerfile in this tree does;
::error::  3. if (2) already clears them from the BUILT image and they persist only in the bare base, that is the bare-base/built-image gap .trivyignore exists for — add a dated \`exp:\` entry there. Read .trivyignore's "If a NEW entry is ever needed" section first; it says what makes an entry legitimate and how to verify one.
EOF
  return 1
}

SUB="${1:-}"
shift || true
case "$SUB" in
  matrix) cmd_matrix "$@" ;;
  scan)   cmd_scan "$@" ;;
  *)      die "usage: base-image-gate.sh <matrix|scan> ... (got '${SUB:-}')" ;;
esac
