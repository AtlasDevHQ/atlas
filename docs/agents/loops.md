# Agent loops: making the workflow drive itself

`docs/agents/workflow.md` describes Atlas's commands as a five-phase state machine
(Notice → Plan → Build → Reconcile → Ship). Today **the human is the runtime** that
executes it: you run `/next`, copy a prompt into a new session, wait for the PR, paste
review comments back, merge, run `/tidy`, run `/next` again. Every arrow between phases
is a manual handoff.

This doc captures how to close those arrows — to let agents prompt agents — without
giving up the safety boundaries Atlas already enforces. It is a **design reference**,
not yet a set of shipped commands. The loops are listed lowest-risk first.

---

## What's already here

Two of the hardest primitives already exist. The loops below are connective tissue, not
new machinery.

- **`/next` already emits launch-ready sub-session prompts.** Each prompt is
  self-contained, opens with the `🚨 STOP` worktree banner, and includes the
  `git worktree add … && cd … && bun install --frozen-lockfile` step. That is a thread
  that can spin up threads — it just *prints* the prompts today instead of *launching*
  them. The `Agent` tool with `isolation: "worktree"` is the launcher.
- **The PR-watch loop is a first-class primitive.** `/pr` creates the PR;
  `subscribe_pr_activity` wakes the session on review comments and CI; the harness drives
  investigate → fix → push → re-kick until the PR is MERGED or CLOSED. No polling, no
  `sleep`.

So the dispatcher and the reviewer-feedback loop are mostly wiring, not invention.

---

## The hard boundary that makes autonomy safe

Atlas's **Merge discipline** (CLAUDE.md) is not a limitation to route around — it is what
makes an overnight loop safe to run:

- **Fork PRs (`isCrossRepository: true`) are never agent-mergeable.** The `fork-pr-gate`
  check stays red by design until a maintainer applies `external-approved` by hand. A loop
  must stop and ask (`AskUserQuestion`) on a fork PR, never `--admin` past it. See #3772.
- **`--admin` is for a *broken* gate, not a *slow* one.** A loop waits for
  `gh pr checks --watch` to go green on the head SHA; it does not force merges because it
  is impatient (#2206).
- **Branch protection on `main` is on.** Required checks (`ci`, `api-tests (1/4)`–`(4/4)`,
  Deploy Validation, CodeQL, Symlink Stub Build, `fork-pr-gate`) gate every merge.

The design rule that falls out: **a loop may run fully autonomous up to the merge gate on
its own-branch PRs, and must halt for a human at every boundary the merge-discipline rules
name.** That boundary is precisely why L2 is safe to run while you sleep — the dangerous
actions are fenced off, so the worst case is wasted tokens, not a bad merge.

---

## L0 — Inner ship loop

> One issue, one PR, autonomous until merge.

```
build → /ci → /pr → subscribe_pr_activity → address reviews/CI → merge
```

The pieces all exist; the only missing wire is having `/pr` end by calling
`subscribe_pr_activity` on the PR it just opened, so the session keeps itself alive to
service review comments and CI failures.

- **Drives:** the build → ship arc for a single tracked issue.
- **Halts for a human:** fork PRs; a genuinely broken required check; any review comment
  whose fix is ambiguous or architecturally significant (per the harness's option-2 rule).
- **Risk:** low. This is the loop from the "watch the PR for 6 hours addressing review
  comments" story, except first-class.
- **Reused by:** L2 (each milestone issue runs an L0 loop).

---

## L1 — The dispatcher

> Turn `/next` from "print 3 prompts" into "spawn 3 worktree agents and report back."

`/next` already produces launch-ready, worktree-isolated prompts. The dispatcher reads
them and fires one `Agent({ isolation: "worktree" })` per prompt, then collects results.

```
/next → for each emitted prompt:
          Agent({ isolation: "worktree", prompt, run_in_background: true })
        → collect summaries → report
```

- **Drives:** the Plan → Build handoff. Deletes the copy-paste-into-a-new-session step.
- **Why worktree isolation:** the repo is a **shared working tree** — sessions share one
  `.git`, HEAD, and index. `isolation: "worktree"` gives each agent its own checkout, which
  is exactly what the `/next` banner demands of human-launched sessions.
- **Halts for a human:** nothing structural — but each spawned agent inherits L0's halts.
- **Risk:** low–medium. Smallest change, largest leverage. Best first build.

---

## L2 — The milestone loop

> The dynamic, multi-PR "wake up to merged PRs" loop. A heartbeat thread drives a whole
> milestone to completion.

The commands line up one-to-one with the loop body:

```
/kickoff  →  for each ready (unblocked) issue:
               Agent(worktree): implement → /ci → /pr
               → subscribe_pr_activity → review loop → merge   (= L0)
               → /tidy   (check off ROADMAP, close issue, prune the worktree)
             repeat until the milestone has no ready issues
/closeout →  docs audit + changelog + close GH milestone
/release  →  tag + push + advance prod
```

A heartbeat (`/loop`, ~5–10 min) drives it: on each wake it checks which PRs merged,
dispatches the next unblocked issue, and pulls the latest `main` before the next worktree.
Dependencies between issues (`Depends on #N` in the Atlas issue body) decide what is
"ready" — stacked work serializes, independent work parallelizes. `/tidy`'s stale-branch
and orphan-worktree cleanup is the teardown step.

- **Drives:** an entire milestone, Plan → Ship → Release, mostly unattended.
- **Halts for a human:** every L0 halt, plus `/closeout` (verifies the milestone is truly
  complete before closing) and `/release` (advancing `prod` is a deliberate, human-gated
  act — keep it that way).
- **Risk:** medium–high. Highest token burn; a wrong path burns longer. Run it on your own
  branches, never on a milestone full of fork contributions.

---

## L3 — Always-on heartbeat

> The morning-standup loop. A thin `/sitrep` on an interval that acts only on deltas.

```
/loop 30m:
  /sitrep (read-only)
  → CI red on main?            spawn a fix-agent (L0)
  → inbox has needs-triage?    run /triage
  → active milestone empty?    notify the human to /kickoff
  → otherwise                  re-arm silently, say nothing
```

- **Drives:** continuous repo hygiene and inbound triage.
- **Halts for a human:** anything that would create or close a milestone; anything `/triage`
  routes to `ready-for-human`.
- **Risk:** low if it stays mostly read-only and only spawns bounded fix-agents. The trap is
  a chatty heartbeat — it must say nothing when nothing changed.

---

## Build order

1. **L0** — wire `/pr` → `subscribe_pr_activity`. Foundational; L2 reuses it.
2. **L1** — dispatcher on top of `/next`'s existing prompt output. Smallest change, kills
   the copy-paste.
3. **L2** — compose L0 inside a `/kickoff … /closeout` heartbeat. The headline loop.
4. **L3** — the standing heartbeat, once L0's fix-agents are trustworthy.

Each is a thin command/skill over primitives that already exist: the `Agent` tool
(`isolation: "worktree"`, `run_in_background`), `subscribe_pr_activity`, `/loop`, and the
phase commands themselves. The work is orchestration and halt-conditions, not new tooling.

---

## See also

- `docs/agents/workflow.md` — the five-phase command × skill map these loops automate.
- `docs/agents/issue-tracker.md` — the issue body format (`Depends on #N`) the L2 readiness
  check depends on.
- CLAUDE.md § **Merge discipline** — the human boundaries every loop must respect.
