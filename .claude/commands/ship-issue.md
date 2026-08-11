---
description: "L0 inner loop — take ONE issue from nothing to a merged PR autonomously, halting only at human boundaries. Usage: /ship-issue 1234 [base-branch]."
---

L0 — the inner ship loop. Take ONE issue from nothing to a merged PR, autonomously, halting only at the human boundaries. This is the unit `/ship-milestone` runs per issue.

**Input:** `$ARGUMENTS` — the issue number (e.g. `1234`), optionally followed by a base branch. Required.

**You type:** `/ship-issue 1234` · `/ship-issue 1234 milestone/v0.2.0-brain-m1`

---

**DONE MEANS MERGED.**

Not "PR opened". Not "CI green". Not "green and awaiting review". The run is over
when the PR is **merged** and Step 6 has reconciled — or when you have hit one of
Step 5's named HARD HALTS and said which one. Anything else is an unfinished run,
however good the branch looks.

⚠️ **Measured on #5110, and it is the second time this loop has ended early at a
different boundary.** That run delivered nine commits, 37/37 remote checks green,
labels, and a written PR body — then reported *"PR opened — want me to watch it?"*
and stopped. The human had to say **work it to merge**. Every individual step had
been followed; what was missing was the sentence above.

#5047 is the same failure one step earlier: the Step-3 yield stop read as a halt
and the run parked with no PR at all. Two different steps, one pattern — **any
step that produces a shippable-looking artifact reads as a finish line.** A PR is
the most convincing artifact in the loop, which is exactly why it is the most
dangerous place to stop. If you are about to hand the user a URL and a question,
the question is the bug.

---

**Base branch — `main` by default, a milestone branch when named**

Everything below says "`main`". If a second argument names a `milestone/**` branch, that branch is the base for the whole run: branch off it, PR into it, merge into it. This is **milestone-branch mode** — a whole milestone accumulates on one long-running integration branch and reaches `main` as a single reviewed merge, so `main` stays releasable while a multi-issue arc is half-built.

What changes, and nothing else:

- **Step 0** — `git worktree add -b <branch> ../atlas-wt-<slug> origin/<base>`
- **Step 5** — `/pr` must target the base: `gh pr create --base <base> …`. `Closes #<N>` still works (GitHub closes on merge into the default branch — verify at `/tidy` and close by hand if it didn't fire).
- **Merge discipline** — CLAUDE.md's required checks are enforced by branch protection on **`main` only**. On a milestone branch the same checks *run* (`ci.yml` / `deploy-validation.yml` are filtered to `[main, "milestone/**"]`) but nothing blocks a merge, so the gate is **your** judgment: `gh pr checks <N> --watch` green before merge, exactly as if protection were on. **One check is structurally absent: `Analyze (javascript-typescript)`** — CodeQL default setup is `main`-only and cannot be branch-filtered. Per CLAUDE.md a missing-by-design gate is a stop sign, not an override invitation; here it is *deferred*, not skipped — it runs on the milestone branch's own PR into `main`, which is where it matters. Do not treat its absence as license to skip the checks that *are* present.
- **Drift** — before each new issue, re-merge `main` into the milestone branch (`git merge origin/main`) so the stack never diverges far. Landing last among parallel streams is where migration-number collisions bite.

Everything else — the craft loop, `/review-panel`, `/ci`, the fork-PR halt — is unchanged.

**⚠️ `gh` MAY NOT EXIST. Resolve the GitHub interface ONCE, at Step 0.**

Every command in this file is written in `gh`. On Claude Code for the web — and
any remote/GitHub-Action runner — `gh` is **absent by design** and the GitHub
surface is the MCP tool set (`mcp__github__*`, schemas loaded via `ToolSearch`).

```bash
command -v gh >/dev/null && echo "gh present — commands as written" \
                         || echo "gh ABSENT — use mcp__github__* for every GitHub step"
```

The failure is not subtle, but it arrives **late and in the worst place**:
`scripts/pr-review-status.sh` — the Step 5 snapshot that decides whether you may
merge — dies with `gh: command not found` **and exits 0**. A run that trusts its
exit status reads SETTLED from a script that checked nothing. Resolve this at
Step 0 and the whole drive-to-merge loop stays available; discover it at Step 5
and you are improvising the merge gate.

| Step | `gh` | MCP equivalent |
|---|---|---|
| 1 | `gh issue view <N>` | `issue_read` · `method: "get"` |
| 5 | `gh pr create` | `create_pull_request` |
| 5(1) | `gh pr checks <N> --watch` | `pull_request_read` · `method: "get_check_runs"` — **poll it; there is no `--watch`** |
| 5(2) | `pr-review-status.sh <N>` | three sweeps: `get_reviews`, `get_review_comments`, `get_comments`. **All three empty ⇒ the script's `SETTLED — CI-gated only` verdict** |
| 5(2) | `gh pr view --json isCrossRepository` | `pull_request_read` · `method: "get"` → `head.repo.full_name` ≠ `AtlasDevHQ/atlas` **is** the fork halt; the same call gives `mergeable_state` |
| 5 merge | `gh pr merge` | `merge_pull_request` |
| 5 labels | `gh pr edit --add-label` | `issue_write` · `method: "update"` (a PR is an issue) |
| 6 | `gh issue close` | `issue_write` · `method: "update"`, `state: "closed"` |

⚠️ **`--admin` has no MCP equivalent, and that is correct.** It is for a
genuinely broken gate only; a run that cannot express it cannot reach for it out
of habit. If you believe you need it and cannot express it, that is the halt.

Measured on #5110: the run reached a green PR and then had no way to take the
Step 5 snapshot at all, because the script and every command around it assume a
CLI the environment does not ship.

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

**Step 3 — Push, open a DRAFT PR, then run the panel against it**

Run the cheap pre-flight (Step 4), push, and open the PR **as a draft** — then start
the panel. Remote CI and the panel run **concurrently**, against the same head SHA:

```bash
cd packages/api && bun run scripts/test-isolated.ts --affected   # + bun run lint, bun run type
git push -u origin <branch>
# then /pr, adding --draft to its `gh pr create` invocation
```

⚠️ **The draft is what makes the concurrency safe, and it is not optional.** A draft
PR cannot be merged — GitHub refuses, and `mergeStateStatus` reports `DRAFT` — so
"the panel has not closed yet" becomes a **structural** fact about the PR rather
than a rule someone has to remember. Opening it non-draft and promising to wait is
the exact posture Step 5's evidence below says fails.

CI runs on drafts (no workflow in `.github/workflows/` guards on
`github.event.pull_request.draft`, verified 2026-08-11), so the ~4 minutes of remote
CI overlaps the panel instead of queueing behind it. Panel fixes are `git commit -o
<files>` + push, which updates the PR in place and re-runs CI — so by the time the
panel closes, CI has usually already answered on the final SHA.

```
/review-panel
```

⚠️ **INVOKE THE COMMAND. Hand-picking agents is not a panel, and the ordering you
will invent is the one `/review-panel` explicitly argues against.** Its roster and
sequence are load-bearing: the THREE code reviewers (`silent-failure-hunter`,
`type-design-analyzer`, `pr-test-analyzer`) run **every** round, and
`comment-analyzer` runs **only on the round that turns out to be final** — because
comment findings are mostly consequences of code findings, so a comment sweep in
round 1 describes code that round 1's own fixes are about to change.

Measured on #5110: the run picked `comment-analyzer` and `fix-vs-finding` first —
comment-analyzer in what was effectively round 1, the inversion that file names
outright — and ran the three code reviewers **after the PR had been declared
ready to merge**. `silent-failure-hunter` then returned a CRITICAL finding (a
poisoned pooled client returned via `client.release()` with no argument, under a
500 body asserting *"nothing was written … re-sending is safe"*) on code the PR
had been declared ready to merge with. Nothing was lost because the merge had not
happened — but the gate had been reported as passed, which is the failure.

⚠️ **Read that failure precisely, because the draft-PR flow above deliberately
does one half of it.** #5110's defect was **not** that a PR URL existed while
reviewers were still running — that is now the intended flow, and it is how CI
and the panel overlap. The defect was that the run **reported the gate passed**
and treated the PR as merge-ready with the code reviewers not yet run. Those are
different acts, and only the second one is forbidden.

**The panel closes BEFORE the PR leaves draft.** A PR URL existing means nothing;
a PR marked *ready* is a claim that Step 3 finished. If you are marking a PR ready
— or reading `mergeStateStatus` as anything but `DRAFT` — with panel rounds still
outstanding, you are recovering, not reviewing.
- Verdict **CHANGES REQUESTED** → **triage the must-fix findings first** (`/review-panel` Step 5: local defect → fix inline; new machinery → follow-up by default, from round one), then **Step 5b before writing each fix** — for a guard/branch/comparison, the BEHAVIOUR DELTA table (input classes × old vs new, in the commit); for everything else, the sibling grep. Then fix, build the falsifier in the same commit, then re-run `/review-panel` on the new diff.

  ⚠️ **Fixing the reported instance and not the class is THE reason rounds multiply, and the class has members in two directions.** The grep finds siblings in space; the delta table finds siblings in the input domain at one site. #5037 swept diligently for the first and lost three rounds to the second — one guard, edited three times, each edit closing the symptom a reviewer named and opening the input class beside it.
- **Re-runs are not fresh rounds.** Pass the previous round's fix commits into the panel and name them the primary audit target (`/review-panel` Step 2). Reviewers keep fresh context; what they must not have is fresh *ignorance of what you just changed*.

⚠️ **"STOP" IN THIS STEP ENDS THE ROUNDS, NOT THE RUN. Read this before any stop rule below.**

Every stop in Step 3 means *this diff gets no more review rounds* — fix what is
confirmed, pay the closing round's costs, and **continue to Step 5 — mark the draft PR ready and drive it to merge.**
It does **not** mean park the issue and wait for a human. `/ship-issue` is the
autonomous loop; the human boundaries are Step 5's HARD HALTS (a fork PR, a
structurally missing required check) and a genuine blocker — a spec ambiguity you
cannot resolve, a dependency that is not merged. A yield stop is none of those:
it is a statement about the REVIEW, and the review's verdict travels in the PR
body, where the reviewer reads it.

The tell is one question: **does the stop reason make the work unshippable, or
only unreviewable-further?** Only the first halts. A loop eating its own fixes
still has a correct diff at the head of it — that is precisely why you stopped
rather than churning it more.

Measured on #5047, which is why this block exists: the ratio rule fired at round
2 (~13 defect-in-prior-fix vs ~4 new surface), everything confirmed was fixed and
1052/1052 tests were green — and the run then **parked with no PR at all**,
because "STOP and ask the human" reads as a halt while the closing-round rule
below says *"whichever way you leave the loop"* and #5077's precedent says the
yield stop **merged**. Two readings of one word, with evidence in the file for
both. The human had to ask why it was not done.

So: below, "stop" means **stop the rounds**. Where a halt is meant, it says HALT
and names the boundary.

- Repeat until **CLEAN**, capped at **3 rounds**. If it can't converge in 3, stop the rounds. **HALT only if the reason is a spec ambiguity you cannot resolve** — that is a blocker, and shipping a diff whose requirements are unsettled is the one thing the cap must not do. Any other non-convergence ships with the curve reported.
- The cap is on ROUNDS, not on scope. A round-2 fix that adds real machinery *should* earn a round 3 — don't skip the re-review to stay under the cap. If the work genuinely needs a fourth round, stop the rounds and say so in the PR body; that is not a reason to skip the panel's earlier verdicts, and it is not by itself a halt.
- ⚠️ **The yield curve is a LIVE stop, not a line in the final report.** After every round, compare its finding count to the previous round's. **If it did not fall, stop the rounds — immediately, that round.** Do not spend the next round to confirm what the rise already told you. A rising count means the fixes are manufacturing the next round's work, so another round buys more findings rather than fewer, and the cap is the wrong instrument for catching it: #5088 ran 30 → 18 → 11 → **21** and the stop-worthy signal was the 21, one full round before the cap conversation happened.
- ⚠️ **SPLIT the count two ways before you read it. A raw total conflates two situations that demand OPPOSITE responses.**
  - **NEW SURFACE** — the round looked somewhere no round had looked. Rising new-surface findings mean the review is getting *deeper*, and another round is earning its keep. #5033 is the precedent: a round-1 fix added a savepoint primitive, round 2 found it could roll back an entire publish, round 3 found round 2's `SAVEPOINT` unguarded. Capping there would have shipped a diagnostic capable of rolling back a customer's publish.
  - **DEFECT-IN-PRIOR-FIX** — the previous round's fix broke it, or failed to close the class it claimed to. Rising here means **the loop is eating itself**: each round manufactures the next one's work, and another round adds more than it removes.

  Report both numbers, always: *"round 2: 22 findings — 6 new surface, 16 defect-in-prior-fix."* **The stop decision keys on the SECOND number.** A total that rose on new surface is a reason to continue; a total that rose on defect-in-prior-fix is a reason to stop the rounds and change how the fixes are being written, not to buy another round of the same. Changing how they are written is the NEXT issue's lesson — on this one, the rounds are over and the diff ships.

  ⚠️ **THE HARD STOP IS THE RATIO, NOT THE ROUND COUNT: if defect-in-prior-fix EXCEEDS new-surface in any round, stop that round.** The 3-round cap is the wrong instrument and always was — it bounds how long you spend, not whether you are making things better, and a loop can burn all three rounds cleaning up after itself. When the majority of a round's findings are defects the previous round's fixes introduced, more review cannot help: the fixes are the defect source, so another round adds work faster than it removes it.

  Measured on #5037: round 1 returned 21 findings, all new surface; round 2 returned ~26, of which ~20 were defects inside round 1's own fixes. The raw total *and* the ratio both said stop, one round before the cap would have. Under the old rule the cap allowed a third round, which would have been spent on the second round's fixes.

  ⚠️ This split exists because the raw rule shipped without it and gave the wrong reading first time out. #5077 ran 17 → ~22 and the rise looked like a loop failing; decomposed, it was almost entirely defects in round 1's own fixes — three of them reproducing the very defect being fixed, one layer over. Those two diagnoses point at different remedies and the total cannot tell them apart.
- **When you do stop, report the CURVE, not just the count** — in the PR body, which is where a reviewer meets it, and in the Step 7 report. A declining count (30 → 18 → 11) is a loop converging and the cap is a formality; a flat or rising one is a loop that is not, and the reviewer needs to know which shape produced the diff in front of them. Reporting the curve is the whole obligation the stop creates: it is a disclosure, not a request for permission.
- ⚠️ **A STOP IS A CLOSING ROUND. Do not stop without paying the closing round's costs.** Whichever way you leave the loop — CLEAN, the yield stop, or the 3-round cap — that round is the last one the diff gets, so it owes everything a final round owes: `comment-analyzer` run on this diff (`/review-panel` Step 2), and every named falsifier BUILT and RUN (Step 6). Stopping early is correct; stopping cheaply is not.

  Measured: #5077 stopped on the yield rule and **merged with no comment sweep at all**, because the sweep is gated on "a round with no must-fix" and that round never arrived. Two rules that did not know about each other, and a comment-heavy diff went out unreviewed on the one axis dedicated to it.

**Step 4 — CI gate: PUSH FIRST, and let REMOTE CI be the gate**

This is the pre-flight Step 3 opens with — it is documented here, but it **runs
before the push**, at the top of Step 3:

```bash
cd packages/api && bun run scripts/test-isolated.ts --affected   # + bun run lint, bun run type
```

Then push, open the draft PR, and let remote CI run **while the panel runs**. **Do NOT run `/ci` locally before every PR.**

⚠️ **This is a change, and the arithmetic is the whole argument.** `scripts/ci-local.sh` is ~25 minutes, largely serial, and the mutation gate inside it rewrites source files in place — so nothing else can touch the tree while it runs. Remote CI on the PR covers the same gates in **~4 minutes**, in parallel, on hardware that is not yours, while you do something else. Running both means paying the slow one first for a result the fast one is about to produce anyway. Measured across `/ship-issue` runs, local `/ci` was one of the largest single blocks of wall clock in the loop and caught nothing remote CI did not.

So the local pre-flight is the cheap subset — `--affected`, `lint`, `type` — which is seconds to a couple of minutes and catches the errors that would waste a remote round-trip. A red remote check is then serviced exactly like any other: fix, `git commit -o <files>`, push, which re-runs CI.

**Run the full `/ci` only when:**
- remote CI is itself broken or unavailable, and you need a local answer;
- you renamed or deleted a test, deleted a function, or reshaped a block a mutation anchors on — see the mutation-gate note below. Remote CI DOES run `mutation-tables`, so this is about pre-empting a round-trip rather than about coverage;
- you are about to `/release`, where the mutation gate and the full serial battery are the point.

⚠️ **THE MUTATION-GATE TRIGGER ABOVE IS WRITTEN ON THE WRONG THING, and this is
the one pre-flight gap that actually costs remote round-trips.** `mutation-tables`
does not break when you touch `scripts/mutations/**`. It breaks when you touch
anything a spec **TARGETS** — and the commonest way to do that is to **RENAME OR
REWRITE A TEST**, which goes nowhere near that directory. The generated tables
record *"first test to die"* BY NAME plus a count per suite, so renaming a test
makes them stale, and a refactor that moves the code a mutation anchors on kills
the anchor outright.

So add one cheap command to the pre-flight whenever the branch renamed a test,
deleted a function, or reshaped a block a mutation might anchor on:

```bash
TEST_DATABASE_URL=… bash scripts/check-mutation-tables.sh --affected origin/main
```

It reports which specs the branch touched and exits instantly when the answer is
none, which is the common PR. **It is NOT free when the answer is non-zero** —
it re-runs whole `-pg` suites once per mutation, tens of minutes — so run it in
the BACKGROUND and carry on; do not block the loop on it, and do not put it in
the default pre-flight.

⚠️ **RUN IT AFTER YOUR LAST TEST EDIT, NOT ONCE AT THE START — a clean result is
a statement about the tree you had then.** The generated tables record a per-suite
test COUNT, so every test ADDED to a suite a spec targets makes them stale again,
and Step 3's panel rounds are precisely when new tests get written. Measured on
#5110: the check ran clean early, then the panel's fixes added three tests to
`migrate-roundtrip-pg` and one to `migrate-identity-logging`, and `mutation-tables`
failed as the very last gate — on a table that had already been verified. Re-run
it once more when the diff stops moving.

Measured on #5047: the branch renamed tests across five suites and deleted one
function. `mutation-tables` failed remote CI **twice**, and the second failure
cost a full CI round-trip that a background `--affected` run started at PR time
would have pre-empted. Three anchors were dead, and one of them had been
re-anchored once already by the previous issue for the same reason.

⚠️ **A DEAD ANCHOR IS NOT ALWAYS RE-ANCHORABLE, and reaching for a replacement
mutation is how a tombstone gets into a table.** If the PR deleted the code a
mutation targets, there is nothing to move the anchor to: DELETE the mutation and
say why. Do not invent a successor pointing at whatever replaced it unless that
successor is genuinely killable — a defensive arm for a state your change just
made unreachable measures `0` in every suite, and `mutate.ts`'s header calls a
published `0` a claim. Recording one asserts *"no test covers this"* where the
truth is *"no input reaches this"*, which is precisely the tombstone the
dead-anchor arm refuses to write. Point the replacement at the guard that made
the state unreachable instead — that one has a test and a real number.

⚠️ **NEVER COMMIT WHILE A MUTATION RUN IS LIVE — and that includes obeying a
hook that tells you to.** `ci-local.sh`, `check-mutation-tables.sh` and a bare
`mutate.ts` all rewrite source files in place and revert them at the end, so a
dirty tree during one is EXPECTED and committing it ships sabotaged source that
reads as a legitimate change in review. Check before every commit in this window:

```bash
ps -o pid=,args= -C bun | grep 'mutate\.ts' && echo "MUTATION RUN LIVE — do not commit"
```

(`ps -C` is procps — Linux. On BSD/macOS use `ps -eo comm=,args= | awk '$1=="bun"'`.)

⚠️ **THE SAME HOOK FIRES FOR SUBAGENT SCRATCH FILES, AND COMMITTING THOSE IS THE
SAME MISTAKE IN A DIFFERENT WINDOW.** A reviewer subagent that needs to type-check
a hypothesis writes a probe into the tree — on #5110,
`packages/api/src/lib/__scratch__/probe.ts`, a throwaway testing whether one
`as unknown as` cast was load-bearing. It is untracked, so the stop hook asks for
it, and committing it ships dead code into `src/` that `lint` and `type` then
police forever. DELETE it once the agent finishes. If the hook needs settling
before then, `.git/info/exclude` is local-only and leaves no diff — never
`.gitignore`, which is itself a change someone has to review. The rule
generalises: **when a hook asks you to commit something you did not write, find
out what wrote it before you obey.**

⚠️ **`pgrep -f` is the obvious spelling and it FALSE-POSITIVES, including on the
bracket trick (`[m]utate.ts`).** `-f` matches other processes' full command
lines, and your own shell's command line is one of them — so the moment the
pattern appears anywhere else in the command you are running, the check reports a
live run that does not exist. Measured on #5047 in the most pointed way
available: the check fired while committing, because the COMMIT MESSAGE
documented the check, putting the literal string in the shell's argv. A guard
that cries wolf gets ignored, which is worse than no guard. `-C bun` matches on
the EXECUTABLE, so a shell can never satisfy it.

Measured on #5047: a stop hook asked for a commit four times during a 40-minute
regeneration, while `git status` showed a different mutated file each time
(`extract.ts`, then `alias-proposal.ts`, then `cardinality.ts`) as the runner
worked through its list. The hook is not wrong in general; it is wrong in this
window, and the `pgrep` is how you tell the two apart.

⚠️ **Never kill `ci-local.sh` — or any mutation run — mid-run.** `mutate.ts`
rewrites source files in place and reverts them at the end, so an interrupted run
leaves a MUTATED source file in the tree — silently, and it will be committed by
the next `git commit -o` that names it. **A foreground `Bash` timeout counts as
killing it**: #5047 lost a `--affected` run to the 10-minute cap, which is why
these belong in the background. If you must stop one, `git status` afterwards and
restore anything it left behind.

⚠️ **A `-pg` baseline reported RED may be a DEAD DATABASE, not a real failure.**
The runner aborts when a baseline suite is already failing, because a mutation
count against a broken tree is breakage-plus-mutation and indistinguishable from
a strong result. That guard is right, but it cannot tell a genuine regression
from a Postgres that fell over — and the mutation load is heavy enough to do
that. #5047 saw six specs report *"baseline is RED — 2 failing"*; every one was
`connect ENOENT /tmp/.s.PGSQL.5432`. Before believing a baseline failure, check
the server is up and re-run one suite directly.

⚠️ **A live-but-CONTENDED database produces the subtler version: a STALE table rather
than a red baseline.** The per-suite kill COUNTS shift under load, so the check reports
a table as drifted when nothing drifted. Measured on #5029 — `subject-cmp.md` came back
STALE locally while remote CI's `mutation-tables` passed on the same SHA, after the run
had been sharing the scratch DB with repeated `--affected` sweeps.

The tell is diagnostic and takes ten seconds: **is any suite named in that table actually
in your diff?** If none is, your branch cannot have made it stale. Re-run that one spec
alone on a quiet database (`bun run scripts/mutate.ts scripts/mutations/<spec>.ts --check`)
before regenerating — regenerating on contended numbers commits a measurement CI will
disagree with, which is worse than the stale table you started with.

`/ci` uses a **launch-and-watch protocol** (see `ci.md`): the wrapper runs in the background and YOU poll `.ci-local/RESULT` on a loop — never end the turn "waiting for the CI report". A lost subagent hand-off here used to stall the whole ship loop until a human poked it; `.ci-local/RESULT` on disk is the completion signal, not any agent's reply.

**Step 5 — Mark the PR ready, then drive it to merge**

The PR already exists — Step 3 opened it as a draft and `/pr` gave it its title,
body and `Closes #<N>`. The panel has now closed, so take it out of draft:

```bash
gh pr ready <N> -R AtlasDevHQ/atlas
```

⚠️ **Marking it ready IS the claim that Step 3 finished.** Do not run this with
rounds outstanding — see Step 3's #5110 note. If the panel stopped early, the body
owes the curve *before* this command, not after.

⚠️ **If the Step-3 panel stopped early, the PR body owes the CURVE and the residue** — rounds with both numbers per round (`round 2: 17 — 4 new surface, 13 defect-in-prior-fix`), why the loop closed, and what was consciously left as a follow-up. That disclosure is what makes an early stop legitimate rather than a shortcut: the reviewer opening the PR is the human the stop rule wanted told, and the PR body is where they are standing.

⚠️ **Before you wait on anything, ask GitHub what this PR will CLOSE. Not what you meant it to close.**

```bash
gh pr view <N> -R AtlasDevHQ/atlas --json closingIssuesReferences \
  --jq '.closingIssuesReferences[].number'
```

Every number that comes back must be one you intend. GitHub's keyword parser matches
`fix|fixes|close|closes|resolve|resolves` + `#N` **anywhere in the body or any commit
message, and it does not read negation** — so a sentence written to say the opposite
closes the issue.

Measured on #5029, whose PR body and squash commit both carried *"It does not **fix
#5000** by itself, and that was the finding all along"*. #5000 is a long-lived tracking
bug that closes on **prod verification, not merge**; it closed at the same second the PR
merged and had to be reopened by hand. The prose was not sloppy — the whole finding was
that the change does NOT fix that bug, so the sentence anyone writes to disclose it is
the sentence that trips the parser.

Verified against the offending PR itself — `gh pr view 5116 … --jq '…[].number'` answers
`5000` and `5029`, where only `5029` was intended. The check is not theoretical and it
is one command.

⚠️ **It then caught the PR that ADDED it, twice — once in the body and once in a commit
message — because both quoted the offending sentence in order to explain it.** That is
the quotation trap `/review-panel`'s ratchet section describes, arriving through
GitHub's parser: a parser is a lexical guard, and a lexical guard cannot tell a
quotation from an assertion. The resolution is the same one — **reword, never exempt.**

Two things follow, and both are cheap:

- **Put the keyword AFTER the number.** *"#5000 is not fixed by this"* is safe;
  *"does not fix #5000"* is not, and neither is any tense (`fixed`, `closed`,
  `resolved`) nor a cross-repo form (`owner/repo#N` still closes). Backticks are not a
  reliable escape — do not rely on them.
- **Re-run the query after your LAST push, not just after opening the PR.** Commit
  messages are parsed too, so an amend or a fresh commit can reintroduce it under a
  green earlier check. On this PR the body was fixed first and the query still answered
  `5000`, because the commit still carried it.

Run it at Step 5, not Step 7: here the body is still editable. Safe phrasings keep the
verb away from the number (*"#5000 is not fixed by this"*); a cross-repo reference does
**not** help, since `owner/repo#N` still closes.

Two gates must be green on the head SHA: the **internal `/review-panel`** (already run in Step 3) and **required CI**. Third-party review bots are now the *exception* — the panel is the review — so handle them only when one is actually on the PR. The settling point is the **first full CI completion**, not an open-ended wait for reviewers that may not exist.

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

**Converged** when, on the head SHA: required CI green, **the Step-3 panel CLOSED** — reached CLEAN, *or* stopped on the yield/ratio rule or the 3-round cap with every confirmed must-fix fixed and the curve reported in the PR body — and **either** no external reviewer is present **or** every present reviewer is re-reviewed-clean / carries only an acknowledged non-actionable verdict → **merge.** Cap the reviewer back-and-forth at **3 rounds** like the panel; if it won't converge, stop the rounds and say so on the PR.

⚠️ **"CLOSED", not "clean", and the difference is a bug this line used to carry.** Read as *the panel was clean*, a run that stopped on the yield rule could never satisfy it — the stop rule tells you to end the rounds before CLEAN arrives, and this line then says you are not converged, so the diff can never merge and the loop deadlocks with a finished branch and no PR. #5047 hit exactly that. A panel that stopped early has DONE its job; what it owes is the disclosure, not a verdict word.

**HARD HALTS (never autonomous)** — and these are the whole list. A Step-3 yield stop is NOT one of them; see the disambiguation there. If a stop reason is not on this list and does not make the work unshippable, it ships:
- **A Step-3 spec ambiguity you cannot resolve, or a dependency that is not merged** → HALT and ask. These are the blockers the yield stop is not: they make the work unshippable rather than merely unreviewable-further.
- **Fork PR** (`isCrossRepository: true`) → STOP, surface provenance, get human sign-off. Never `--admin` past `fork-pr-gate`.
- A required check that's **structurally missing** (e.g. CodeQL on a fork) → stop sign, not an override.
- `--admin` is only for a genuinely *broken* gate, not a *slow* one — wait for `gh pr checks --watch`.

**Step 6 — Reconcile and clean up**

After merge:
```
/tidy            # check off ROADMAP, close the issue if Closes didn't, prune
git worktree remove ../atlas-wt-<slug>
```

**⚠️ A FALSIFIER THAT CANNOT FAIL IS NOT A FALSIFIER — measure it, don't reason about it**

Step 3 and Step 6 both say *build the falsifier*. Building one is not the same as
having one, and the two ways a fresh falsifier turns out to be inert are both
cheap to check and expensive to miss. Apply the mutation the test exists to catch
and watch it go red; if it stays green the test is decoration.

Measured on #5110, which hit both classes repeatedly:

- **ACCIDENTAL EQUALITY — four times in one PR.** A test that distinguishes two
  values cannot do so when the fixture makes them equal. The sharpest case: a
  split-count assertion of `{rekeyed: 0, degenerate: 1, vocabulary_target: 1}` —
  swapping the two SQL predicates, or pointing one at the other's population,
  **passed the one test whose entire subject was telling them apart.** Same class
  hit `unkeyableFacts`/`tombstonedFacts` (both 1) and the refusal's
  `positions` (one null position, so `absent` and `repairable` were the same
  set). Give the two states different sizes: `{0, 2, 1}`, not `{0, 1, 1}`.
- **THE HELPER THAT MERGES WHAT THE TEST ASSERTS — three files in one PR.** A
  logging test whose sinks all push into one array asserts the payload and the
  message, and silently cannot see the LEVEL. Demoting `log.error` to `log.warn`
  killed zero tests in two of those files, in the same commit that fixed it in
  the third. If a property is part of the claim, it has to travel with the value
  the helper returns.

Neither is caught by reading. Both are caught by one mutation, in seconds.

**Step 7 — The close-out check (run it; do not recall it)**

Confirm each of these is TRUE by checking, and say so in the report. Every box is
one this loop has actually failed:

- [ ] PR **MERGED** — or a named HARD HALT, quoted (#5110, #5047)
- [ ] `/review-panel` invoked as a command, all three code reviewers on the FINAL
      diff, `comment-analyzer` on the closing round (#5110)
- [ ] every must-fix fixed, every named falsifier BUILT, RUN, and its measurement
      in the PR body
- [ ] **no issue closed that should NOT have** — re-run Step 5's
      `closingIssuesReferences` query against the merged PR and reconcile it with what
      you intended. A tracking bug that closes on prod verification is the case this
      catches (#5029 closed #5000 on the word "fix" inside "does not fix")
- [ ] every `Closes #N` issue actually closed — **verify**; GitHub only fires on
      merge into the DEFAULT branch, so milestone-branch mode never closes them
- [ ] `git status` clean — no mutant from an interrupted run, **no subagent probe**.
      Measured on #5110: a review subagent left a mutation applied in a file the
      branch never touched (`object-cmp.ts`), which failed three unrelated `-pg`
      suites and would have ridden along on a `git add -A`. Diff the SOURCE files
      you did not edit, not just the ones you did
- [ ] `mutation-tables` re-checked AFTER the last test edit (#5110)
- [ ] worktree removed

**Step 7 — Report**

⚠️ **Record rounds AND minutes per round in the ROADMAP entry.** Round counts have been recorded since #5027; wall clock never has, and without it there is no way to tell whether a change that makes rounds more thorough is buying fewer of them or just costing more. Two numbers per issue — `rounds: 3 (22m / 31m / 14m)` — is the whole ask, and it is what makes the Step 6 split above falsifiable.

⚠️ **Take the per-round minutes from each agent's REPORTED duration, and write nothing you cannot source.** Nothing in this loop measures elapsed session time, so an end-to-end figure is a guess wearing a measurement's formatting — the exact defect the panel spends its rounds removing from the code. #5029's ROADMAP entry shipped *"~7h end to end"* on a **2h45m** session, beside per-round numbers that were real. Record the agent durations, note what share of the run they represent if you know it, and leave the rest blank.


PR URL · issue closed · CI/merge status · panel rounds it took, with the CURVE if it stopped early · **each external reviewer's verdict** (addressed / acknowledged) · anything you halted on.

⚠️ **"Anything you halted on" means a HARD HALT.** A yield stop is not a halt and does not belong in that slot — it belongs in the rounds/curve slot beside it. Reporting an early stop as a halt is how a finished, green, merged-ready branch gets described as blocked.

---

**Rules:** Always `-R AtlasDevHQ/atlas`. Worktree-isolated commits only. The panel and **remote** CI are the mandatory gates; a full local `/ci` is NOT one — run it only under Step 4's stated exceptions. The PR stays in draft until the panel closes. Respect every merge-discipline halt in CLAUDE.md.
