Middle ground between `/ship-issue` (one) and `/ship-milestone` (the whole thing on a heartbeat): pick the top N `ready-for-agent` issues from the current milestone — the way `/next` does — and dispatch a `/ship-issue` worker for each. Bounded batch: no heartbeat, no auto-refill, no closeout/release.

**Input:** `$ARGUMENTS` — optional. Forms:
- *(empty)* → pick the top **3** unblocked issues from the active milestone
- a number `5` → pick the top **5**
- explicit issue numbers `1201 1202 1207` → ship exactly those

**You type:** `/ship-batch` · `/ship-batch 5` · `/ship-batch 1201 1202 1207`

This is L1.5 — `/next`'s selection + `/ship-issue`'s dispatch, capped. Use it when you want to knock out a chunk of a milestone and stop, not grind the whole thing.

---

**Step 1 — Select (skip if explicit issue numbers were given)**

Reuse `/next`'s priority order against the **active milestone**:

```bash
gh issue list -R AtlasDevHQ/atlas --state open --label ready-for-agent \
  --json number,title,body,labels,milestone
```
Priority: **bugs & security first** → current-milestone features → unblock-others first. Parse `Depends on #M` per issue; only pick from the **unblocked frontier** (deps merged/closed). Prefer issues that touch **different directories** (less worktree contention). Take the top N (default 3).

Present the picks and **wait for confirmation** before dispatching:
```
## Batch: <milestone> — shipping N
| # | title | type | area | independent? |
|---|-------|------|------|-------------|
Proceed? (y/n)
```
(Skip the confirm prompt only when explicit issue numbers were passed — that's already the user's pick.)

**Step 2 — Dispatch (parallel, one worker per issue)**

For each picked issue, spawn a background L0 worker in its own worktree:

```
Agent(
  subagent_type: "general-purpose",
  isolation: "worktree",
  run_in_background: true,
  description: "ship #<N>",
  prompt: "Run /ship-issue <N>. Follow it exactly — worktree isolation, craft loop,
           /review-panel until clean (max 3 rounds), /ci, /pr, subscribe_pr_activity,
           merge only when green AND own-branch. Halt and report if a review can't
           converge, a gate is broken, or anything is ambiguous. Report PR + outcome."
)
```

Dispatch all N at once (the batch size IS the concurrency cap — keep it ≤ 5; beyond that worktrees thrash and reviews queue). Independent picks in Step 1 means they won't collide.

**Step 3 — Collect (NO refill)**

Wait for the workers to finish (you're woken on completion). Unlike `/ship-milestone`, **do not re-resolve the frontier or dispatch newly-unblocked issues** — this batch is fixed at N. When all N have reached a terminal state (merged, or halted-for-human), report and stop.

If a worker halted: unambiguous → offer to re-dispatch with guidance; ambiguous → `AskUserQuestion`.

**Step 4 — Report**
```
## Batch done — <milestone>
- [x] #1201 title — merged (PR #..)
- [x] #1202 title — merged (PR #..)
- [!] #1207 title — HALTED: review didn't converge (round 3) — needs you
```
Then suggest the obvious next move: another `/ship-batch` for the next 3, or `/ship-milestone` to let the rest run on a heartbeat.

---

**HARD HALTS:** every `/ship-issue` halt applies (fork PR, broken/missing-by-design gate, `--admin` discipline). This command never runs `/closeout` or `/release` — it ships a bounded batch and hands back.

**Rules:** Always `-R AtlasDevHQ/atlas`. Worktree-isolated workers only. Cap at 5. Bounded — no auto-refill (that's `/ship-milestone`'s job). Confirm picks before dispatching unless issue numbers were explicit.
