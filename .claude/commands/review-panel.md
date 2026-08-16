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

This is safe precisely because it is also useful: comment-only fixes add no code path, so they rarely generate the follow-on round that a fix adding real machinery does. `comment-analyzer` is therefore the one reviewer whose findings can usually be gathered late without costing a round. **Do not "restore" it to every round** — that is the change this rule exists to prevent.

⚠️ **"Rarely", not "never" — and the exception is the sweep's own output, so read its findings with the skepticism you give a code reviewer's.** This paragraph used to say a comment fix *cannot* generate a round. Measured false on #5029: the sweep flagged a docstring as inaccurate, and the rewrite **asserted a type-level guarantee that did not exist** — `message` was typed by indexing the object it was populated from, and all three values were built with `+`, which collapses to `string` under `as const`. So an accurate description of a hole was replaced by a claim of a guard nobody had built, on the one field that could carry a pg error message to a client. The *type* reviewer caught it a round later.

The rule that follows is narrow: **a comment fix asserting a TYPE-LEVEL or MEASURED property is a claim, and gets verified like one** — compile the counter-example, run the probe. A comment fix restating intent is still free.

Which round is final is not a prediction. It is determined structurally:

1. Run the three code reviewers — `silent-failure-hunter`, `type-design-analyzer`, `pr-test-analyzer` — in parallel.
2. **Any must-fix → report `CHANGES REQUESTED` now.** Do not run `comment-analyzer`; this round is not final and its output would be discarded.
3. **No must-fix → this round IS the final one.** Run `comment-analyzer` before reporting, merge its findings in, and only then issue a verdict.

So a `CLEAN` verdict is unreachable without a comment sweep on the same diff, and "at least once before merge" is a property of the command rather than something the author has to remember. If `comment-analyzer` then raises a must-fix, the verdict is `CHANGES REQUESTED` like any other — fix and re-run.

⚠️ **"Final" means THE LAST ROUND THIS DIFF GETS — which is not the same as "no must-fix".** The caller can also leave the loop on `/ship-issue`'s live yield stop or its 3-round cap, and on those paths the diff is done being reviewed while must-fixes are still open. Read literally, rule 2 then skips the sweep forever.

That is not hypothetical: **#5077 stopped on the yield rule and merged with NO comment sweep at all**, on a comment-heavy diff, because the round with no must-fix never arrived. Two rules that did not know about each other.

So: **if the caller is stopping — for any reason — run `comment-analyzer` before reporting, even with must-fixes open.** Its findings then travel with the handoff instead of evaporating. `/ship-issue` Step 3 states the same obligation from the other side; if you ever change one, change both, because the failure mode is precisely that they drift apart.

Pass `--final` to force all four in one round (useful for a docs- or comment-heavy diff, where deferring the sweep just delays the only review that matters — and it is the flag to reach for the moment you suspect this round is the last).

Launch each round's reviewers in a single message (multiple `Agent` tool calls, one response) so they run concurrently. Each gets the diff scope and is told to review only the changed lines:

⚠️ **This is the single largest recoverable cost in the loop, and stating the rule is evidently not enough — measure it instead.** On #5029 the three reviewers were launched one per message in BOTH round 1 and the closing round, so they ran back-to-back: **28.5m and 36m serial against 11.6m and 12.3m parallel — 41 minutes, 25% of a 2h45m session.** The run even announced "in parallel" and then made two separate calls.

The instinct that causes it is wanting to read each report before starting the next. **That buys nothing here**: the reviewers are fresh-context and independent by construction, so nothing in report 1 changes what reviewer 2 should look at — that is the whole reason they are separate agents. The ONE place sequencing is correct is Step 5d, where each check audits the fix the previous one produced.

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
- `Agent(comment-analyzer)` — comment accuracy, idiom & prose de-slop (concise plain-English comments; the style rules live in the agent definition). Also returns capped, advisory **Adjacent candidates** for the enclosing block, which never gate the verdict

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

### Adjacent candidates (advisory)
- <comment-analyzer's out-of-diff de-slop suggestions, verbatim · or `none`>
```

End with a one-line verdict: **CLEAN** (nothing must-fix) or **CHANGES REQUESTED** (≥1 must-fix). Callers gate on this verdict. A **CLEAN** verdict asserts the comment sweep ran on this diff — if it didn't, the verdict is not CLEAN yet.

**Adjacent candidates never count toward the verdict.** They are `comment-analyzer`'s de-slop suggestions for the enclosing block, outside the diff, capped at five. Pass them through for the author to take or drop; a round is never held open for one, and taking one is never required to reach CLEAN. Fixing them is optional even when the fix is obvious — an adjacent comment describes code this diff did not touch, so a rewrite there is an unreviewed claim about unread code.

**Step 5: Triage each must-fix BEFORE fixing it**

For every must-fix, say which of two things it is:

- **(a) Local defect** — the fix corrects existing behaviour: a missing null check, an unhandled rejection, a wrong type, a test that cannot fail. **Fix it inline. This is the overwhelming majority and it is not a decision** — it is the repo's standing rule (*fix inline, don't farm follow-ups*), and this step does not soften it.
- **(b) New machinery** — the fix cannot be made without introducing something that did not exist: a new primitive, a new statement, a new field threaded through a report and its audit trail. Then make the in-PR-vs-follow-up call **explicitly** and **record it in the PR body** with one line of reasoning, whichever way it goes.

  ⚠️ **(b) defaults to a FOLLOW-UP from ROUND ONE, not from round two.** Not a ban — a default, overridable in one line, and the override is the interesting case rather than the exception. The reason is arithmetic: machinery introduced by a fix is unreviewed code entering the diff, and it arrives with no round left to review it except the one it will itself cause.

  ⚠️ **This rule used to exempt round 1, and the exemption was backwards.** #5077's ROUND 1 added ~600 lines of new machinery (a refusal path, a cell marker, a gate script, a fixture suite) and round 2's rise was almost entirely defects inside it — two fixtures that asserted nothing, a cell that certified itself green forever. #5037 repeated it exactly: round 1 added a branded type, three guards and a statement-scanning test block; round 2 returned ~26 findings, ~20 of them defects inside that machinery. **Round 1 is where the machinery lands, so exempting round 1 exempted the precise thing this rule exists to catch.**

  Override when the defect is live and the machinery is what makes it safe — #5033's savepoint is the standing example, and deferring it would have shipped a diagnostic capable of rolling back a customer's publish. Do **not** override to avoid the bookkeeping of filing an issue.

The test for (b) is *"does the smallest correct fix add a new thing?"* — not *"is this fix big?"* and never *"am I tired of this PR?"*. A large mechanical edit is still (a). If you cannot name the new primitive, it is (a).

⚠️ **This step does not exist to shrink diffs, and choosing "follow-up" is not the default answer for (b).** In #5033 a round-1 finding — the tier guard refused irreversibly with no operator trace — was fixed inline, which took the diff from ~400 to ~1,900 lines and produced rounds 2 and 3. **That was the right outcome.** The fix added a savepoint primitive; round 2 found it could roll back an entire publish, and round 3 found round 2's `SAVEPOINT` itself unguarded. Capping the rounds would have shipped a diagnostic capable of rolling back a customer's publish.

So the point is not fewer rounds. It is that a fix which triples the diff should be a **visible decision with a recorded reason**, made when the growth is proposed rather than discovered three rounds later — and a PR that grew that way should say so, because the reviewer's read of it changes.

**Step 5b: BEFORE writing the fix — the behaviour delta, then the sibling sweep**

⚠️ **A finding names a CLASS, and a class has members in TWO directions. Miss
either and the fix breeds the next round's work.**

**5b(1) — THE BEHAVIOUR DELTA. Mandatory for any fix to a conditional: a guard,
a refusal, a branch, a comparison, a gate.**

Before writing the code, enumerate the INPUT CLASSES at that site and state, for
each, what the old code did and what the new code does. Four rows, two minutes,
pasted into the commit message:

```
                              old        new
stored key absent             refuse     PERMIT   ← changed
stored == derived             refuse     refuse
stored != derived             refuse     PERMIT   ← changed
both degenerate               refuse     refuse
```

Then answer one question per changed row: **is the new behaviour more
conservative?** If any row moves toward the irreversible direction, the fix is
wrong however well it closes the reported symptom.

⚠️ **This is the step that was missing, and its absence is measured.** #5037's
`replacementIdentical` guard was edited three times. Each edit fixed the symptom
a reviewer reported and silently opened the input class beside it — the second
one regressing the exact scenario the ticket was written for (a key carried from
a foreign vocabulary). The table above is that issue's, written after the fact;
written before, it shows both defects on the FIRST edit, because the changed rows
are visible the moment you list them.

**Prefer an ADDITIVE edit over a REPLACEMENT.** Adding a disjunct to a refusal
can only ever refuse more, so it cannot regress in the permitting direction *by
construction*. Replacing a comparison moves behaviour in both directions at once.
Where the two are available, take the additive one and say so — that is a
guarantee rather than an argument, and argument is what fails here.

**5b(2) — THE SIBLING SWEEP,** for everything else. One grep asking *"where else
does this exact shape appear?"* — the same file first, then the module, then the
twin half of whatever pair you are in. Fix every instance in the same commit.

⚠️ **The two halves find different things and neither substitutes for the other.**
The grep finds siblings in SPACE: the same shape in another file, another call
site, the adjacent field. The table finds siblings in the INPUT DOMAIN at ONE
site — same line, different input class. #5037 spent three rounds on the second
kind while sweeping diligently for the first, and no amount of grepping the tree
can see them.

The shapes worth sweeping for, because they are what actually recurred:

- **The adjacent field.** A coalesce, a narrowing, a default, a guard — check the
  lines above and below it in the same literal or the same parameter list.
- **The mirror half.** Almost every subsystem has two of something: two verbs
  (approve/reject), two positions, two kinds, two arms of a union, a client half
  and a server half. If the fix landed on one, the other is the first place to
  look — and if a test landed on one, the other is where it is missing.
- **The other caller.** A guard added at one call site of a shared helper is
  usually missing at the rest.
- **The PROSE COPY of the same claim, including generated and public ones.** A
  finding about *what the code says to a human* — a message naming the wrong
  cause, a remedy that cannot work, an error blaming the wrong party — almost
  always has a twin outside the code: an OpenAPI `description`, a docstring, a
  migration header, a `RAISE NOTICE`, a route's response contract. Fixing the
  code and leaving the contract is fixing the instance.

  ⚠️ **Generated artifacts are the half that gets missed, because the sweep is a
  grep over source and the copy lives in a build output.** #5047 spent a round
  removing wrong-subsystem blame from a refusal — then regenerated
  `apps/docs/openapi.json` and found the same blame sitting in the 409's public
  `description`, naming one of two causes and one remedy that is unfollowable for
  the other. That description is what a caller actually reads, so the defect had
  survived in the one place it mattered most. It was caught by a drift gate
  failing for an unrelated reason, not by the sweep.

  So when a finding is about wording, grep the generated surfaces too — and if
  the fix changes a route, a schema or a migration, REGENERATE before deciding
  the class is closed.

Report the sweep in one line per finding — *"same shape at X, Y; fixed"* or
*"swept the module, no other instance"* — so a later round can see the class was
closed rather than the instance.

**This is measured, not theoretical.** #5088 took five rounds, and four of them
found the previous round's fix had a twin nobody looked at: round 1's bug four
lines away on the `computed` branch; round 2's per-side fix covering only the
both-zero case; round 3's pin covering 4 of an arm's 7 fields; round 3's `claims`
guard with two identically-broken fields directly beneath it. Every one of those
was a one-grep sweep away at the moment the fix was written.

⚠️ **A PRINCIPLE VIOLATED TWICE STOPS BEING A COMMENT AND BECOMES A CHECK.**

The second time you sweep for the same shape — in one issue, or across the arc —
the sweep has failed as a mechanism and prose is the wrong instrument. Prose has
to be re-applied by hand to every new file, and **new surface is exactly where it
keeps failing**: the principle is usually already written down, correctly, near
the violation.

Measured in #5077: `|| true` on a git call appeared **three times in one file**,
each time within a few lines of a comment saying *"widen, never narrow"*. It is
one `grep`. Likewise a tombstone byte that `--check` blesses forever — a
discriminated union makes it unrepresentable. Likewise a fixture that asserts
nothing — delete each guard, assert exactly one fixture goes red, script it.

So on the SECOND instance, do both: fix it, and add the cheapest mechanical thing
that makes a third impossible — a `grep` in a `scripts/check-*.sh`, a type that
refuses the state, a row in a `scripts/mutations/*.mutations.ts` spec, an
assertion in an adversarial fixture. Name it in the round report next to the
sweep. If you genuinely cannot mechanise it, say **why** in that line; "it is
hard to check" is a finding about the design, and usually the design is what
wants changing.

⚠️ **A LEXICAL GUARD CANNOT TELL A QUOTATION FROM AN ASSERTION, AND THE ANSWER IS REWORD-NOT-EXEMPT.**

The moment you grep for a defeated phrase, the guard fires on the docstring that quotes it to explain why it is wrong — because recording the defeated wording next to the fix is the RIGHT instinct, and it puts the forbidden string back in the file. This happened **five times** on #5029, on every guard added.

Do not add a quotation exemption. An exemption is a hole shaped exactly like the thing you are guarding, and the next real instance will be written inside one. Instead:

- **Describe the defeated claim, never quote it** — *"an earlier draft made the remedy conditional on maintenance completing"*, not the sentence itself.
- **Keep the exact defeated wording in the guard's own matcher list**, where a reader can still see what was ruled out and the scan cannot trip over it.

Two corollaries the same session paid for. **Match the concept, not the historical sentence** — the sentence-pinned matchers walked straight past every natural reword (`is running` vs `is reconciling`, `no other lock` vs `nothing else, ever`), which is the near-miss that lets a guard read green over a live instance. And **a positive control per matcher is not enough**: both sides are hand-written by the same author, so every matcher passes its own planted case by construction. Add a NEGATIVE control of legitimate prose — on #5029 it caught two over-broad matchers, one of which fired on its own refutation.

This is the repo's existing ratchet, moved one loop over. `docs/agents/audits.md`
already says it for audits — *"when an audit finds the same class of drift in two
separate runs, that's the signal to promote the check to a CI guard … Audits are
the nursery for CI gates, not a permanent home."* A review round is the same
nursery on a shorter cycle, and a finding that recurs within a single issue has
cleared that bar faster than any audit ever will.

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

⚠️ **Fresh context is the entire mechanism, and it is not a preference.** **Four times inside #5077's review alone**, a fix reproduced the defect it fixed, one layer over, with the principle written down correctly nearby and twice in the same commit — and one of those was the fix for the previous one. (The looser pattern, round N breaking round N−1's fix, has recurred since #4767/#4768 across #5022, #5027, #5031, #5032, #5033, #5068 and #5088; this step targets the sharper subset.) Step 5b cannot catch it: a sibling sweep searches the tree that **exists**, and the recurrence is in the new surface being written as the fix. You cannot catch it either, for the reason this whole command exists — the context that wrote the fix holds the argument for why the fix is right, which is what hides the repeat. Round 2 of #5077 caught exactly this, and caught it *a round too late*: the check is the same check, moved inside the round that produced the fix.

Report one line per must-fix alongside the fixes — the same place Step 6's named falsifiers go. **A round with an unresolved `REPRODUCED` is not clean**, whatever the three code reviewers said.

⚠️ **TWO CONSECUTIVE `REPRODUCED` ON THE SAME PRINCIPLE MEANS STOP PATCHING INSTANCES AND BUILD THE CHECK.** This loop had no stopping rule and needed one.

Measured on #5029: **five** consecutive passes returned `REPRODUCED`, every one the same principle one arm over — *a refusal asserting a cause its SQLSTATE cannot establish*. `too-slow` assumed a timeout where `57014` is also a cancel; `ingest` assumed the extraction fiber where the namespace had gained a second taker **in that very PR**; `table-lock` assumed maintenance where the real holder is usually a concurrent publish; then three prose copies of those causes survived in comments after the messages were fixed. Each fix was correct about the instance it was handed and blind to the sibling, because 5d shows you ONE fix at a time — which is exactly what makes it good at finding the repeat and bad at ending it.

What ended it was a lexical guard, and **the guard immediately caught two more instances the reviewer had not listed**, then a fifth during the closing sweep. So the escalation is not a judgement call: after the second REPRODUCED, the finding has stopped being about a site and started being about a class, and Step 5b's ratchet applies — fix the instance AND write the cheapest mechanical thing that makes a third impossible, in that round.

⚠️ Sequencing is the one thing 5d needs that Step 2 forbids: these run **one per message**, because each audits the fix the previous one produced.

⚠️ **`CANNOT TELL` is not a pass.** It means the principle could not be made universal or the diff was not the whole fix — either way the check measured nothing, and a round that counts it as "not REPRODUCED" has certified a fix nothing looked at. That is the byte-blessing shape #5077 exists to refuse, reproduced in the instrument built to catch it. Re-run with a repaired universal or the complete diff; if it still cannot tell, say so in the round report as an **open** item rather than resolving it silently. Likewise, a `CLEAN` that does not name the added surface it checked is indistinguishable from one that did not look — send it back.

**Step 6: Every must-fix's FIX needs a falsifier — NAMED every round, BUILT in the last one**

A fix is not closed when it is written. It is closed when something can tell you
it stopped working.

For each must-fix you resolved, name one of three:

- a test that fails without the fix,
- a row in a `scripts/mutations/*.mutations.ts` spec, or
- an explicit *"this is unfalsifiable, and here is the measurement instead"* —
  carried in the docstring, not in your head.

⚠️ **BUILD IT IN THE ROUND THAT WRITES THE FIX. Do not defer it to the closing
round.**

This rule previously said *name every round, build in the closing one*, on the
argument that building for a fix a later round may rewrite is throwaway work.
**That argument was wrong in the measurable direction and the split has been
retired.** A round only knows it was the closing round afterwards, so the deferral
is a bet on which round is last — and when the loop exits on a yield stop or a
cap, as it usually does, the bet loses and the fixes ship with nothing.

Measured on #5037: two of three fixes written in the second round shipped with no
falsifier of any kind. Five separate mutations — deleting a whole warn arm,
collapsing a discriminant to a constant, re-exporting a class the round had just
made private — were all green against the suite. The deferred cost did not
vanish; it came back as the next round's findings, which is strictly more
expensive than paying it once.

So: **every must-fix gets its falsifier built and run in the same commit as the
fix**, shown red against the defect and green with it. Apply the mutant, watch it
fail, revert. If that is expensive, that is the honest price of the fix — and it
is the arm nothing else can see.

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
- Read-only, and now **enforced by the tool grant rather than by asking**. No panel agent holds `Bash`; none holds `Edit` or `Write`. The panel reports; it never edits code. The author is the single writer to the working tree.
  - ⚠️ **This was a request, not a fact, until 2026-08-15.** Four of the five agents held `Bash` — a full write primitive (`sed -i`, `>`, `git checkout`, `scripts/mutate.ts`) handed back immediately after `Edit`/`Write` were withheld. On #5260 a panel agent mutated a file to measure a falsifier and its restore reverted the **author's uncommitted in-flight edits** along with its own mutant; `git` cannot distinguish them, since both are just unstaged changes. Only the author knows what is uncommitted, so only the author may write.
  - The pressure that caused it is legitimate and still applies: **you cannot prove a test is able to fail by reading it.** That is why the panel's evidence standard demands measurement (Step 6, and "a `0` in a mutation table is a CLAIM"). The split is now explicit — **the panel names the mutation, the author runs it.** A reviewer that wants a measurement it cannot take reports the finding as **UNVERIFIED** and names the one experiment that settles it; naming a mutation is worth more than running one anyway, because a named mutation lands in a `scripts/mutations/*.mutations.ts` spec and keeps working, while a measured-and-reverted one is gone the moment it is restored.
  - If a future reviewer genuinely needs to execute, give it a throwaway copy of the tree — never the live one.
- Scope is the changed lines **plus their enclosing declaration** (Step 2). The strict-diff reading has a blind spot for adjacent twins and it has cost real rounds.
- Fresh context per agent — never let the implementer "review" its own diff in-context; that rubber-stamps. On round 2+, fresh context **plus** the previous round's fix commits named as the audit target.
- Every fix is checked against its own finding in **fresh context, in the round that wrote it** (Step 5d). Step 5b sweeps the tree that exists; 5d is the only thing that looks at the surface the fix just added.
- Falsifiers are **named every round and built in the closing one** (Step 6). A round that names none is not clean; a CLOSING round that has not built and run them is not clean either.
- A principle swept for **twice** gets a mechanical check, not a third comment (Step 5b). Prose does not scale to new surface, which is where it keeps failing.
- On round 2+, a fix that adds **new machinery** defaults to a follow-up (Step 5a) — it would otherwise enter the diff with no round left to review it but the one it causes.
- This is the specialist layer. The repo's `/code-review` and `/simplify` remain the canonical generic passes — don't duplicate them here.
