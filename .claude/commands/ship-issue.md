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

**Step 5 — Open the PR, then drive it to merge**

```
/pr
```
`/pr` branches/commits/pushes and opens the PR with `Closes #<N>`. Two gates must be green on the head SHA: the **internal `/review-panel`** (already run in Step 3) and **required CI**. Third-party review bots are now the *exception* — the panel is the review — so handle them only when one is actually on the PR. The settling point is the **first full CI completion**, not an open-ended wait for reviewers that may not exist.

1. **Wait for the first full CI run to complete** on the head SHA:
   ```bash
   gh pr checks <N> -R AtlasDevHQ/atlas --watch
   ```
   A required check that goes red is serviced like a panel finding — fix, `git commit -o <files>`, push (which re-runs CI) → back to (1). `--admin` is only for a genuinely *broken* gate, never a slow one.

2. **Once CI is complete, take ONE review snapshot** — reviewer-agnostic, no hardcoded names:
   ```bash
   bash scripts/pr-review-status.sh <N>
   ```
   It sweeps every reviewer in all three places (formal reviews + inline threads + known body-blocks like Macroscope/Greptile), compares each against head, and writes the full payloads to `.pr-review/<N>/` (read a specific `inline.json`/`issue.json` entry only when you need a finding's full prose). Its **VERDICT** drives the next move:
   - **`SETTLED — CI-gated only; no third-party reviewer`** (the common case) → there is nothing to poll. Required CI green + the Step-3 panel clean ⇒ **converged → merge.** Do **not** wait for bots that don't exist. (CI-status issue-comments like the Lighthouse `github-actions[bot]` summary are not a reviewer and don't count.)
   - **`SETTLED — present, all caught up`** → a reviewer is on the PR and has reviewed head → go to (3).
   - **`EYES-UP — behind head`** (exit 10) → a bot is mid-review on an older SHA (a fresh push re-triggered it). Do **not** merge and do **not** `AskUserQuestion` while eyes are up (#3839). **Delegate the wait to a subagent** so the poll iterations never land in this thread:
     > Run `bash scripts/pr-review-status.sh <N>` every ~45s until it no longer exits 10 (EYES-UP clears) or ~10 min elapses; return only the final snapshot — do not paste intermediate runs.

     Then act on the returned verdict. If the bound elapses still eyes-up, proceed advisory and say so in the report — `main` is staging; a late bot review is fixed forward, never a block.

3. **A reviewer is present — categorize its findings** (only when (2) reported one):
   - **Actionable** (code concern, or a summary flagging real behavior/risk) → fix it, `git commit -o <files>`, push. The push re-triggers CI and the bot → **back to (1).** Iterate until no reviewer has an open actionable finding.
   - **Ambiguous / architecturally significant** → `AskUserQuestion`; don't guess.
   - **Approvability / "needs human review" / policy sign-off with no code ask** → **acknowledge only.** Quote it in the report. It does **NOT** block the merge and is **NOT** a halt — `main` deploys to staging, not prod. Never sit waiting on a human-approval verdict.

**Converged** when, on the head SHA: required CI green, the Step-3 panel was clean, and **either** no external reviewer is present **or** every present reviewer is re-reviewed-clean / carries only an acknowledged non-actionable verdict → **merge.** Cap the reviewer back-and-forth at **3 rounds** like the panel; if it won't converge, STOP and ask.

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
