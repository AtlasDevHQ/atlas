L0 — the inner ship loop. Take ONE issue from nothing to a merged PR, autonomously, halting only at the human boundaries. This is the unit `/ship-milestone` runs per issue.

**Input:** `$ARGUMENTS` — the issue number (e.g. `1234`). Required.

**You type:** `/ship-issue 1234`

---

**Step 0 — Worktree isolation (MANDATORY, before anything else)**

This repo is a SHARED working tree. Create your own worktree off latest `main` and install deps before reading/editing/running anything:

```bash
git fetch origin
git worktree add -b <branch> ../atlas-wt-<slug> origin/main
cd ../atlas-wt-<slug> && bun install --frozen-lockfile
```
`<slug>` is slash-free. Commit only explicit paths (`git commit -o <files>`), never `git add -A` / `commit -a`. Don't `/reset` or `git checkout main` in the shared tree.

**Step 1 — Read the issue**

```bash
gh issue view <N> -R AtlasDevHQ/atlas
```
Note the type label, acceptance criteria, and any `Depends on #M`. If a dependency isn't merged yet, STOP and report — this issue isn't ready.

**Step 2 — Pick the craft loop**

- **bug** → `/diagnose` first (reproduce → isolate → fix), THEN `/tdd` to lock the regression test. Never write the test before isolating the cause.
- **feature, clear shape** → `/tdd` (red-green-refactor, one slice).
- **feature, uncertain design** → `/prototype` first, then `/tdd`.
- **domain-heavy** → `/grill-with-docs` first.
- **docs/chore/trivial** → skip `/tdd`.

Use `cd packages/api && bun run scripts/test-isolated.ts --affected` for the fast red→green loop.

**Step 3 — Internal review BEFORE the PR**

```
/review-panel
```
- Verdict **CHANGES REQUESTED** → address the must-fix findings, then re-run `/review-panel` on the new diff.
- Repeat until **CLEAN**, capped at **3 rounds**. If it can't converge in 3 (usually a spec ambiguity), STOP and ask the human.

**Step 4 — CI gate**

```
/ci
```
All gates must pass. Fix anything red (these are usually small). Run full `bun run test` once here even if `--affected` was green.

**Step 5 — Open the PR, then service it to convergence**

```
/pr
```
`/pr` branches/commits/pushes and opens the PR with `Closes #<N>`. Then **keep this session alive to service CI + every external reviewer**:

```
subscribe_pr_activity for the new PR
```

External reviewers (review bots AND humans) post *after* `/pr` and are **slower than required CI** — so do NOT merge the instant CI greens. Give them a round, then sweep them explicitly before every merge attempt.

**The external-review loop — reviewer-agnostic.** Read whatever reviewers are installed; never hardcode names (today Macroscope + Greptile; tomorrow Codex, Claude, Cline, a human — same handling):

1. **Sweep every reviewer on the current head SHA.** They post in *three different places* — miss one and you miss the review:
   ```bash
   gh pr view <N> -R AtlasDevHQ/atlas --json reviews,latestReviews,headRefOid,body
   gh api repos/AtlasDevHQ/atlas/issues/<N>/comments   # bot summaries (Macroscope, …) post here
   gh api repos/AtlasDevHQ/atlas/pulls/<N>/comments     # inline review threads
   ```
   ⚠️ Some bots edit their summary **into the PR body** between markers (Greptile: `<!-- greptile_comment -->`) — `reviews`/`comments` both miss it; only `--json body` catches it. Ignore your own (author) output and stale verdicts on superseded SHAs — only the latest per reviewer on the head SHA counts; a flag may already be fixed by a later commit, so reconcile against the merged diff, don't assume it's live.
2. **Categorize each reviewer's latest output:**
   - **Actionable finding** (a code concern, or a summary flagging real behavior/risk) → treat like a panel finding: fix it, `git commit -o <files>`, push. The push re-triggers the reviewers on the new SHA → **back to step 1.** This is the back-and-forth — iterate until no reviewer has an open actionable finding.
   - **Ambiguous / architecturally significant fix** → `AskUserQuestion`; don't guess.
   - **Approvability / "needs human review" / policy sign-off with no code ask** → **acknowledge only.** Quote it in the report. It does **NOT** block the merge and is **NOT** a halt — `main` deploys to staging, not prod (`prod` is `/release`-gated behind a human). Never sit waiting on a human-approval verdict.
3. **Converged** when, on the head SHA: required CI green, internal panel was clean, and every external reviewer is either re-reviewed-clean or carries only an acknowledged non-actionable verdict → **merge.**

Cap the back-and-forth at **3 reviewer rounds** like the panel; if it won't converge, STOP and ask.

**HARD HALTS (never autonomous):**
- **Fork PR** (`isCrossRepository: true`) → STOP, surface provenance, get human sign-off. Never `--admin` past `fork-pr-gate`.
- A required check that's **structurally missing** (e.g. CodeQL on a fork) → stop sign, not an override.
- `--admin` is only for a genuinely *broken* gate, not a *slow* one — wait for `gh pr checks --watch`.

**Step 6 — Reconcile and clean up**

After merge:
```
/tidy            # check off ROADMAP, close the issue if Closes didn't, prune
git worktree remove ../atlas-wt-<slug>
```

**Step 7 — Report**

PR URL · issue closed · CI/merge status · panel rounds it took · **each external reviewer's verdict** (addressed / acknowledged) · anything you halted on.

---

**Rules:** Always `-R AtlasDevHQ/atlas`. Worktree-isolated commits only. The panel + `/ci` are mandatory gates, not optional. Respect every merge-discipline halt in CLAUDE.md.
