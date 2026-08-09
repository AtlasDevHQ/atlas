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

Each is read-only/advisory. Give every agent the same context: the base ref, the changed files, and the scope rule below.

**The scope is the changed lines PLUS their enclosing declaration.** Not "only the changed lines", and not the whole file. The enclosing declaration is the function, the object literal, the union, the interface — whatever construct the changed line sits inside, read whole.

⚠️ **This widening is the single highest-yield change this command has had, and it is here because the narrow rule has a structural blind spot.** A defect and its twin are usually *adjacent*: in #5088 a `claims: … : 0` coalesce was fixed while `sourceClass: … : ""` and `proposedBy: … : ""` sat on the next two lines of the same object literal. Unchanged lines, therefore outside a strict diff scope, therefore invisible to the reviewer — for three consecutive rounds. A reviewer obeying "only the changed lines" *cannot* find that, no matter how good it is.

Say it to the agent in those words, because "review the diff" reads as the narrow rule by default.

**On a re-review (round 2+), also pass the previous round's fix commits and name them the primary target.** Fresh context is what keeps the panel from rubber-stamping, but it also means round N does not know what round N−1 fixed unless you say so. Give the SHAs and one line each on what they claimed to fix; ask the reviewer to audit those fixes specifically, and to check whether each fix's *class* was closed or only its instance. In #5088 this was improvised by hand at round 4 and that round found more than rounds 2 and 3 combined.

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

**Step 5b: SWEEP FOR SIBLINGS before you write the fix**

⚠️ **A finding names a CLASS. Fixing only the reported instance is what makes a
round cap bind.** Before writing each fix, spend one grep asking *"where else does
this exact shape appear?"* — the same file first, then the module, then the twin
half of whatever pair you are in. Fix every instance in the same commit.

The shapes worth sweeping for, because they are what actually recurred:

- **The adjacent field.** A coalesce, a narrowing, a default, a guard — check the
  lines above and below it in the same literal or the same parameter list.
- **The mirror half.** Almost every subsystem has two of something: two verbs
  (approve/reject), two positions, two kinds, two arms of a union, a client half
  and a server half. If the fix landed on one, the other is the first place to
  look — and if a test landed on one, the other is where it is missing.
- **The other caller.** A guard added at one call site of a shared helper is
  usually missing at the rest.

Report the sweep in one line per finding — *"same shape at X, Y; fixed"* or
*"swept the module, no other instance"* — so a later round can see the class was
closed rather than the instance.

**This is measured, not theoretical.** #5088 took five rounds, and four of them
found the previous round's fix had a twin nobody looked at: round 1's bug four
lines away on the `computed` branch; round 2's per-side fix covering only the
both-zero case; round 3's pin covering 4 of an arm's 7 fields; round 3's `claims`
guard with two identically-broken fields directly beneath it. Every one of those
was a one-grep sweep away at the moment the fix was written.

**Step 5c: Verify the commit message against the commit**

Before pushing, check that every fix the message claims is actually in the diff:

```bash
git show --stat HEAD          # do the files match what the message says it fixed?
```

⚠️ Cheap, mechanical, and it catches a failure with no other detector. Two of
#5088's commit messages claimed fixes that were never in the tree — one named a
file absent from the commit entirely. A message asserting a fix over a hole no
test can see is worse than a silent hole: it stops anyone looking.

**Step 5d: Check each fix against its own finding — IN FRESH CONTEXT, in this round**

For every must-fix you resolved, launch `Agent(fix-vs-finding)` with exactly two things: the finding's principle **restated as a universal** (strip the file, the line, the symbol) and the fix diff. It answers one question — *does this fix exhibit the defect it fixes?* — and returns `REPRODUCED` / `CLEAN` / `CANNOT TELL`. Treat `REPRODUCED` as a must-fix of this round, not the next one.

Batch them: one `Agent` call per must-fix, all in one message, `run_in_background: false`, no `name:` (Step 2's warning applies unchanged).

⚠️ **Fresh context is the entire mechanism, and it is not a preference.** Four times — #5027, #5032, #5077, #5088 — a fix reproduced the defect it fixed, one layer over, with the principle written down correctly nearby and twice in the same commit. Step 5b cannot catch it: a sibling sweep searches the tree that **exists**, and the recurrence is in the new surface being written as the fix. You cannot catch it either, for the reason this whole command exists — the context that wrote the fix holds the argument for why the fix is right, which is what hides the repeat. Round 2 of #5077 caught exactly this, and caught it *a round too late*: the check is the same check, moved inside the round that produced the fix.

Report one line per must-fix alongside the fixes — the same place Step 6's named falsifiers go. **A round with an unresolved `REPRODUCED` is not clean**, whatever the three code reviewers said.

⚠️ **`CANNOT TELL` is not a pass.** It means the principle could not be made universal or the diff was not the whole fix — either way the check measured nothing, and a round that counts it as "not REPRODUCED" has certified a fix nothing looked at. That is the byte-blessing shape #5077 exists to refuse, reproduced in the instrument built to catch it. Re-run with a repaired universal or the complete diff; if it still cannot tell, say so in the round report as an **open** item rather than resolving it silently. Likewise, a `CLEAN` that does not name the added surface it checked is indistinguishable from one that did not look — send it back.

**Step 6: Every must-fix's FIX needs a falsifier — NAMED every round, BUILT in the last one**

A fix is not closed when it is written. It is closed when something can tell you
it stopped working.

For each must-fix you resolved, name one of three:

- a test that fails without the fix,
- a row in a `scripts/mutations/*.mutations.ts` spec, or
- an explicit *"this is unfalsifiable, and here is the measurement instead"* —
  carried in the docstring, not in your head.

⚠️ **NAMING is every round. BUILDING and RUNNING is the closing round only.**
The split is not a softening — it is where the cost actually falls, measured.
Naming is the cheap tell this step already calls *"one question, and it is
cheap"*: if you cannot say what would go red, you have not closed the finding,
and that is the check #5027's rounds 1–2 failed. Building is the expensive half
— write the test, apply the mutant, run it, revert — and on a non-final round
you are paying it for code the next round may rewrite. #5088's yield went
30 → 18 → 11 → **21**: the rise means round 3's fixes were themselves defective,
so every falsifier built for them was built for code round 4 replaced.

So: rounds 1..N−1 carry a **named** falsifier per must-fix, in the fix's
docstring or the round report. The closing round builds and runs every one that
is still standing, and the round is not clean until it has. **Nothing merges
unfalsified** — which is the whole of what the rule protects — but nothing is
falsified twice.

⚠️ This is the same move `aa6ec839a` made for the comment sweep, for the same
reason, and it is the one to check first if rounds start rising again: if the
named-but-unbuilt falsifiers are what later rounds keep tripping over, the split
is wrong and this paragraph is the evidence to revisit.

⚠️ **Its absence entirely is what made #5027 take four rounds.** Rounds 1 and 2
there shipped ~500 lines of fixes
with none of the above. A reviewer probed eleven of them and got **eleven
zeros** — so every fix was unreviewable, and each round's defect survived into
the next:

- **R1** bounded an unbounded post-commit await with a timer whose `.finally()`
  was attached to the **timer promise** — which settles only when the timer
  fires, so `clearTimeout` was unconditionally a no-op and the fast path left a
  5s timer armed per correction.
- **R2**'s replacement then logged a fast `42P01` as *"could not be evaluated
  within its deadline … may still commit"* when no deadline event had happened
  and the transaction had definitively rolled back — **a lying disclosure in the
  helper written to stop one.**
- **R3**'s own continuation was unreachable by any test, so deleting all 28
  lines of it stayed green.

The tell is one question, and it is cheap: **if you cannot say what would go
red, you have not closed the finding — you have moved it one round later, where
it costs more.**

**A `0` in a mutation table is a CLAIM, not a note.** #5027's round 2 published
one as honest — *"invisible to a test suite; `bun test` force-exits"*. The
technique that falsifies it was already in `correction-audit.test.ts`, one file
over, guarding the same defect in the same module; it stayed green only because
it drove a verb that never reached the code under test. Before writing a `0`,
grep the sibling suites for the thing you are about to declare untestable.

**Cost, stated honestly:** for (a) local defects this is usually one assertion.
It is the expensive half for anything touching timing, concurrency or
post-commit ordering — #5027 needed a delayed-settle fake and a `setTimeout`
handle recorder to reach two of its arms. Pay it there especially; those are the
arms nothing else can see. **That cost is exactly why building is the closing
round's job** — a delayed-settle fake written for a round-2 fix that round 3
rewrites is the purest form of the throwaway work the split removes.

⚠️ **RUN the mutant — in the closing round, for every falsifier you named
along the way. A falsifier you only reasoned about is not one**, and your
own is the one most likely to be too weak — you write it knowing the fix, so you
naturally aim it at the failure you already fixed. Two from #5088, both of which
looked airtight and both of which passed against the broken code:

- A duplicate-React-key test that rendered two colliding rows and asserted both
  appeared. React renders both children on a first pass; the harm needs the list
  to **change**. The real falsifier previews the second row, decides the first
  away, and asserts the survivor keeps its own state.
- A `never`-default test asserting on a 500's response body — in a file that
  mocks `runEffect` away, so the body is a constant `text/plain` for *every*
  cause. The assertion could not fail while the status was 500. It now asserts
  the defect's cause.

The second one is the general shape: **an assertion that cannot fail is not an
assertion.** Ask what value would make it go red, and check that value is
reachable.

**Rules:**
- Read-only. The panel reports; it never edits code.
- Scope is the changed lines **plus their enclosing declaration** (Step 2). The strict-diff reading has a blind spot for adjacent twins and it has cost real rounds.
- Fresh context per agent — never let the implementer "review" its own diff in-context; that rubber-stamps. On round 2+, fresh context **plus** the previous round's fix commits named as the audit target.
- Every fix is checked against its own finding in **fresh context, in the round that wrote it** (Step 5d). Step 5b sweeps the tree that exists; 5d is the only thing that looks at the surface the fix just added.
- Falsifiers are **named every round and built in the closing one** (Step 6). A round that names none is not clean; a CLOSING round that has not built and run them is not clean either.
- This is the specialist layer. The repo's `/code-review` and `/simplify` remain the canonical generic passes — don't duplicate them here.
