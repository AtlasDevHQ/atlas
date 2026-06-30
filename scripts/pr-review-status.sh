#!/usr/bin/env bash
# pr-review-status.sh — token-cheap snapshot of a PR's external-review state.
#
# WHY THIS EXISTS
#   /ship-issue Step 5 services every external reviewer to convergence. The
#   mechanical half of that loop swept THREE gh endpoints (formal reviews,
#   issue-comment bot summaries, inline review threads) plus the full PR body,
#   then did SHA / "eyes-up" math by hand — and POLLED on a 30-60s cadence for
#   up to 10 minutes, up to 3 rounds. Every poll iteration re-billed all the
#   prior verbose JSON in the agent loop (the same re-billing multiplier
#   scripts/ci-local.sh kills for /ci). This wrapper does all the collection +
#   SHA math once and prints ONE compact snapshot: reviewers, the commit each
#   reviewed vs head, a required-check rollup, and the inline findings. The raw
#   payloads land in .pr-review/<pr>/ so the model can read ONE reviewer's full
#   prose only when it needs to judge a borderline finding — instead of carrying
#   every reviewer's full prose through every poll.
#
# WHAT IT DOES NOT DO (on purpose)
#   It collects and compacts; it does NOT categorize. Judging "actionable code
#   concern" vs "ambiguous/architectural" vs "ack-only approvability note", and
#   then FIXING the actionable ones, needs the conversation context and stays in
#   the /ship-issue thread. Unlike ci-local.sh (fully mechanical pass/fail), the
#   review loop is only PARTLY mechanical — so this is a partial blackbox, by
#   design, not a shortfall.
#
# REVIEWER-AGNOSTIC
#   It enumerates EVERY reviewer / comment author from the data — it never limits
#   the reviewer set to a known list. It additionally extracts richer "eyes-up"
#   state from bots whose protocol it knows (Macroscope / Greptile body blocks);
#   a brand-new bot is still listed generically, just without that refinement.
#   Extend KNOWN-BOT PROTOCOLS below as new bots appear; never gate the reviewer
#   set on names.
#
# EYES-UP (the poll gate)
#   A bot reviewer is "behind head" when the latest commit it reviewed != the PR
#   head SHA — it may re-review on the new push, so treat it as still having eyes
#   on the PR until it catches up or the caller's 10-min bound elapses (exactly
#   the /ship-issue discipline). Exit code encodes ONLY this poll decision:
#     exit 10  = a bot is still behind head (EYES-UP)  -> keep polling
#     exit 0   = no bot is behind head (SETTLED)        -> hand snapshot to the model
#     exit 1   = error (bad args / gh failure)
#   Required-check state is shown for context but does NOT drive the exit code —
#   CI is serviced by `gh pr checks --watch`, not by this poll.
#
# USAGE
#   bash scripts/pr-review-status.sh <PR> [REPO]      # REPO defaults to AtlasDevHQ/atlas
#   PR_REVIEW_PREVIEW=N   chars of each finding/summary preview (default 140)

set -uo pipefail

PR="${1:-}"
REPO="${2:-AtlasDevHQ/atlas}"
PREVIEW="${PR_REVIEW_PREVIEW:-140}"

if [ -z "$PR" ] || ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "usage: bash scripts/pr-review-status.sh <PR-number> [owner/repo]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.pr-review/$PR"
rm -rf "$DIR"
mkdir -p "$DIR"

fetch() { # fetch <outfile> <gh-args...>
  local out="$1"; shift
  if ! gh "$@" >"$DIR/$out" 2>"$DIR/$out.err"; then
    echo "ERROR: gh $* failed:" >&2
    sed 's/^/  /' "$DIR/$out.err" >&2
    exit 1
  fi
}

# One fetch per source. --paginate so a long review thread isn't truncated.
fetch meta.json   pr view "$PR" -R "$REPO" \
  --json headRefOid,state,mergeable,baseRefName,title,body,statusCheckRollup,isCrossRepository,author
fetch reviews.json     api --paginate "repos/$REPO/pulls/$PR/reviews"
fetch issue.json       api --paginate "repos/$REPO/issues/$PR/comments"
fetch inline.json      api --paginate "repos/$REPO/pulls/$PR/comments"

HEAD="$(jq -r '.headRefOid' "$DIR/meta.json")"
HEAD_SHORT="${HEAD:0:8}"

echo "PR #$PR  $REPO  head=$HEAD_SHORT"
jq -r '"state: \(.state)   mergeable: \(.mergeable // "?")   base: \(.baseRefName)   "
       + (if .isCrossRepository then "⚠ FORK PR (cross-repo) — human sign-off required" else "" end)
       + "\n" + .title' "$DIR/meta.json"
echo ""

# ---- Required-ish checks (informational; does not drive exit code) ----
echo "CHECKS"
jq -r '
  (.statusCheckRollup // []) as $c
  | if ($c|length)==0 then "  (no checks reported yet)"
    else
      ( $c | map({name: (.name // .context // "?"),
                  st: ((.conclusion // .state // .status // "PENDING") | ascii_upcase)}) ) as $rows
      | ( $rows | group_by(.st) | map("\(.[0].st)=\(length)") | join("  ") ) as $roll
      | ( [ $rows[] | select(.st|test("FAIL|ERROR|CANCEL|TIMED")) | "  ✗ \(.name)  \(.st)" ] ) as $bad
      | ( [ $rows[] | select(.st|test("PENDING|PROGRESS|QUEUED|WAITING|EXPECTED")) | "  … \(.name)  \(.st)" ] ) as $pend
      | ( "  rollup: " + $roll )
        + (if ($bad|length)>0  then "\n" + ($bad  | join("\n")) else "" end)
        + (if ($pend|length)>0 then "\n" + ($pend | join("\n")) else "" end)
    end
' "$DIR/meta.json"
echo ""

# ---- Reviewers: latest commit each touched (reviews + inline), vs head ----
# A reviewer/author is a "bot" if the API types it as Bot or the login ends [bot].
# This table is informational — it shows the SHA each reviewer last touched. It
# does NOT drive the poll gate (see BEHIND_LOGINS below and the body-block check).
REVIEWER_JQ='
  ( [ $reviews[0][]? | {login: .user.login, bot: (.user.type=="Bot"), commit: .commit_id, when: .submitted_at} ]
    + [ $inline[0][]?  | {login: .user.login, bot: (.user.type=="Bot"), commit: .commit_id, when: .created_at} ]
  )
  | map(select(.login != null))
  | group_by(.login)
  | map( (max_by(.when)) as $l
         | { login: $l.login,
             bot: ($l.bot or ($l.login|test("\\[bot\\]$"))),
             commit: $l.commit,
             athead: ($l.commit == $head) } )
'
echo "REVIEWERS  (latest activity per author; @head? = reviewed the current head SHA)"
jq -rn --arg head "$HEAD" \
  --slurpfile reviews "$DIR/reviews.json" --slurpfile inline "$DIR/inline.json" \
  "$REVIEWER_JQ"' as $r
   | if ($r|length)==0 then "  (no reviewers yet)"
     else ( $r[] | "  \(if .bot then "🤖" else "👤" end) \(.login)\t"
                   + (if .commit==null then "(no commit)" else .commit[0:8] end)
                   + "\t@head: \(if .athead then "yes" else "NO" end)" )
     end'
# Informational only (NOT the poll gate): which bots last touched a non-head SHA.
# A formal review / inline comment on an older SHA usually just means "reviewed an
# earlier push and is done" — it is NOT a reliable "still reviewing" signal, so it
# must not drive the poll (it false-positives on done-but-old reviews). The poll
# gate is the body-block check below.
BEHIND_LOGINS="$(jq -rn --arg head "$HEAD" \
  --slurpfile reviews "$DIR/reviews.json" --slurpfile inline "$DIR/inline.json" \
  "$REVIEWER_JQ"' | [ .[] | select(.bot and (.athead|not)) | .login ] | join(",")')"
echo ""

# ---- KNOWN-BOT PROTOCOLS: the poll gate (summary SHA in the PR body) --------
# A bot that reports the SHA it last reviewed in the PR body lets us tell
# "still reviewing" (body SHA behind head, right after a push) from "done" (body
# SHA == head). This is the RELIABLE in-progress signal — the original Step 5
# used exactly Greptile's body block for it.
#   Macroscope: "summarized <shortsha>" inside <!-- Macroscope ... --> markers.
#   Greptile:   "Last reviewed commit <sha>" inside <!-- greptile_comment -->.
# Add new body-reporting bots here; do NOT gate the reviewer set on names. A bot
# with no body protocol simply can't be detected as in-progress — the caller's
# bounded poll + advisory fallback covers that (matches the original discipline).
BODY_SUMMARY="$(jq -r '.body // ""' "$DIR/meta.json" \
  | grep -ioE 'summarized [0-9a-f]{7,40}|Last reviewed commit[^0-9a-f]*[0-9a-f]{7,40}' \
  | grep -oiE '[0-9a-f]{7,40}' | tail -1 || true)"
BODY_BEHIND=0
if [ -n "$BODY_SUMMARY" ]; then
  if [ "${HEAD:0:${#BODY_SUMMARY}}" = "$BODY_SUMMARY" ]; then
    echo "BODY SUMMARY (bot)  @ ${BODY_SUMMARY:0:8}  — matches head ✓ (reviewer finished current head)"
  else
    echo "BODY SUMMARY (bot)  @ ${BODY_SUMMARY:0:8}  — behind head $HEAD_SHORT → still reviewing (eyes up)"
    BODY_BEHIND=1
  fi
  echo ""
fi

# ---- Inline findings: the likely-actionable threads ------------------------
INLINE_N="$(jq 'length' "$DIR/inline.json")"
echo "INLINE FINDINGS ($INLINE_N)  — full bodies: .pr-review/$PR/inline.json"
jq -r --argjson n "$PREVIEW" --arg head "$HEAD" '
  .[]
  | (.body // "" | gsub("(?s)<!--.*?-->";"") | gsub("\\s+";" ") | .[0:$n]) as $prev
  | ([ .body // "" | scan("(?i)\\*\\*(Critical|High|Medium|Low)\\*\\*") ] | flatten | .[0] // "") as $sev
  | (.commit_id // "") as $cid
  | "  [\(.user.login)] \(.path):\(.line // "—")"
    + (if $sev!="" then "  «\($sev)»" else "" end)
    + (if $cid==$head or $cid=="" then "" else "  (on \($cid[0:8]), not head)" end)
    + "\n     \($prev)"
' "$DIR/inline.json"
[ "$INLINE_N" = "0" ] && echo "  (none)"
echo ""

# ---- Bot/summary issue-comments (Lighthouse, Macroscope summary, etc.) -----
ISSUE_N="$(jq 'length' "$DIR/issue.json")"
echo "ISSUE-COMMENT SUMMARIES ($ISSUE_N)  — full bodies: .pr-review/$PR/issue.json"
jq -r --argjson n "$PREVIEW" '
  .[]
  | (.body // "" | gsub("(?s)<!--.*?-->";"") | gsub("\\s+";" ") | .[0:$n]) as $prev
  | "  [\(.user.login)]\n     \($prev)"
' "$DIR/issue.json"
[ "$ISSUE_N" = "0" ] && echo "  (none)"
echo ""

# ---- Is any external code-review reviewer actually PRESENT? ----------------
# Present == at least one formal review, OR one inline review-thread, OR a known
# review body-block (Macroscope/Greptile). CI-status issue-comments (e.g. the
# Lighthouse github-actions[bot] summary) do NOT count — they aren't a reviewer.
# This is what makes third-party handling self-disabling: with no review bot on
# the PR, there is nothing to poll, so the loop converges on CI alone.
# (Limitation: a hypothetical reviewer that posts ONLY an issue-comment summary
# with no body-block would be missed — extend the body-block patterns above for it.)
REVIEWS_N="$(jq 'length' "$DIR/reviews.json")"
PRESENT=0
if [ "$REVIEWS_N" -gt 0 ] || [ "$INLINE_N" -gt 0 ] || [ -n "$BODY_SUMMARY" ]; then PRESENT=1; fi

# ---- Verdict + poll-gate exit code ----
# Poll gate (exit 10) is the body-block in-progress signal ONLY. BEHIND_LOGINS is
# surfaced as context but never blocks — a done-but-old review must not stall the loop.
echo "------------------------------------------------------------"
if [ "$PRESENT" -eq 0 ]; then
  echo "EXTERNAL REVIEWERS: none active — no formal reviews, no inline threads, no known review body-block."
  echo "VERDICT: SETTLED — CI-gated only; no third-party reviewer to wait for or poll."
  exit 0
fi
if [ "$BODY_BEHIND" -eq 1 ]; then
  echo "EXTERNAL REVIEWERS: present — a body-reporting bot is mid-review (behind head $HEAD_SHORT)."
  echo "VERDICT: EYES-UP — keep polling until it reaches $HEAD_SHORT or the bound elapses"
  echo "         (a fresh push re-triggers it; the poll is bounded — see /ship-issue Step 5)."
  exit 10
fi
if [ -n "$BEHIND_LOGINS" ] && [ -z "$BODY_SUMMARY" ]; then
  # No body-block signal at all, and a bot's latest formal/inline review is on an
  # older SHA. Genuinely ambiguous (could be re-reviewing, could be done) — but with
  # no in-progress signal we don't poll. A body-block AT head (handled above) would
  # have superseded this.
  echo "EXTERNAL REVIEWERS: present — $BEHIND_LOGINS last reviewed an older SHA (no in-progress signal)."
  echo "VERDICT: SETTLED — not waiting (a lagging review with no in-progress signal won't be polled)."
  echo "         Treat its findings as possibly superseded by later commits; judge them, and re-snapshot after any new push."
  exit 0
fi
echo "EXTERNAL REVIEWERS: present — all caught up to head $HEAD_SHORT."
echo "VERDICT: SETTLED — categorize each finding (actionable / ambiguous / ack-only) and fix actionable ones in-thread."
exit 0
