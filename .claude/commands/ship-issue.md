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

**Step 5 — Open the PR and watch it**

```
/pr
```
`/pr` branches/commits/pushes and opens the PR with `Closes #<N>`. Then **subscribe to its activity so this session services CI + review bots**:

```
subscribe_pr_activity for the new PR
```
On each event:
- actionable + unambiguous → push the fix, re-kick CI
- ambiguous / architectural → `AskUserQuestion`
- green on the head SHA AND panel was clean → merge

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

PR URL · issue closed · CI/merge status · panel rounds it took · anything you halted on.

---

**Rules:** Always `-R AtlasDevHQ/atlas`. Worktree-isolated commits only. The panel + `/ci` are mandatory gates, not optional. Respect every merge-discipline halt in CLAUDE.md.
