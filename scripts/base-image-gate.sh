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
#   base-image-gate.sh matrix --mode diff --base-tree <dir>
#
#     Prints a compact JSON matrix — [{ref, label, gated}] — for the workflow's
#     `strategy.matrix`. `label` drops the digest: a digest-pinned ref makes an
#     unreadable check name, and the SARIF category must stay stable across a
#     digest bump or code scanning treats the same image as a brand-new analysis
#     and never closes the old alerts.
#
#     report-only  nothing gates. Every non-pull_request trigger.
#     diff         gate refs absent from <dir>'s runtime-base set.
#
#     ⚠️ THERE IS NO `gate-all` FALL-BACK, and its absence is deliberate. The
#     first cut of this had one: if the merge-base tree could not be read, every
#     ref was gated, on the reasoning that an unknown baseline must read as
#     "everything is new". It is the wrong failure. The bare bases still carry
#     fixable HIGH/CRITICAL findings that no PR introduced — that is the whole
#     premise of this change — so "gate everything" is not a stricter check, it
#     is a GUARANTEED red, and a transient `git worktree` hiccup would have
#     reproduced #5359 exactly: an unrelated PR blocked, with a message telling
#     the author to fix a base reference they never touched.
#
#     An unreadable merge-base tree is an INFRASTRUCTURE failure, so it is
#     reported as one: this command exits non-zero with a message naming the
#     tree, and the job fails on a re-runnable error rather than on a
#     vulnerability verdict it has no basis for.
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
    report-only) ;;
    diff) [ -n "$base_tree" ] || die "--mode diff requires --base-tree" ;;
    *) die "--mode must be one of: report-only, diff (got '${mode:-}')" ;;
  esac

  local head_images
  head_images="$(bash "$SCRIPT_DIR/list-runtime-base-images.sh")"
  [ -n "$head_images" ] || die "discovery returned no runtime base images — nothing would be scanned."

  local base_images=""
  if [ "$mode" = "diff" ]; then
    # ⚠️ stderr goes to the LOG, not into the captured value. `2>&1` here folded
    # `find` warnings and error lines into $base_images on the SUCCESS path too,
    # where nothing discards them — a "find: …: Permission denied" would have
    # become a member of the merge-base ref set and been printed as one.
    local base_err
    base_err="$(mktemp)"
    if ! base_images="$(BASE_IMAGE_ROOT="$base_tree" bash "$SCRIPT_DIR/list-runtime-base-images.sh" 2>"$base_err")"; then
      echo "::error::could not resolve runtime base images at the merge-base tree ($base_tree)" >&2
      sed 's/^/  /' "$base_err" >&2
      rm -f "$base_err"
      # NOT a fall-back to gating everything — see the ⚠️ in this file's header.
      die "the merge-base base-image set is unknown, so no reference can be called new or unchanged. This is an infrastructure failure, not a vulnerability verdict: re-run the job."
    fi
    sed 's/^/  /' "$base_err" >&2 || true
    rm -f "$base_err"
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
            if $mode == "report-only" then false
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

  # TRIVY_ANNOTATE=none: this function owns the verdict annotation, because
  # only it knows whether a finding blocks. scan-image.sh emitting ::error::
  # first would leave a red annotation on a job that then passes — the shape
  # that teaches people to stop reading annotations.
  local rc=0
  TRIVY_ANNOTATE=none bash "$SCRIPT_DIR/scan-image.sh" "$image" "$category" "$out_dir" || rc=$?

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
::notice::Nothing here reaches a shipped artifact: every runtime stage upgrades its OS packages (scripts/check-runtime-stage-upgrades.sh enforces that). The built-image tier is the gate of record — including on the Monday cron, which is what catches a CVE disclosed against an unchanged, digest-pinned base. Note the limit: that tier covers deploy/api, deploy/web and deploy/docs only, so for the other Dockerfiles this base finding has no red surface anywhere. That is deliberate and is recorded in .github/workflows/image-scan.yml.
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
