L2 — the milestone loop. Grind an entire milestone of `ready-for-agent` issues to merged, over and over until complete, dispatching one `/ship-issue` (L0) per issue in its own worktree. The "wake up to merged PRs" loop.

**Input:** `$ARGUMENTS` — the milestone name or number (e.g. `"0.0.5 — REST Datasources"` or `42`). Required.

**You type:** `/ship-milestone "0.0.5 — REST Datasources"`

**Prereq:** the milestone is already broken into issues (via `/kickoff` or `/to-issues`) and they're labeled `ready-for-agent`. This command does NOT plan — it executes. Run it on YOUR OWN issues only; never on a milestone containing fork contributions.

---

**Step 1 — Build the ready set**

```bash
gh issue list -R AtlasDevHQ/atlas --state open --milestone "<milestone>" \
  --label ready-for-agent --json number,title,body,labels
```
For each issue, parse `Depends on #M` from the body. An issue is **ready** when it's open and all its deps are merged/closed. Build the dependency graph; the ready set is the unblocked frontier.

If the milestone has zero open issues, jump to Step 4 (it's already done).

**Step 2 — Dispatch the frontier (parallel, capped)**

For each ready, not-yet-dispatched issue, spawn an L0 worker — a background sub-agent running the `/ship-issue` flow in its own worktree:

```
Agent(
  subagent_type: "general-purpose",
  isolation: "worktree",
  run_in_background: true,
  description: "ship #<N>",
  prompt: "Run /ship-issue <N>. Follow it exactly — worktree isolation, craft loop,
           /review-panel until clean (max 3 rounds), /ci, /pr, then drive to merge per
           Step 5: wait for the first full CI to complete (gh pr checks --watch), then run
           `bash scripts/pr-review-status.sh <N>` ONCE. If it reports no third-party
           reviewer, converge on CI green + clean panel — do NOT wait for bots that don't
           exist. If a reviewer IS present (reviewer-agnostic, any bot/human), categorize +
           fix actionable findings back-and-forth, acknowledge (never block on) approvability /
           needs-human verdicts, and wait out any EYES-UP review via the bounded subagent poll
           before merging. Merge only when green AND own-branch AND Step-5-converged. Halt and
           report if a review can't converge, a gate is broken, or anything is ambiguous.
           Report the PR + each reviewer's verdict (if any) + outcome."
)
```

**Concurrency cap: 3 in flight.** More than that and the worktrees thrash and reviews queue. Independent issues run in parallel; dependent ones wait in the frontier.

> ⚠️ **Verify isolation — don't trust `isolation: "worktree"` alone for background workers.** On this shared checkout, `isolation: "worktree"` + `run_in_background` has let two agents race in the same tree. Each worker's `/ship-issue` Step 0 creates its own `git worktree`, but confirm `git worktree list` shows a distinct path + HEAD per worker before any of them edit or commit — and prefer issues that touch different directories to cut contention.

**Step 3 — Heartbeat: drive to completion**

Do NOT `sleep` or poll in a busy loop. You're woken by (a) background worker completions and (b) `subscribe_pr_activity` events. On each wake:

1. **Reconcile** — which PRs merged or closed since last wake?
2. `git fetch origin main` — pull the new baseline.
3. **Re-resolve the ready set** — newly-merged deps unblock new issues.
4. **Dispatch** newly-unblocked issues, respecting the cap.
5. **Unblock stuck workers** — if a worker halted (review wouldn't converge, ambiguous finding, broken gate), surface it: unambiguous → re-dispatch with guidance; ambiguous → `AskUserQuestion`.
6. **Loop condition:** repeat until the milestone has **no open `ready-for-agent` issues and no workers in flight.**

If `send_later` (claude-code-remote) is available, schedule a check-in ~1h out as a safety net for transitions the webhooks don't deliver (merge-conflict, CI-success), then re-arm until done. If not, rely on worker-completion + PR events.

**Step 4 — Close out**

When the milestone is empty:
```
/closeout    # docs audit + changelog + close GH milestone — verifies completeness; halts if not truly done
```

**Step 5 — HALT for the human before release**

```
/release   ← do NOT run autonomously
```
Advancing `prod` is a deliberate human act. STOP here and report that the milestone is shipped to `main`/staging and ready for the operator to `/release`.

---

**HARD HALTS (every L0 halt applies, plus):**
- **Fork PR anywhere in the set** → stop the whole loop and ask. Never autonomous.
- **`/closeout` reports incomplete** → don't force it; report what's missing.
- **`/release`** → always human-gated.
- **Repeated worker thrash** (same issue halts ≥2×) → stop re-dispatching it, report the diagnosis.

**Report (each heartbeat, keep a live checklist):**
```
## <milestone> — N issues · M merged · K in flight · J blocked
- [x] #1 title — merged (PR #..)
- [~] #2 title — in review (panel round 2)
- [ ] #3 title — blocked on #2
```
Refresh it every wake so the thread shows live state. Stop the loop only when MERGED/CLOSED everything or the human says stop.

**Rules:** Always `-R AtlasDevHQ/atlas`. Worktree-isolated workers only. Never `sleep`-poll for events. Cap concurrency at 3. The loop is not finished until the milestone is empty and closed out — but it never advances `prod` on its own.
