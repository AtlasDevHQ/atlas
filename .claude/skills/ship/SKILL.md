---
name: ship
description: "Take an issue or spec from nothing to a PR marked ready — implement on a fresh worktree, open the draft PR early so remote CI runs while the two-axis code review runs, fix everything both find, then stop and ask the human to merge. Usage: /ship 5480, or /ship docs/prd/company-atlas.md."
---

# Ship

One lane: **issue → worktree → draft PR → CI and review in parallel → one batched fix pass → ready → hand back.**

Two things make it worth a runbook rather than a habit:

- **The draft PR opens before the review starts.** Remote CI is the gate here, not any
  local run, and it takes ~4 minutes. Opening the PR last wastes that window; opening it
  first spends it on the review.
- **It never merges.** The last step is `gh pr ready` and a question. Merge discipline in
  CLAUDE.md is not a thing an agent gets to satisfy on its own.

Every judgement in this lane is delegated — to CI, which is an external system that fails
loudly, or to the installed review skills. This file sequences them and adds no review
rules of its own. That is the test in `docs/agents/practices.md` that the surviving
runbooks pass.

## Argument

`/ship <issue-number>` — the normal form. `/ship <path>` for a spec file on disk.
`/ship <issue-number> --no-worktree` to work in the current checkout (only when you are
the sole lane; see [Running several at once](#running-several-at-once)).

## Step 1 — Pin the work

Fetch the spec before touching anything. `-R AtlasDevHQ/atlas` on every `gh` call, always:
this box runs several checkouts and worktrees, and repo inference has picked the wrong one
(`docs/agents/issue-tracker.md`).

```bash
gh issue view <N> -R AtlasDevHQ/atlas --comments
```

Read the `## Acceptance criteria` block. That is the fixed point the Spec axis of the
review will score against in step 6, so if it is empty or vague, say so now — a review
against an absent spec reports "no spec available" and this lane loses half its value.

Stop and report if any row holds. Do not continue.

| Condition | Why it stops here |
|---|---|
| The issue is closed, or already has a linked PR | Someone else is on it. Name the PR. |
| `## Acceptance criteria` is missing or empty | Offer to write it into the issue first. A spec-less lane is an implement-only lane; say that out loud rather than discovering it in step 6. |
| `## Dependencies` names an open issue | The dependency decides the shape. Name it and ask. |
| The issue asks for a change to `prod`, a release tag, or a fork PR | Out of scope — `/release`, and CLAUDE.md's merge discipline. |
| **This session cannot delegate step 6's review** | Say so **now** and ask whether to run the lane without it. A lane whose review cannot run is half a lane, and the worst moment to say so is step 8 — after the work is done and the PR is ready to merge, when the information is worth nothing (#5468). ⚠️ **A standing guardrail against spawning sub-agents is not this row.** `/ship` prescribes the review, so invoking `/ship` *is* the user requesting it. This row is for a session that genuinely cannot, never one that could and hesitated. |

## Step 2 — A fresh worktree

**One string names both.** The branch and the directory are the same token, derived only
from the issue:

```
LANE=<type>-<N>-<slug>        # e.g. docs-5450-anchor-arm-precision-prd

.claude/worktrees/$LANE   ←→   branch $LANE
```

`<type>` matches the commit convention on `main` — `fix`, `feat`, `chore`, `docs`,
`refactor`. Branch off `origin/main`, never off local `main`, which may be behind.

⚠️ **Do not "improve" the directory name, and never shorten it.** This equality is the
entire collision guard. Measured on 2026-08-27 with four lanes live, the directories in
flight were `ci-deps-track`, `m6-writeback-grill`, `ship-5335-gate-export` and
`ship-5450-prd` — against branches `chore-5421-…`, `docs-5468-…`, `feat-5335-…` and
`docs-5450-…`. Four naming schemes, two directories carrying no issue number at all, and
not one directory equal to its branch. With no mapping from directory to branch, no lane
can answer *"is this issue already claimed?"*: one entered a worktree another session was
working in, created a branch over it, then deleted that branch on the way out — orphaning
a commit the other session had already made on it. The recovery was manual.

### Claim the lane, or stop

From the **primary checkout**, before creating anything:

```bash
LANE="<type>-<N>-<slug>"
git worktree list --porcelain | grep -F "$LANE"   # expect: no output
git branch -a --list "*-<N>-*"                    # expect: no output
cat .claude/worktrees/.lanes/*.json 2>/dev/null   # who owns what, if anything
```

| What you see | What to do |
|---|---|
| All empty | Unclaimed. Continue. |
| A worktree or branch carries this issue number | **Stop.** Another lane owns it, live or abandoned. Report the path, the branch, and the owning session from the lane file. |
| A worktree exists with uncommitted work | **Stop.** Never enter it. Uncommitted work belongs to a session that is still thinking. |
| `git worktree add` fails, for any reason | **Stop and report the error verbatim.** Something raced you between the check and the add. |

The trailing dash in `*-<N>-*` is load-bearing: it keeps `#545` from matching
`docs-5450-…`.

### Create it

```bash
git fetch --prune origin
git worktree add ".claude/worktrees/$LANE" -b "$LANE" origin/main
mkdir -p .claude/worktrees/.lanes
printf '{"lane":"%s","issue":%s,"session":"%s","started":"%s"}\n' \
  "$LANE" "<N>" "${CLAUDE_CODE_SESSION_ID:-unknown}" "$(date -Iseconds)" \
  > ".claude/worktrees/.lanes/$LANE.json"
cd ".claude/worktrees/$LANE" && bun install
```

The lane file is what makes an abandoned worktree distinguishable from a live one, which
`git worktree list` alone cannot tell you. It sits **beside** the worktrees, never inside
one — a marker file inside a checkout shows up as untracked and trips this lane's own
dirty-tree checks.

`.claude/worktrees/` is the established location: `.gitignore` ignores `.claude/*` with a
short un-ignore list that does not include it, so worktrees and lane files are invisible to
`git status` in the primary checkout, and the repo's guards prune that path when they walk
the tree. `docs/development/release-process.md` uses the same directory for the hotfix lane.

### Three things this lane never does

Absolute. Each is the exact move that orphaned the commit on 2026-08-27.

1. **Never `git branch -d` or `-D`.** Not to clean up, not to retry, not even on a branch
   you created seconds ago — a concurrent session may already have committed onto it, and
   a deleted branch whose commit is unmerged leaves that commit reachable only by SHA.
2. **Never `git worktree remove`, and never enter a worktree you did not create.**
   Cleanup belongs to `/tidy`, after the merge.
3. **Never improvise past a failed `worktree add`.** No `-2` suffix, no `--force`, no
   reusing the directory that is already there. **The failure is the guard working** —
   report it and stop.

If you believe a lane is genuinely abandoned, say so with its lane file and let the human
decide. Reclaiming one is not this command's call.

⚠️ **`bun install` per worktree is a full `node_modules`.** It is the cost of the
isolation and worth paying, but four lanes is four copies. `bun install` exits 0 while
printing peer-dependency conflicts — quote any warning it prints, and say if it changed
`bun.lock`.

## Step 3 — Implement

Implement the work the step-1 spec describes. Use `/mattpocock-skills:tdd` at pre-agreed
seams.

⚠️ **This step deliberately does not call `/mattpocock-skills:implement`, and the reason is
not style.** That skill declares `disable-model-invocation: true`, so it is absent from the
model-invocable skill list — an agent running this lane *cannot* invoke it, and an
instruction to do so fails silently as a no-op. Its substance is five lines and they are
inlined here. Two of them do not survive contact with this repo anyway: it says to run the
full test suite once at the end, which is the shape that has taken WSL down more than once,
and to close by calling `/mattpocock-skills:code-review` — which this lane does in step 6,
*after* the PR is open, because that ordering is the whole point of the command.

The local loop is narrow here, and the reason is not speed:

- **Iterate with single files**: `bun test path/to/one.test.ts`. This is the default for
  the whole loop.
- **Never a bare `bun test --parallel`, and never a directory glob.** `--parallel`
  defaults to one worker per core — 32 on this box — and has taken WSL down with
  `out of file descriptors` and `SIGABRT` more than once. `.claude/hooks/guard-bun-test.sh`
  denies those shapes at the tool boundary; do not go looking for the escape hatch.
  **`SIGABRT` on a rotating set of files is memory pressure, not flakiness** — stop, don't
  re-run to see if it moves.
- **Repo-wide `bun run type` / `lint` are step-4 steps, not iteration steps.** Once, at
  the end.
- **Do not regenerate anything yet.** Not OpenAPI, not the mutation tables. Both have
  remote gates that name the fix, and the mutation sweep is 15–31 minutes. Batch every
  source and test edit first so it can run once, in step 7, and only if CI says it must.

Commit to the branch as you go. Message shape from `main`: `type(scope): subject (#N)`.

⚠️ **Writing or moving a test that carries a `MUTATIONS THIS CATCHES` table?** Never edit
a cell by hand — the table is rendered from `packages/api/scripts/mutations/<name>.mutations.ts`
and a hand-typed cell is a claim wearing a measurement's formatting. Leave it stale and
let step 7 regenerate it. `.claude/rules/testing.md` is the full rule.

## Step 4 — The cheap pre-flight, once

```bash
cd packages/api && bun test --parallel --changed=origin/main
bun run lint
bun run type
bun run lint:type-aware
```

That is the whole local gate. `--changed` is safe because it is nearly always a handful
of files.

`lint:type-aware` is on the list because it is **its own CI-blocking job** and costs ~11s.
Leaving it off is what let one type-aware diagnostic redden two CI jobs on #5083 after a
pre-flight came back clean.

⚠️ **Do not run `scripts/ci-local.sh` here.** It is ~25 minutes, serial, and rewrites
source in place for the mutation gate. CLAUDE.md makes remote CI on the PR the gate and
the local wrapper advisory. `/ci` is for when remote CI is broken.

## Step 5 — Draft PR, before anything else

This is the step the whole command exists to get to early.

```bash
git push -u origin <branch>
gh pr create -R AtlasDevHQ/atlas --draft --base main \
  --title "type(scope): subject" --body-file - <<'EOF'
Closes #<N>

## What changed
## How it was verified
EOF
```

⚠️ **`--draft` is not optional.** A ready PR invites a merge before the review has run.

⚠️ **`Closes #N` closes the issue on merge, and GitHub ignores negation** — *"does not
fix #N"* still closes it. Any other issue you mention, write as `issue 1234` or a link,
because a bare `#N` anywhere in the body parses as a dependency edge.

**Do not `--watch` yet.** CI has ~4 minutes of work; go spend it.

## Step 6 — Review while CI runs

Run `/mattpocock-skills:code-review` with `origin/main` as the fixed point and the issue
from step 1 as the spec. It spawns a **Standards** and a **Spec** sub-agent in parallel and
reports them side by side without merging the findings — the separation is the point, so
do not rerank them into one list.

Three things about sub-agents on this box:

- **Tell the reviewers not to run tests.** They are reading a diff. The bun-test guard
  counts live workers across every session and denies once the fleet total would exceed
  12; a reviewer that decides to verify a claim by running a suite spends the budget the
  implement lane needs.
- ⚠️ **A finished sub-agent goes quiet, and its report is on disk.** `ListAgents` showing
  "No reachable agents" — or showing the agent as `idle` with nothing delivered — means
  the process ended, **not** that the output is lost. Read the last assistant block out of
  its transcript JSONL. Do not ping it, do not re-spawn it, and above all do not re-do the
  review yourself: a self-review by the code's author is exactly the independence the
  delegation bought. In a worktree the transcript directory is named after the **worktree**
  path, not the repo root.
- ⚠️ **If you conclude you may not delegate at all, that is a step-1 report, not a step-8
  footnote** — and check the conclusion before you act on it. **A standing instruction not
  to spawn sub-agents unprompted does not outrank the user's `/ship`**: this step is what
  they invoked, so the request is already made. The delegation is the command's substance,
  not an optimization it chose. #5468 is the case — the lane read a general guardrail as a
  veto, skipped the review, self-checked instead, and reported it only in the final table.
  The self-check happened to be the right instrument for that diff (prose asserting things
  about code, where only grepping the tree catches a false claim), which is why it went
  unnoticed until after the merge. **A substitution that works is still a substitution: say
  which axis went unrun, in step 1.**

## Step 7 — Collect CI, then one batched fix pass

```bash
gh pr checks <PR> -R AtlasDevHQ/atlas --watch
gh run view <run-id> -R AtlasDevHQ/atlas --log-failed   # for each red job
```

| Red job | What it means | What to do |
|---|---|---|
| `api-tests (shard)` | A real failure. CI shards four ways against a dedicated Postgres, which is why it reddens SHAs a local run calls green. | Reproduce the single file locally. Never the shard. |
| `lint`, `type`, `lint-type-aware` | Should have been caught in step 4. | Fix, and note which pre-flight step was skipped. |
| `drift` | A generated artifact is out of step, or a doc names a path, command or count that does not exist. | Regenerate the **minimum**. If only `apps/docs/openapi.json` moved, `bun run --filter '@atlas/api' openapi:extract` alone is enough; the docs half is the slow one. |
| `mutation-tables` | A generated table no longer equals what re-running its spec produces. | See below. |
| `fork-pr-gate`, CodeQL | Structurally cannot run on a fork PR. | **Not yours to fix and never an `--admin` invitation.** If this PR is cross-repository, stop — CLAUDE.md forbids an agent merging a fork PR at all. |
| `build`, `ee-stub-build` | | Read the log; these fail loudly and specifically. |

**The mutation table lane, because it is the expensive one:**

The job prints the exact command per stale spec:

```bash
cd packages/api && bun run scripts/mutate.ts scripts/mutations/<name>.mutations.ts
```

⚠️ Three conditions before you spend it:

1. **Say so and get agreement first.** At `--all` this sweep has been measured at 15.6,
   15.9, 18.4 and 31.0 minutes. Disappearing into half an hour without saying so is the
   failure this note exists for.
2. **`TEST_DATABASE_URL` must be set**, or the specs targeting `*-pg.test.ts` self-skip and
   the runner aborts on a deflated baseline. Committing zeros over real counts is worse
   than the stale table.
3. **Run it once, last.** Batch every other fix — CI's and the review's — before it, or
   you will pay for it twice.

**Batch the whole pass.** CI findings and review findings land in one commit and one push,
because a second push is another full CI cycle. Then re-watch.

For each review finding, record a disposition: fixed, or declined with a reason. A finding
silently dropped is the one that comes back.

## Step 8 — Ready, then stop

```bash
gh pr ready <PR> -R AtlasDevHQ/atlas
```

Then report and **stop**. Do not merge. Do not `--admin`. Report:

| | |
|---|---|
| Lane | `$LANE` — the branch and the worktree directory, which are the same string |
| PR | number and URL |
| Checks | every job and its state on the **head SHA** — not an earlier one |
| Standards axis | finding count, and the disposition of each |
| Spec axis | acceptance criteria met / partial / missing, quoted |
| Mutation tables | regenerated (which specs, how long) or not needed |
| Left undone | anything you could not verify |

Write **UNKNOWN** for any check you could not run. A skipped step is not a passed step.

End with the question: **merge, or not?** The answer is the human's.

After a merge, `/reset` returns the primary checkout to a clean `main`, and `/tidy`
reconciles the issue, labels and the branch — including removing this worktree.

## Running several at once

Each `/ship` gets its own worktree, its own branch and its own PR, so the repo is not the
contended resource. **The box is.**

- **The bun-test guard is a fleet counter**, not a per-command one: it counts live
  `--test-worker` processes across every session and denies when the total would exceed 12.
  Two capped runs fit; a third does not. Every lane sticking to `--changed` pre-flight and
  single files is what keeps that from binding.
- **One Postgres container is shared.** Two lanes running `-pg` suites against the same
  `TEST_DATABASE_URL` at the same time will produce flakes that look like real failures.
  Sequence the pg-touching pre-flights, or accept that a red there needs re-running alone
  before you believe it.
- **Only one lane regenerates mutation tables at a time.** It rewrites source in place.
- **A lane is claimed by its issue number, and the claim is visible in three places** —
  the branch name, the worktree directory name (the same string) and
  `.claude/worktrees/.lanes/`. Two lanes on one issue is not a case to disambiguate with a
  suffix; it is a mistake, and step 2 stops on it.
- Lanes are independent until merge. Two PRs touching the same file merge-conflict on the
  second merge, not during the lane — that is `/mattpocock-skills:resolving-merge-conflicts`
  territory, after the human's answer in step 8.

## Out of scope

- **Merging.** Step 8 asks; it never acts. Fork PRs are forbidden to agents outright.
- **Releases and tags** — `/release`.
- **Cleanup after the merge** — `/reset`, then `/tidy`.
- **The full local gate** — `/ci`, and only when remote CI is broken.
- **Anything on `prod`.** It is a Railway-tracking artifact advanced only by the release
  flow.
