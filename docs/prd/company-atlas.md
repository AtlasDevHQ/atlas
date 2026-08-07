# The Company Atlas — what "finished" looks like

**Status:** Draft, 2026-08-07. **Not ratified.** Written deliberately in the *proposed* Atlas vocabulary — see [A note on the name](#a-note-on-the-name).
**Owner:** maintainer
**Scope:** the destination of the arc [ADR-0036](../adr/0036-atlas-as-company-brain.md) opened. This is not a milestone plan and not a status page.

Read alongside:

- [ADR-0036](../adr/0036-atlas-as-company-brain.md) — the bet, the wedge, the trust tiers, the milestone cut
- [ADR-0037](../adr/0037-claim-identity-in-the-brain.md) — claim identity
- [`.claude/research/ROADMAP.md`](../../.claude/research/ROADMAP.md) — the live tracker. Where this document and the ROADMAP disagree about status, **the ROADMAP is right**

---

## Why this exists

The arc is defined entirely **by mechanism** — temporal depth, source breadth, retrieval depth, write-back, governance. Every milestone is legible, ordered, and justified, and ADR-0036's "the ordering is the strategy" is a real argument.

But nowhere does anything say **what it looks like to a person when it is finished.** That has one specific consequence: *"are we on target?"* is unanswerable, because a milestone can only be measured against the milestone before it. Scope insertions (like claim identity taking the M4 slot) can be argued on their merits but never against a destination. Dormant machinery can accumulate without anything registering it as debt.

This document is the destination. It is written so that a person who has never read the code can hold Atlas to it.

**The discipline:** no mechanisms. If a sentence names a table, a tool, a column, a milestone, or a vendor, it does not belong in this document. The one exception is the dated snapshot at the end, which is explicitly a snapshot.

---

## A note on the name

ADR-0036 committed to the category *"the data-grounded company brain."* That was the right **category** language — it is how the field talks, and it is how a buyer finds you.

It is the wrong **product** language, for one reason: *brain* is a breadth word. It promises total recall and one mind. ADR-0036's primary named risk is the **"worse Glean" trap** — competing on breadth Atlas will lose — and its defusing guardrail is *"claim extraction trust, concede breadth."* The word fights the strategy.

*Atlas* is a bounded-coverage word. An atlas is surveyed, dated, attributed, indexed — and it marks where the map ends. **Terra incognita is a feature of an atlas, not an embarrassment.** It is also, already, the name of the company.

This document is written in that vocabulary **as a test of whether the vocabulary holds.** If the destination is easier to state as an atlas than as a brain, that is evidence. If it strains anywhere, that is evidence too, and worth recording rather than smoothing over.

The rename is **not decided here.** It changes ADR-0036 §T2's category claim, which is growth rather than refinement, so under [ADR-0032](../adr/0032-amendments-refine-never-grow.md) it needs its own ADR. This document is input to that decision, not the decision.

---

## The claim

> **Atlas is the surveyed record of what your company knows — where every fact carries its source, its date, and the name of the person who stood behind it, and where the parts nobody has surveyed are visible as unsurveyed rather than quietly absent.**

Everything below is that sentence, made checkable.

---

## What a person can do

Eight capabilities. Each is stated as something a named kind of person does, not as something the system has.

1. **Ask a question in chat and get an answer built from what the company knows** — not only from what is in the database. The answer is assembled from the company's own record, and it reads as one answer rather than as search results.

2. **See where every part of an answer came from.** Not a citation to a document — a citation to a *claim*, with the source it came from, when it was observed, and who approved it.

3. **Tell Atlas it is wrong, in words, and have the correction stick.** Correcting the record is a first-class act available to a person, not an engineering task. A correction lands immediately and is itself part of the record.

4. **Approve or reject what Atlas wants to learn, before it counts.** Nothing becomes part of the authoritative record without a person choosing to make it so. Reviewing is a bounded, comprehensible task — not an inbox that grows faster than anyone can read it.

5. **Ask what was true on a past date** and get the answer as it stood then, alongside what changed, when, and who changed it.

6. **See what the company disagrees with itself about.** Contradictions are surfaced as contradictions, with both claims and both sources, and Atlas does not pick a winner.

7. **Look at one page and understand the shape and the limits of what is known** — which parts of the company are well surveyed, which are thin, which are stale, and which have never been surveyed at all. This page is honest when coverage is poor, and it is *most* useful then.

8. **Let other tools consult it.** Another agent — a coding assistant, a chat client, something not built by Atlas — can query the same record and receives the same labels and the same limits. It cannot get a cleaner-looking answer than a person would.

---

## What a person can trust — and how they know

Three kinds of thing live in the Atlas, and **every answer says which kind it is drawing on.** ADR-0036 makes this a permanent product invariant: if the labels are ever invisible, the wedge is invisible and the worse-Glean trap re-opens.

Proposed user-facing names for the three tiers, which today have only internal ones:

| | What it means | Why you can trust it |
|---|---|---|
| **Surveyed** | Drawn directly from the company's own data | True by construction — the answer re-reads the live rows. Nobody interpreted anything, so nothing can have been interpreted wrong, and it cannot go stale between readings |
| **Attested** | Extracted from something someone wrote, then approved | A named person in your company read this claim and stood behind it. That person is on the record |
| **On the record** | The raw source material itself | It is not a claim about what is true — it is what was actually said, unedited. Trustworthy as testimony, not as fact |

**Surveyed outranks Attested wherever they overlap.** A person's recollection never overwrites the company's data.

The naming is a proposal, not a decision. What is *not* a proposal is that the three tiers are permanently distinguishable to whoever is reading.

---

## What the Atlas will not do

These are the concessions, written as commitments. They exist to be *used*: when a future proposal arrives, the first question is whether it violates one of these eight. If it does, it needs an ADR that supersedes this section — not a milestone.

1. **It will not guess.** Where the record is thin or absent, it says so. An unsurveyed region is shown as unsurveyed and never filled with a plausible answer.

2. **It will not decide who is right.** Genuine contradictions are surfaced with both claims and both sources. Recency does not win. Seniority does not win. A person resolves it or it stays open.

3. **It will not learn behind your back.** Nothing enters the authoritative record without a person approving it. There is no setting that turns this off.

4. **It will not read over your shoulder.** Atlas does not silently inject itself into other tools' prompts. Consulting the Atlas is always an explicit act, and always visible to the person it is being done for. This costs adoption, on purpose.

5. **It will not try to index everything.** Breadth is conceded. A smaller set of facts you can actually trust is the product. Losing a breadth comparison to an enterprise search vendor is an expected outcome, not a defect.

6. **It will not put the working parts behind a license.** The complete Atlas — connect, extract, review, store, retrieve, correct — runs on infrastructure you control, for free, forever. Only convenience, governance, and scale are ever commercial.

7. **It will not show a person something they are not entitled to see** — and when entitlement is unclear, it shows nothing rather than guessing. Over-restriction is the acceptable failure; disclosure is not.

8. **It will not do your job.** Atlas is the record that work stands on, not the worker. See [Outside the line](#outside-the-line).

---

## How you know it's finished

Not "M6 closed." Eight conditions, each written so a person could sit down and check it. The arc is finished when all eight hold **for a real customer, in production, without an engineer present.**

1. **The cold start works.** A new customer connects one source on Monday. By Friday, with no engineer involved, someone in that company asks a question in chat and gets an answer built from a claim that a colleague of theirs approved — and can see who.

2. **Every authoritative claim has a human name on it.** Pick any claim in the record at random. You can point at the person who made it authoritative, and the source it came from, and the date. There are no exceptions, including for claims that arrived by import, correction, or migration.

3. **The tiers are unmistakable to a non-expert.** Show someone who has never used Atlas an answer drawing on data and an answer drawing on an approved Slack message. They can tell the difference without being taught the vocabulary.

4. **Disagreement survives.** Two people in the company contradict each other in writing. Atlas surfaces both, attributed, and has picked neither — a week later it has still picked neither, and nobody had to intervene to keep it that way.

5. **The past is legible.** Someone asks a question whose answer changed three months ago. They get today's answer, can see the previous answer, and can see who changed it and when.

6. **The limits are visible and honest.** An admin looks at one page and states what Atlas knows, how much of the company it covers, and what it does not know — and every part of that statement is correct. This holds when coverage is 4% as clearly as when it is 80%.

7. **Revocation is real.** Someone loses access to a source. Within one sync cycle, claims scoped to that source stop being visible to them — with no manual step, and without an admin having maintained a list.

8. **The self-hoster has all of it.** Every one of conditions 1–7 holds on a self-hosted install with no license key and no account with Atlas.

**Two conditions deliberately absent.** There is no retrieval-quality benchmark and no fact-count target. ADR-0036's T1 finding is that the adoption gap is trust, not benchmark score — leaderboard position is not a finish line, and a large record is not a good one.

---

## Outside the line

Named here so nobody graduates them into work from *this* document. ADR-0036 defers each of these already; this section exists so the destination cannot be quietly widened into them.

- **The AI-employee / work layer** — named role-agents, scheduled briefings, autonomous action-taking. This is the upside that *justifies* the Atlas and it is a separate thesis with its own argument to make. The Atlas is finished without it.
- **Anything that acts on the record rather than reporting it.** Atlas answers and records. It does not decide, notify, escalate, or execute.
- **Being the system of record.** Atlas is a *survey* of systems of record. It never becomes the place a fact primarily lives.

The test for a borderline proposal: **does it help a person know something, or does it help a person do something?** Knowing is inside the line. Doing is the next thesis.

---

## What this document does not decide

- **The name.** Needs its own ADR (see above).
- **The tier names.** *Surveyed / Attested / On the record* is a proposal.
- **The milestone order or count.** ADR-0036 §T10 owns the cut. This document should make re-cutting *easier* — a milestone that advances none of the eight finish conditions is a milestone worth questioning.
- **Anything about how the home page looks.** Condition 6 says what it must be *true* of. The design is a separate brief.

---

## Snapshot — 2026-08-07

Explicitly dated and explicitly perishable. **The ROADMAP is authoritative for status**; this is here once, to make the gap visible at the moment the destination was written.

| # | Condition | Status |
|---|---|---|
| 1 | Cold start works | **Not yet** — proven by hand in a soak, never by a customer unaided |
| 2 | Human name on every claim | **Close** — the gate and provenance hold; import and correction paths are the open edges |
| 3 | Tiers unmistakable | **Partly** — labels are carried everywhere; never tested on someone untrained |
| 4 | Disagreement survives | **Yes**, for claims that are recognized as contradicting. Recognition itself is the arc's open bug |
| 5 | Past is legible | **Yes** at the record level; not yet on any surface a non-admin sees |
| 6 | Limits visible and honest | **No.** No such page exists. This is the largest single gap in the list |
| 7 | Revocation is real | **Yes** — built, and the least-demonstrated of the eight |
| 8 | Self-hoster has all of it | **By construction so far** — no capability has been gated; untested end-to-end |

**What the snapshot says about sequencing.** Condition 6 is unbuilt and is the one a person meets first. Conditions 1 and 3 are unproven rather than unbuilt, and both are cheap to test. Condition 4's recognition gap is the arc's originating bug and closes on human authoring, not on more machinery.
