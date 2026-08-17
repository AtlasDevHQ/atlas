# Agent practices

Rebuilt 2026-08-17 by deleting the previous 7,893-line workflow layer. This file is
short on purpose, and the reason it is short is the finding that caused the rebuild.

## Why the old layer was deleted

It did not fail by being wrong. It failed by being **satisfied nominally** — each rule
was met at the level it was written, and the defect moved up one level:

| | |
| --- | --- |
| #5027 | fixes shipped with no falsifier — 11 probed, 11 zeros. Rule added: every fix carries a falsifier. |
| #5170 | five of the author's own assertions measured inert. |
| #5289 | four falsifiers that **could not fail** — a ROLLBACK-count assertion whose fixture rolls back successfully; a mock failing both COMMIT and ROLLBACK so neither condition was independently falsifiable. |

Three rounds of prose-rule escalation, and each one was obeyed. The 2026-08-17 audit
found the same shape in the instructions themselves: `/review-panel` Step 6 had retired a
rule in its body while its own heading, cost paragraph, mutant rule and summary still
stated the retired version; `/research`'s 49-row module map had three rows pointing into
the wrong package; `.claude/agents/README.md` described a tool grant that had not existed
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

**Eight operational runbooks** in `.claude/commands/`: `release`, `publish`, `deploy`,
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

## What is deliberately not here

No workflow ritual, no per-phase catalogue, no restatement of anything CLAUDE.md or
`.claude/rules/**` already says. Both of those are enforced — CLAUDE.md by review and the
rules by the guards they name — and a second copy is a second thing to keep true. The
previous layer had three copies of several rules and they disagreed.

Evidence for every claim above is in `.claude/research/ROADMAP.md`, which is the record.
This file is the practice. When they conflict, the record wins and this file is wrong.
