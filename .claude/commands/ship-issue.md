---
description: "L0 inner loop — take ONE issue from nothing to a merged PR autonomously, halting only at human boundaries. Usage: /ship-issue 1234 [base-branch]."
---

L0 — the inner ship loop. Take ONE issue from nothing to a merged PR, autonomously, halting only at the human boundaries. This is the unit `/ship-milestone` runs per issue.

**Input:** `$ARGUMENTS` — the issue number (e.g. `1234`), optionally followed by a base branch. Required.

**You type:** `/ship-issue 1234` · `/ship-issue 1234 milestone/v0.2.0-brain-m1`

---

**Base branch — `main` by default, a milestone branch when named**

Everything below says "`main`". If a second argument names a `milestone/**` branch, that branch is the base for the whole run: branch off it, PR into it, merge into it. This is **milestone-branch mode** — a whole milestone accumulates on one long-running integration branch and reaches `main` as a single reviewed merge, so `main` stays releasable while a multi-issue arc is half-built.

What changes, and nothing else:

- **Step 0** — `git worktree add -b <branch> ../atlas-wt-<slug> origin/<base>`
- **Step 5** — `/pr` must target the base: `gh pr create --base <base> …`. `Closes #<N>` still works (GitHub closes on merge into the default branch — verify at `/tidy` and close by hand if it didn't fire).
- **Merge discipline** — CLAUDE.md's required checks are enforced by branch protection on **`main` only**. On a milestone branch the same checks *run* (`ci.yml` / `deploy-validation.yml` are filtered to `[main, "milestone/**"]`) but nothing blocks a merge, so the gate is **your** judgment: `gh pr checks <N> --watch` green before merge, exactly as if protection were on. **One check is structurally absent: `Analyze (javascript-typescript)`** — CodeQL default setup is `main`-only and cannot be branch-filtered. Per CLAUDE.md a missing-by-design gate is a stop sign, not an override invitation; here it is *deferred*, not skipped — it runs on the milestone branch's own PR into `main`, which is where it matters. Do not treat its absence as license to skip the checks that *are* present.
- **Drift** — before each new issue, re-merge `main` into the milestone branch (`git merge origin/main`) so the stack never diverges far. Landing last among parallel streams is where migration-number collisions bite.

Everything else — the craft loop, `/review-panel`, `/ci`, the fork-PR halt — is unchanged.

**Step 0 — Worktree isolation (MANDATORY, before anything else)**

This repo is a SHARED working tree. Create your own worktree off latest `main` (or the base branch, above) and install deps before reading/editing/running anything:

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
- Verdict **CHANGES REQUESTED** → **triage the must-fix findings first** (`/review-panel` Step 5: local defect → fix inline; new machinery → follow-up by default, from round one), then **Step 5b before writing each fix** — for a guard/branch/comparison, the BEHAVIOUR DELTA table (input classes × old vs new, in the commit); for everything else, the sibling grep. Then fix, build the falsifier in the same commit, then re-run `/review-panel` on the new diff.

  ⚠️ **Fixing the reported instance and not the class is THE reason rounds multiply, and the class has members in two directions.** The grep finds siblings in space; the delta table finds siblings in the input domain at one site. #5037 swept diligently for the first and lost three rounds to the second — one guard, edited three times, each edit closing the symptom a reviewer named and opening the input class beside it.
- **Re-runs are not fresh rounds.** Pass the previous round's fix commits into the panel and name them the primary audit target (`/review-panel` Step 2). Reviewers keep fresh context; what they must not have is fresh *ignorance of what you just changed*.
- Repeat until **CLEAN**, capped at **3 rounds**. If it can't converge in 3 (usually a spec ambiguity), STOP and ask the human.
- The cap is on ROUNDS, not on scope. A round-2 fix that adds real machinery *should* earn a round 3 — don't skip the re-review to stay under the cap. If the work genuinely needs a fourth round, that is the STOP-and-ask case, not a reason to merge unreviewed.
- ⚠️ **The yield curve is a LIVE stop, not a line in the final report.** After every round, compare its finding count to the previous round's. **If it did not fall, STOP and ask — immediately, that round.** Do not spend the next round to confirm what the rise already told you. A rising count means the fixes are manufacturing the next round's work, so another round buys more findings rather than fewer, and the cap is the wrong instrument for catching it: #5088 ran 30 → 18 → 11 → **21** and the stop-worthy signal was the 21, one full round before the cap conversation happened.
- ⚠️ **SPLIT the count two ways before you read it. A raw total conflates two situations that demand OPPOSITE responses.**
  - **NEW SURFACE** — the round looked somewhere no round had looked. Rising new-surface findings mean the review is getting *deeper*, and another round is earning its keep. #5033 is the precedent: a round-1 fix added a savepoint primitive, round 2 found it could roll back an entire publish, round 3 found round 2's `SAVEPOINT` unguarded. Capping there would have shipped a diagnostic capable of rolling back a customer's publish.
  - **DEFECT-IN-PRIOR-FIX** — the previous round's fix broke it, or failed to close the class it claimed to. Rising here means **the loop is eating itself**: each round manufactures the next one's work, and another round adds more than it removes.

  Report both numbers, always: *"round 2: 22 findings — 6 new surface, 16 defect-in-prior-fix."* **The stop decision keys on the SECOND number.** A total that rose on new surface is a reason to continue; a total that rose on defect-in-prior-fix is a reason to stop and change how the fixes are being written, not to buy another round of the same.

  ⚠️ **THE HARD STOP IS THE RATIO, NOT THE ROUND COUNT: if defect-in-prior-fix EXCEEDS new-surface in any round, stop that round.** The 3-round cap is the wrong instrument and always was — it bounds how long you spend, not whether you are making things better, and a loop can burn all three rounds cleaning up after itself. When the majority of a round's findings are defects the previous round's fixes introduced, more review cannot help: the fixes are the defect source, so another round adds work faster than it removes it.

  Measured on #5037: round 1 returned 21 findings, all new surface; round 2 returned ~26, of which ~20 were defects inside round 1's own fixes. The raw total *and* the ratio both said stop, one round before the cap would have. Under the old rule the cap allowed a third round, which would have been spent on the second round's fixes.

  ⚠️ This split exists because the raw rule shipped without it and gave the wrong reading first time out. #5077 ran 17 → ~22 and the rise looked like a loop failing; decomposed, it was almost entirely defects in round 1's own fixes — three of them reproducing the very defect being fixed, one layer over. Those two diagnoses point at different remedies and the total cannot tell them apart.
- **When you do stop, report the CURVE, not just the count.** A declining count (30 → 18 → 11) is a loop converging and the cap is a formality; a flat or rising one is a loop that is not, and the human needs to know which they are approving another round of.
- ⚠️ **A STOP IS A CLOSING ROUND. Do not stop without paying the closing round's costs.** Whichever way you leave the loop — CLEAN, the yield stop, or the 3-round cap — that round is the last one the diff gets, so it owes everything a final round owes: `comment-analyzer` run on this diff (`/review-panel` Step 2), and every named falsifier BUILT and RUN (Step 6). Stopping early is correct; stopping cheaply is not.

  Measured: #5077 stopped on the yield rule and **merged with no comment sweep at all**, because the sweep is gated on "a round with no must-fix" and that round never arrived. Two rules that did not know about each other, and a comment-heavy diff went out unreviewed on the one axis dedicated to it.

**Step 4 — CI gate**

```
/ci
```
All gates must pass. Fix anything red (these are usually small). Run full `bun run test` once here even if `--affected` was green.

`/ci` uses a **launch-and-watch protocol** (see `ci.md`): the wrapper runs in the background and YOU poll `.ci-local/RESULT` on a loop — never end the turn "waiting for the CI report". A lost subagent hand-off here used to stall the whole ship loop until a human poked it; `.ci-local/RESULT` on disk is the completion signal, not any agent's reply.

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

⚠️ **Record rounds AND minutes per round in the ROADMAP entry.** Round counts have been recorded since #5027; wall clock never has, and without it there is no way to tell whether a change that makes rounds more thorough is buying fewer of them or just costing more. Two numbers per issue — `rounds: 3 (22m / 31m / 14m)` — is the whole ask, and it is what makes the Step 6 split above falsifiable.


PR URL · issue closed · CI/merge status · panel rounds it took · **each external reviewer's verdict** (addressed / acknowledged) · anything you halted on.

---

**Rules:** Always `-R AtlasDevHQ/atlas`. Worktree-isolated commits only. The panel + `/ci` are mandatory gates, not optional. Respect every merge-discipline halt in CLAUDE.md.
