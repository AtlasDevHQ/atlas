---
description: "Run the four specialist reviewers over the current diff in parallel with fresh context. The shared primitive /ship-issue and /ship-milestone call before a PR opens."
---

Run the internal review panel on the current diff — the four tuned specialist reviewers, fan-out in parallel, fresh context.

**Input:** `$ARGUMENTS` — optional base ref to diff against. Default: `origin/main`. (Inside a PR, diff the PR branch against its base.)

This is the shared review primitive both `/ship-issue` (L0) and `/ship-milestone` (L2) call. It reviews **before** the PR opens, with fresh-context agents rather than the author re-reading its own diff. See `docs/agents/loops.md` and `.claude/agents/README.md`.

---

**Step 1: Compute the diff**

```bash
BASE="${ARGUMENTS:-origin/main}"
git fetch origin --quiet
git diff "$BASE"...HEAD --stat   # scope
```
If there is nothing to review, say so and stop.

**Step 2: Fan out the panel — IN PARALLEL, fresh context**

**The three code reviewers run EVERY round. `comment-analyzer` runs only on the round that turns out to be final.**

The reason is that comment findings are mostly *consequences* of the code findings. A comment sweep in round 1 describes code that round 1's own fixes are about to change, so its output is invalidated by the work it triggered — the round is spent and re-spent. The three code reviewers have no such dependency on each other.

This is safe precisely because it is also useful: comment-only fixes are non-structural. They do not add a code path, so they almost never generate the follow-on round that a fix adding real machinery does. `comment-analyzer` is therefore the one reviewer whose findings can be gathered late without costing a round. **Do not "restore" it to every round** — that is the change this rule exists to prevent.

Which round is final is not a prediction. It is determined structurally:

1. Run the three code reviewers — `silent-failure-hunter`, `type-design-analyzer`, `pr-test-analyzer` — in parallel.
2. **Any must-fix → report `CHANGES REQUESTED` now.** Do not run `comment-analyzer`; this round is not final and its output would be discarded.
3. **No must-fix → this round IS the final one.** Run `comment-analyzer` before reporting, merge its findings in, and only then issue a verdict.

So a `CLEAN` verdict is unreachable without a comment sweep on the same diff, and "at least once before merge" is a property of the command rather than something the author has to remember. If `comment-analyzer` then raises a must-fix, the verdict is `CHANGES REQUESTED` like any other — fix and re-run.

Pass `--final` to force all four in one round (useful for a docs- or comment-heavy diff, where deferring the sweep just delays the only review that matters).

Launch each round's reviewers in a single message (multiple `Agent` tool calls, one response) so they run concurrently. Each gets the diff scope and is told to review only the changed lines:

> ⚠️ **Call `Agent` with `run_in_background: false` and NO `name:`.** Both matter, and getting either wrong loses the whole panel *silently* — the agents run, write complete reports, and you never see them.
>
> Passing `name:` makes an agent an addressable teammate. A teammate signals completion with an `idle_notification` and its final text stays in its own transcript; it is never returned as the tool result. `SendMessage` does not rescue it — each nudge writes another full reply into the same transcript and sends another idle ping. The failure looks like four agents that "never delivered", so the natural reaction is to give up on the panel and review inline, which is exactly the rubber-stamp this command exists to prevent.
>
> Synchronous is what makes the report the tool result. Four concurrent `Agent` calls in one message still run in parallel with `run_in_background: false` — synchronous does not mean serial.
>
> **If a panel run ever does come back empty:** the reports are not lost. They are the last assistant message in each `~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl`. Recover them before re-running — a re-run costs four fresh contexts and loses the reasoning.

Every round:
- `Agent(silent-failure-hunter)` — error handling & silent failures
- `Agent(type-design-analyzer)` — type invariants & safety
- `Agent(pr-test-analyzer)` — test coverage & discipline

Final round only (or with `--final`):
- `Agent(comment-analyzer)` — comment accuracy & idiom

Each is read-only/advisory. Give every agent the same context: the base ref, the changed files, and "review only this diff against Atlas's CLAUDE.md standards; report findings with file:line + severity."

**Step 3: Collect, dedupe, prioritize**

Merge the four reports. Drop duplicates (e.g. an untested error path flagged by both silent-failure-hunter and pr-test-analyzer → one entry). Sort by severity.

**Step 4: Output**

```
## Review panel — <N> findings

### Must fix (CRITICAL / HIGH)
- [silent-failure] file:line — <issue> → <fix>
- [type-design]   file:line — <issue> → <fix>

### Should consider (MEDIUM)
- ...

### Clean axes
- <agents that found nothing>

### Comment sweep
- <`run` with its findings folded in above · or `deferred — not the final round`>
```

End with a one-line verdict: **CLEAN** (nothing must-fix) or **CHANGES REQUESTED** (≥1 must-fix). Callers gate on this verdict. A **CLEAN** verdict asserts the comment sweep ran on this diff — if it didn't, the verdict is not CLEAN yet.

**Step 5: Triage each must-fix BEFORE fixing it**

For every must-fix, say which of two things it is:

- **(a) Local defect** — the fix corrects existing behaviour: a missing null check, an unhandled rejection, a wrong type, a test that cannot fail. **Fix it inline. This is the overwhelming majority and it is not a decision** — it is the repo's standing rule (*fix inline, don't farm follow-ups*), and this step does not soften it.
- **(b) New machinery** — the fix cannot be made without introducing something that did not exist: a new primitive, a new statement, a new field threaded through a report and its audit trail. Then make the in-PR-vs-follow-up call **explicitly** and **record it in the PR body** with one line of reasoning, whichever way it goes.

The test for (b) is *"does the smallest correct fix add a new thing?"* — not *"is this fix big?"* and never *"am I tired of this PR?"*. A large mechanical edit is still (a). If you cannot name the new primitive, it is (a).

⚠️ **This step does not exist to shrink diffs, and choosing "follow-up" is not the default answer for (b).** In #5033 a round-1 finding — the tier guard refused irreversibly with no operator trace — was fixed inline, which took the diff from ~400 to ~1,900 lines and produced rounds 2 and 3. **That was the right outcome.** The fix added a savepoint primitive; round 2 found it could roll back an entire publish, and round 3 found round 2's `SAVEPOINT` itself unguarded. Capping the rounds would have shipped a diagnostic capable of rolling back a customer's publish.

So the point is not fewer rounds. It is that a fix which triples the diff should be a **visible decision with a recorded reason**, made when the growth is proposed rather than discovered three rounds later — and a PR that grew that way should say so, because the reviewer's read of it changes.

**Rules:**
- Read-only. The panel reports; it never edits code.
- Fresh context per agent — never let the implementer "review" its own diff in-context; that rubber-stamps.
- This is the specialist layer. The repo's `/code-review` and `/simplify` remain the canonical generic passes — don't duplicate them here.
