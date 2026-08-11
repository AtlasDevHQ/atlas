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
#     every outcome success           → pass silently (refresh any stale
#                                      failure comment to ✅ so it doesn't
#                                      linger as a false alarm)
#     failure on a pull_request      → upsert a marker comment on the PR +
#                                      ::error annotation, then exit 0 —
#                                      VISIBLE but green and non-blocking
#     failure on any other event     → exit 1 — release-tag pushes stay
#                                      BLOCKING; a canonical regression
#                                      must not ship in a tag
#
# WHY `skipped` IS A FAILURE BY DEFAULT (#5040)
#   A job whose steps never ran has proved nothing, and a gate that reports
#   "pass" for it is worse than no gate: it consumes the belief that the
#   property is covered (ADR-0037 §9).
#
#   That is not hypothetical here. `eval-mcp-llm` — the repo's only
#   real-model job — is gated on AI_GATEWAY_API_KEY, which has never been a
#   repo secret (#5039). No secret → preflight skips → eval skips → this
#   script returned 0. Permanently green, never executed, and its own
#   latency baseline (`eval/canonical-questions/mcp-llm-baseline.json`) is
#   still the 3 bytes it was created with.
#
#   So skip-tolerance is an explicit per-label OPT-IN carrying its reason
#   (SKIP_TOLERANT_LABELS below) and every other label is fail-closed. The
#   difference is structural rather than a habit: a job wired later — the
#   #5041 identity paraphrase eval among them — is skip-fatal from its
#   first run without anyone remembering to ask for it.
#
#   A fatal skip takes the ordinary failure path, so the PR/tag split above
#   is unchanged: visible-but-green on a PR, exit 1 on a tag push.
#
# USAGE
#   eval-informational-gate.sh <job-label> <step-outcome>...
#   Outcomes are the literal `steps.<id>.outcome` values ("success",
#   "failure", "cancelled", "skipped").
#
# ENV (all repo/GitHub-controlled; nothing attacker-controlled is spliced
# into the comment body — see the workflow-injection notes in eval.yml)
#   GH_TOKEN, GITHUB_REPOSITORY, EVENT_NAME, PR_NUMBER, RUN_URL

set -euo pipefail

LABEL="${1:?usage: eval-informational-gate.sh <job-label> <outcome>...}"
shift
# On stdout, not stderr — the Actions runner only parses ::error:: /
# ::warning:: workflow commands from stdout.
[ "$#" -ge 1 ] || { echo "::error::no step outcomes passed for $LABEL"; exit 1; }

# Jobs whose steps may legitimately not run, each with the reason it is
# exempt. Anything not listed here is fail-closed on `skipped` — see the
# header. Keep one label per line so a diff that grants an exemption is
# unmissable in review; scripts/__tests__/eval-informational-gate.test.sh
# asserts the list's exact contents, so widening it is a deliberate edit in
# two files.
#
# The two deterministic jobs are DELIBERATELY not exempt, and this does
# change their semantics: their eval steps carry no `if:`, so they report
# `skipped` only when an earlier infra step already failed the job red. The
# gate used to call that a pass; it now reports it, which on a tag push is
# the correct verdict (nothing was evaluated) and on a PR adds the same
# visible comment any other non-run would get.
SKIP_TOLERANT_LABELS=(
  # Steps skip when AI_GATEWAY_API_KEY is unset. Remove this line when
  # #5039 wires the secret — after that, a skip means the key stopped
  # working, which is exactly what this gate should catch.
  eval-mcp-llm
)

SKIP_IS_PASS=0
# `[@]-` and not `[@]`: emptying this list is the expected end state (#5039),
# and an empty array expanded under `set -u` is an unbound-variable abort on
# bash < 4.4 — a crash in the gate, arriving with the change that hardens it.
for tolerant in "${SKIP_TOLERANT_LABELS[@]-}"; do
  if [ "$tolerant" = "$LABEL" ]; then
    SKIP_IS_PASS=1
    break
  fi
done

FAILED=0
SKIP_WAS_FATAL=0
for outcome in "$@"; do
  case "$outcome" in
    success) ;;
    skipped)
      if [ "$SKIP_IS_PASS" -eq 1 ]; then
        echo "::warning::${LABEL}: a step was SKIPPED and this job is on the skip-tolerant list — it proved nothing on this run."
      else
        FAILED=1
        SKIP_WAS_FATAL=1
      fi
      ;;
    *) FAILED=1 ;;
  esac
done

MARKER="<!-- atlas-canonical-eval ${LABEL} -->"

# Returns the id of the existing marker comment, or "" if none.
existing_comment_id() {
  # A gh/jq failure falls back to "" (upsert then POSTs, possibly
  # duplicating a comment) — but it must be VISIBLE, not silent: the
  # warning goes to stderr because stdout is this function's return value,
  # and gh's own stderr is left attached so the underlying error surfaces
  # in the log. --paginate applies --jq per page, so nulls (pages without
  # a match) must be filtered and only the first real id kept; herestring
  # rather than a pipe from gh so grep's SIGPIPE can't kill the producer.
  local out
  if ! out="$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --paginate \
    --jq "[.[] | select(.body | contains(\"${MARKER}\"))][0].id")"; then
    echo "::warning::listing PR comments failed for ${LABEL} — treating as no existing comment (a duplicate comment may be posted)" >&2
    out=""
  fi
  grep -v '^null$' <<<"$out" | head -1 || true # intentionally ignored: no matching comment is the "" case
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
  echo "${LABEL}: gate passed (outcomes: $*)"
  exit 0
fi

# A regression and a non-run are different diagnoses, and telling them apart
# is the point of #5040: "failed" over outcomes that read `skipped` looks
# like a broken gate, when what happened is that the gate never ran and the
# maintainer's next move is to fix the condition, not the eval.
VERB="failed"
TAG_REASON="A canonical regression must not ship in a tagged release."
SKIP_DETAIL=""
if [ "$SKIP_WAS_FATAL" -eq 1 ]; then
  VERB="did not run"
  TAG_REASON="An eval that did not run proves nothing, and must not stand in for one that passed."
  SKIP_DETAIL="A step was **skipped**. For this job a skipped step counts as a failure — see \`scripts/eval-informational-gate.sh\` (#5040). Fix whatever kept the step from running (a missing secret, a failed earlier step); re-running the job without that changes nothing."
fi

if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  if [ -n "${PR_NUMBER:-}" ]; then
    body=(
      "$MARKER"
      "### ⚠️ \`${LABEL}\` ${VERB} on this PR"
      ""
      "Step outcomes: \`$*\` — details in the [run log](${RUN_URL})."
    )
    if [ -n "$SKIP_DETAIL" ]; then
      body+=("" "$SKIP_DETAIL")
    fi
    body+=(
      ""
      "This eval is **informational on PRs**: the check stays green and does not block the merge (policy in \`.github/workflows/eval.yml\`), and this comment is the visible signal. The same outcome **blocks a release tag** — fix it before \`/release\`."
    )
    upsert_comment "$(printf '%s\n' "${body[@]}")"
  fi
  echo "::error::${LABEL} ${VERB} (outcomes: $*) — informational on PRs (check stays green; see the PR comment), but this WILL block the next release tag."
  exit 0
fi

echo "::error::${LABEL} ${VERB} (outcomes: $*) on ${EVENT_NAME:-unknown} — blocking. ${TAG_REASON}"
exit 1
