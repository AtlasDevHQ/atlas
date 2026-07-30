#!/usr/bin/env bash
# eval-informational-gate.sh — final gate step for the canonical-eval jobs
# (.github/workflows/eval.yml).
#
# WHY THIS EXISTS
#   The eval jobs used job-level `continue-on-error: true` on pull requests,
#   which makes GitHub render the check run as GREEN even when the eval
#   failed — the "informational" signal only existed inside the run log,
#   which nobody opens on a green check. But simply letting the job go red
#   is wrong too: under the repo's merge discipline (CLAUDE.md — merge only
#   after `gh pr checks --watch` is green) a red non-required check would
#   effectively promote the eval to a blocking gate, which #2025/#2074
#   deliberately declined. This script threads that needle, mirroring the
#   lighthouse.yml pattern (visible PR comment, green check):
#
#     every outcome success/skipped  → pass silently (refresh any stale
#                                      failure comment to ✅ so it doesn't
#                                      linger as a false alarm)
#     failure on a pull_request      → upsert a marker comment on the PR +
#                                      ::error annotation, then exit 0 —
#                                      VISIBLE but green and non-blocking
#     failure on any other event     → exit 1 — release-tag pushes stay
#                                      BLOCKING; a canonical regression
#                                      must not ship in a tag
#
# USAGE
#   eval-informational-gate.sh <job-label> <step-outcome>...
#   Outcomes are the literal `steps.<id>.outcome` values ("success",
#   "failure", "cancelled", "skipped"). "skipped" counts as a pass — the
#   LLM eval legitimately skips when ANTHROPIC_API_KEY is unset.
#
# ENV (all repo/GitHub-controlled; nothing attacker-controlled is spliced
# into the comment body — see the workflow-injection notes in eval.yml)
#   GH_TOKEN, GITHUB_REPOSITORY, EVENT_NAME, PR_NUMBER, RUN_URL

set -euo pipefail

LABEL="${1:?usage: eval-informational-gate.sh <job-label> <outcome>...}"
shift
[ "$#" -ge 1 ] || { echo "::error::no step outcomes passed for $LABEL" >&2; exit 1; }

FAILED=0
for outcome in "$@"; do
  case "$outcome" in
    success | skipped) ;;
    *) FAILED=1 ;;
  esac
done

MARKER="<!-- atlas-canonical-eval ${LABEL} -->"

# Returns the id of the existing marker comment, or "" if none.
existing_comment_id() {
  # --paginate applies --jq per page, so nulls (pages without a match) must
  # be filtered and only the first real id kept.
  gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --paginate \
    --jq "[.[] | select(.body | contains(\"${MARKER}\"))][0].id" 2>/dev/null |
    grep -v '^null$' | head -1 || true
}

# Upsert is best-effort: fork PRs get a read-only GITHUB_TOKEN, so a comment
# write can 403. The ::error annotation (and the tag-push exit 1) carry the
# signal regardless — warn, never swallow silently.
upsert_comment() {
  local body="$1" existing
  existing="$(existing_comment_id)"
  if [ -n "$existing" ]; then
    gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" \
      -f body="$body" > /dev/null ||
      echo "::warning::failed to update the ${LABEL} eval comment (read-only token on fork PRs is expected)"
  else
    gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
      -f body="$body" > /dev/null ||
      echo "::warning::failed to post the ${LABEL} eval comment (read-only token on fork PRs is expected)"
  fi
}

if [ "$FAILED" -eq 0 ]; then
  # Green run. If an earlier push left a failure comment on this PR, flip it
  # to resolved instead of letting a stale ⚠️ outlive the fix.
  if [ "${EVENT_NAME:-}" = "pull_request" ] && [ -n "${PR_NUMBER:-}" ]; then
    if [ -n "$(existing_comment_id)" ]; then
      upsert_comment "$(printf '%s\n' \
        "$MARKER" \
        "### ✅ \`${LABEL}\` is passing again" \
        "" \
        "A later push resolved the earlier regression. ([run log](${RUN_URL}))")"
    fi
  fi
  echo "${LABEL}: all step outcomes passed ($*)"
  exit 0
fi

if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  if [ -n "${PR_NUMBER:-}" ]; then
    upsert_comment "$(printf '%s\n' \
      "$MARKER" \
      "### ⚠️ \`${LABEL}\` failed on this PR" \
      "" \
      "Step outcomes: \`$*\` — details in the [run log](${RUN_URL})." \
      "" \
      "This eval is **informational on PRs**: the check stays green and does not block the merge (policy in \`.github/workflows/eval.yml\`), and this comment is the visible signal. The same regression **blocks a release tag** — fix it before \`/release\`.")"
  fi
  echo "::error::${LABEL} failed (outcomes: $*) — informational on PRs (check stays green; see the PR comment), but this WILL block the next release tag."
  exit 0
fi

echo "::error::${LABEL} failed (outcomes: $*) on ${EVENT_NAME:-unknown} — blocking. A canonical regression must not ship in a tagged release."
exit 1
