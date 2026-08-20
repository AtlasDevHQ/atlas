# Agent practices

Rebuilt 2026-08-17 by deleting ~6,250 lines of workflow layer — 7,893 removed, then 1,639
restored as the runbooks listed under "What survived", below. This file is short
on purpose, and the reason it is short is the finding that caused the rebuild.

## Why the old layer was deleted

It did not fail by being wrong. It failed by being **satisfied nominally** — each rule
was met at the level it was written, and the defect moved up one level:

| | |
| --- | --- |
| #5027 | fixes shipped with no falsifier — 11 probed, 11 zeros. Rule added: every fix carries a falsifier. |
| #5170 | five of the author's own assertions measured inert. |
| #5289 | four falsifiers that **could not fail** — a ROLLBACK-count assertion whose fixture rolls back successfully; a mock failing both COMMIT and ROLLBACK so neither condition was independently falsifiable. |

Three rounds of prose-rule escalation, and each one was obeyed. The 2026-08-17 audit
found the same shape in the instructions themselves: /review-panel Step 6 had retired a
rule in its body while its own heading, cost paragraph, mutant rule and summary still
stated the retired version; /research's 49-row module map had three rows pointing into
the wrong package; the agents README (deleted in the same pass) described a tool grant that had not existed
for two days.

**Prose cannot hold a rule that an author is motivated to satisfy cheaply.** Adding more
prose was the move that had already failed three times.

## The bar

A practice earns a place here only if it is one of these. Nothing else is a rule.

1. **A gate** — a `scripts/check-*.sh`, a CI job, a type error. It fails without anyone
   remembering it.
2. **A measurement that can fail** — a mutation row, a test observed red against the
   defect and green with the fix. Not "there is a test"; *this mutant turns it red*.
3. **Otherwise it is a note**, and notes live in `.claude/research/ROADMAP.md` with the
   incident that produced them. Notes inform judgement. They do not gate work.

Corollary, and the one that does the work: **if you cannot say what would go red, you have
not closed anything — you have moved it to where it costs more.**

## The one structural rule

**The actor that builds a check may not be its only judge.**

Every failure in the table above shares this shape: the author wrote the fix, wrote the
measurement that certifies the fix, and judged that measurement — with the context that
produced the fix still in hand, which is exactly the context that hides the recurrence.

Applied:

- A fix is checked against its own finding in **fresh context**, by something that was not
  given the reasoning for why the fix is right.
- A falsifier is checked the same way. "It has a falsifier" and "the falsifier can fail"
  are two claims; establishing the first has never established the second.
- Whoever cannot run a measurement **names the exact mutation** instead of softening the
  claim. A named mutation is worth more than a taken one anyway: it lands in a spec and
  keeps working, while a measured-and-reverted one is gone the moment it is restored.

## What survived the deletion, and on what grounds

**The eight that survived**, in `.claude/commands/`: `release`, `publish`, `deploy`,
`ci`, `verify-mcp-cli`, `verify-prod-signup`, `dev`, `deps-update`. They are step
sequences against external systems — npm tags in groups of ≤3, the prod fast-forward, the
staging soak — where the cost of re-deriving is real and the failure mode is a broken
deploy, not a missed review finding. **No finding in the audit implicated them**, and two
are cited by live code: `scripts/ci-local.sh` and `scripts/lib/ci-local-report.sh` defer to
`ci.md` for the launch-and-watch protocol, and ADR-0008 names `release.md` as the canonical
tagging path.

The 26 that were deleted are the ones the diagnosis was actually about: the review and
workflow loop, where a rule's only enforcement was an author's willingness to follow it.

That is the line, and it is worth stating as a general test: **delete the practice whose
enforcement was your own diligence; keep the sequence whose enforcement is an external
system that will fail loudly.**

## What was restored on 2026-08-19

`/reset`, `/sitrep` and `/tidy` came back. `.claude/commands/` now holds **eleven
operational runbooks**.

They were re-derived, not restored. Two of the three failed the test above as written.

| | Verdict | What changed |
|---|---|---|
| `/reset` | Passed | It is git and bun, and a wrong step fails at once. It now refuses on uncommitted or unpushed work instead of carrying it onto `main`, and reports the end state it verified. |
| `/sitrep` | Passed on inputs, failed on output | Every field is read from `gh`, `git` or `npm`. But it closed with strategy rendered in the same tables as the readings, and hard-coded four packages while five publish. It now derives every list and marks what it could not read UNKNOWN. |
| `/tidy` | Failed | It closed issues on its own judgement, wrote the ROADMAP entry for work it had just done, and approved its own edits. That is the structural rule above, broken inside one command. |

`/tidy` is restored in two lanes. **APPLY** acts only where a printable fact decides the
action. **PROPOSE** prints the proposal with its evidence and stops. The test is *does a
fact decide it*, not *is it risky*.

Two limits, stated because this page's own failure mode is claiming more than it holds:

- **The lanes are a note, not a gate.** Nothing stops a session from applying a PROPOSE
  item. The bar predicts that, and it is still the honest place to put the split.
- **One dead rule was dropped rather than carried across.** The old `/tidy` capped ROADMAP
  bullets at *"≤ 2 sentences / ~240 chars"*. `ROADMAP.md` abandoned that long ago, so the
  command and the file disagreed for months. A rule the artifact contradicts is worse than
  no rule. *"Match the entries around it"* replaces it.

## What is deliberately not here

No workflow ritual, no per-phase catalogue, no restatement of anything CLAUDE.md or
`.claude/rules/**` already says. Both of those are enforced — CLAUDE.md by review and the
rules by the guards they name — and a second copy is a second thing to keep true. The
previous layer had three copies of several rules and they disagreed.

Evidence for every claim above is in `.claude/research/ROADMAP.md`, which is the record.
This file is the practice. When they conflict, the record wins and this file is wrong.

## What enforces this file

One gate, as of 2026-08-17: **`scripts/check-agent-doc-paths.sh`**, in the CI `drift` job
and stage 1 of `scripts/ci-local.sh`. It fails when any tracked file names a repo path, a
slash-command or a registered count that does not exist. That closes the class every false
claim in the audit belonged to — three stale paths and six references to deleted commands,
all nine found by hand.

What it does **not** cover is worth stating, because a gate presenting as broader than it is
would be this page's own failure mode:

- **Only registered count phrases are checked.** Five today (`operational runbooks`,
  `bounded contexts`, `system-wide decisions`, `chat-platform adapters`, `ci-local gates`).
  The audit's *"14 chat components"* against 42 on disk would still ship — that phrase is not
  registered, and nothing derives it.
- **A registered phrase was not enough on its own, either.** Until 2026-08-20 the counts
  check was a `git grep` for `<number> <phrase>` on a raw line, and two live claims in these
  very files slipped through it: one where `**` sat between the number and the phrase, and
  one where the number ended a line and the phrase opened the next. Both were found by hand,
  both while the gate reported clean — the same failure mode this page exists to describe,
  inside the gate this page points at. It now strips emphasis and joins each line to its
  predecessor before matching, and `scripts/__tests__/check-agent-doc-paths.test.sh` carries
  a mutant for each. **A historical count is worded, not allowlisted:** `count` exemptions
  match by file, so exempting a true-when-written number would also retire the live claim
  beside it. Write "eight runbooks that were purely operational" and leave the registered
  phrase to the statement about today.
- **It reads paths and names, not claims.** A doc can still say a subsystem works a way it
  does not; every path in the sentence resolves.
- **Everything else on this page is still a note.** The bar above is not itself enforced by
  anything: no gate can tell a falsifier that can fail from one that cannot, which is the
  finding the whole rebuild came from.

The gate's own adversarial suite is `scripts/__tests__/check-agent-doc-paths.test.sh`, and
its header records the five mutations that were applied and observed red — including
truncating a finding at column 140, which is precisely how the hand check missed six live
references while matching them.
