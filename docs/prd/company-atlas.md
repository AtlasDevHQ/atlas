# The Company Atlas — what "finished" looks like

**Status:** Draft, 2026-08-07. **Not ratified.** Written deliberately in the *proposed* Atlas vocabulary — see [A note on the name](#a-note-on-the-name).
**Owner:** maintainer
**Scope:** the destination of the arc [ADR-0036](../adr/0036-atlas-as-company-brain.md) opened. This is not a milestone plan and not a status page.

Read alongside:

- [ADR-0036](../adr/0036-atlas-as-company-brain.md) — the bet, the wedge, the trust tiers, the milestone cut
- [ADR-0037](../adr/0037-claim-identity-in-the-brain.md) — claim identity
- [`.claude/research/ROADMAP.md`](../../.claude/research/ROADMAP.md) — the live tracker. Where this document and the ROADMAP disagree about status, **the ROADMAP is right**
- **[Project: The Company Atlas — Finish Conditions](https://github.com/orgs/AtlasDevHQ/projects/3)** — the board keyed by *condition*, added 2026-08-24. This document holds the destination and declines to track; the ROADMAP tracks but is keyed by *date*. Between the two, nothing was keyed by condition, and work fell through the gap — conditions 1 and 3 were *held* by the Coverage Surface milestone rather than closed by it, and were unmilestoned four days after it closed. **If you are asking "where does condition N stand", the board is the answer, not the snapshot below.**

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

7. **Look at one page and understand the shape and the limits of what is known** — which parts of the company are well surveyed, which are thin, which are stale, and which have never been surveyed at all. This page is honest when coverage is poor, and it is *most* useful then. *(Stale is a measured lag behind the source, never a guess; thin is the reader's judgment from honest counts, not a computed verdict — [ADR-0041](../adr/0041-the-coverage-surface-counts-what-it-can-see.md).)*

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

   **What this condition does NOT claim, as of [#5438](https://github.com/AtlasDevHQ/atlas/issues/5438) (2026-08-25).** *Surviving* a disagreement was never the hard part; **recognizing** one is. A contradiction Atlas does not recognize is not surfaced, not attributed, and not picked — it reads exactly like agreement. The named limits, so that the next person meets them here rather than rediscovering them in prod:

   - **Recognition is not semantic, and will not become so.** Two claims meet through a deterministic, offline identity key over the retained surface ([ADR-0037 §1](../adr/0037-claim-identity-in-the-brain.md)). No stemming, no edit distance, no embeddings, no LLM judge — a prohibition rather than a gap, because the live corpus carries `led_by` and `leads`, which are *inverse* relations and the top-ranked pair any similarity detector returns. Merging them would stamp `valid_to` across the manager graph. Under-recognizing costs a missed flag; over-recognizing destroys a belief nobody retired.
   - **A pair whose PREDICATES share nothing is recognized only through a subject anchor.** #5438 widened the tension scan so that two claims about the same subject anchor, from different episodes, are flagged as rivals with no predicate test at all. That is what reaches the measured prod pair (`Series B` / `target raise` / `$25M` against `Series B fundraise` / `has goal of` / `$30M`). It reaches nothing whose subjects share no whole-token prefix: `Series B` against `the round`, or against `our raise`, is still silence.
   - **The widening buys recall at the cost of precision, deliberately — and the cost is now an observed number rather than a prediction.** Two true claims that share a subject anchor — what a tier costs and what it costs to *renew* — now earn an advisory edge a reviewer dismisses. That trade is admissible only because an `in-tension-with` edge is advisory: nothing is merged, nothing is superseded, nothing is ranked. It is licensed at this consumer and at no other, and both halves are pinned in `identity-consumers-pg.test.ts`.
     - **Measured in us prod, 2026-08-25 ([#5450](https://github.com/AtlasDevHQ/atlas/issues/5450)):** the post-anchor-arm candidate scan, run read-only with the cardinality gate lifted over all 34 facts, returned **three candidate pairs, every one of them anchor-only, one of the three a true contradiction.** The two false pairs are precisely the shape `segmentation.ts` names in its own header — a price beside a discount flag, a raise target beside a valuation. Re-measured 2026-08-26 at 35 facts (29 live): two pairs, both already carrying an edge, nothing fresh to mint — but *edged* is not *dismissed*. One of those two edges is `e78de65d`, the spurious raise-target-beside-valuation pair, which was **minted** in the interim by the correction lane rather than reviewed away; the correction-lane bullet below ([#5467](https://github.com/AtlasDevHQ/atlas/issues/5467)) is where that is accounted for.
     - ⚠️ **One-of-three is not a precision rate and does not generalize.** It is 34 facts in ONE workspace with two producers. It is evidence of exactly one thing — that the cost named above is real and lands where it was predicted to land — and of nothing at all about a corpus of another size or shape. Anyone quoting it as a hit rate is quoting a sample of three.
   - **Objects that cannot be parsed abstain, and chat is full of them.** `$25M` yields no comparable value — currency symbols are ambiguous across currencies and are refused outright. So the pair above is flagged and **never** adjudicated: it sits in the abstain band until a human settles it. For condition 4 that is the correct behaviour and it is worth being explicit that it is not a fallback.
   - **⚠️ Recognition is gated on a MODEL GUESS, and this is the largest remaining blocker.** The whole rival scan only runs for a claim the extractor labelled `single` cardinality — one object at a time — and that label is the extractor's per-claim guess against a prompt that says *"when unsure answer 'multi'"* ([ADR-0037 §3](../adr/0037-claim-identity-in-the-brain.md)). Answer `multi` for `has goal of` and the measured pair above is silent again, with nothing in the identity layer able to help. The retroactive lane (the admin tension sweep) is stricter still: it reads the workspace's *approved, human-curated* cardinality entry, so an uncurated predicate is never swept. So the honest reading of #5438 is **the pair is recognized once something says the predicate is `single`** — a model at ingest, or a human at the sweep. The gate is deliberate and load-bearing (#5027 removed cardinality from the destructive path precisely because a stochastic input must not decide what gets retired), so this is a named limit rather than a bug to fix here.
     - ⚠️ **The CORRECTION lane is the third answer to "something", and since [#5467](https://github.com/AtlasDevHQ/atlas/issues/5467) it says less than it used to.** A correction hard-codes `single` off the human's *verb* rather than off a model. That was decided when a correction's tension scan could reach only the slot the human corrected; the anchor arm then spent the same assertion on every live claim under the subject's prefix, and one spurious prod edge exists because of it (`e78de65d`, a raise target flagged against a post-money valuation, on a predicate with no cardinality entry at all). **The verb still licenses the exact slot — that assertion is made directly by the act of replacing one value with another — but it no longer licenses the ANCHOR arm, which now needs the same approved entry the sweep needs.** So a correction on an already-approved predicate still flags the subject's fan; the raise-target-beside-valuation *shape* is bounded by curation, not eliminated. Not a weakening of the anchor arm in general — the extract lane's model guess still arms it, which is the bullet above, unchanged.
   - **The extractor's segmentation is not stable, and no instruction makes it so.** The same extractor keyed `has target raise of` on 2026-08-03 and `target raise` for the same concept on 2026-08-25. The prompt now tells it to keep relation words out of the subject, which lowers the rate; it is a model instruction, so it holds statistically and cannot be relied on. Everything that must be *true* lives in the identity layer and in SQL, where it can be falsified.

   **One cost this change adds rather than removes**, recorded here because it lands on a person: the widened reach applies to the admin tension sweep too, which re-reads the whole corpus. A sweep therefore mints anchor-only advisory edges retroactively rather than gradually — a spike in the review queue, and nothing in the sweep itself caps how many arrive in one run.

   ⚠️ **What bounds that spike is APPROVED-PREDICATE COVERAGE, not history ([#5450](https://github.com/AtlasDevHQ/atlas/issues/5450)).** The paragraph above is easy to read as a history problem; it is a curation problem. `TENSION_SWEEP_SQL` gates every candidate on a `brain_predicate_cardinality` entry that is `single` **and** `status = 'approved'`, so a sweep's reach is the set of predicates a human has approved — never the corpus. ⚠️ And specifically the predicates on the **newer** side of a pair: the gate is `cardinalitySingleSql("a")` and `a` is the newer claim (`tension-sweep.ts:387`), so approving the predicate that happens to sit on the *older* side of a pair sweeps nothing, and reports nothing about why. Prod's first sweep minted exactly one edge for that reason and not because history was short: four entries, all `pending`, beside the one approved (`has goal of`, 2026-08-25). The queue grows as curation does, and the spike lands on whoever approves a common predicate. The four pending, warehouse-proposed entries are **`plan tier`, `name`, `region` and `is active`**.

   **Asked before approving any of them, and the answer was zero for all four** — read-only against us prod on 2026-08-26 through `POST /api/v1/admin/brain-facts/tension-forecast` ([#5463](https://github.com/AtlasDevHQ/atlas/pull/5463)), which runs the sweep's own statement with the INSERT replaced by a count and the counterfactual predicate carried as a bind. The reason is structural rather than incidental: the warehouse producer writes **one episode per run** and **one row per `(subject, predicate)` slot**, so the anchor arm's different-episode requirement and the exact-slot arm both come up empty on every warehouse subject. Approving a predicate a *chat* producer also writes is where the spike would actually arrive — and the endpoint exists so that this is a question asked rather than a paste into `psql`.

   The honest statement of where this condition stands: **disagreement survives once recognized, and recognition is partial by construction.** The unrecognized remainder closes on human authoring — a vocabulary entry with a reviewer behind it ([ADR-0037 §6](../adr/0037-claim-identity-in-the-brain.md)) — not on more machinery.

5. **The past is legible.** Someone asks a question whose answer changed three months ago. They get today's answer, can see the previous answer, and can see who changed it and when.

6. **The limits are visible and honest.** An admin looks at one page and states what Atlas knows, how much of the company it covers, and what it does not know — and every part of that statement is correct. This holds when coverage is 4% as clearly as when it is 80%. *"How much" is a composed statement over what Atlas's credentials can see — never a single company-wide percentage, because no company-wide denominator exists to be correct about ([ADR-0041](../adr/0041-the-coverage-surface-counts-what-it-can-see.md)).*

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

> ⚠️ **SUPERSEDED as a status report, kept as a record of the starting position.** Live status is the [Finish Conditions board](https://github.com/orgs/AtlasDevHQ/projects/3). At least four rows below are now false — conditions 2, 4, 5 and 6, each corrected in a dated note here rather than in the table.
>
> **Condition 6 shipped on 2026-08-20** — [ADR-0041](../adr/0041-the-coverage-surface-counts-what-it-can-see.md) plus [#5212](https://github.com/AtlasDevHQ/atlas/issues/5212)→[#5216](https://github.com/AtlasDevHQ/atlas/issues/5216), closing on a verified prod read rather than a merge — so *"No such page exists"* has not been true since. What has **not** changed is condition 3: the coverage surface is correct but not yet unmistakable, and its visual design (the Coverage Plate, [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422)) is unbuilt.
>
> **Condition 2's row named the wrong open edges — and the condition is still NOT MET** ([#5424](https://github.com/AtlasDevHQ/atlas/issues/5424)). *"Close"* was right about the gate — a census of every claim in us prod found 34 of 34 carrying a person, a source and a date, with none missing any field. It was wrong about both edges it named. **Correction** attributes better than any other path in the product, twice over (the correction episode's `source_actor` and an attributed `admin_action_log` row). **Import** holds on the connector and warehouse lanes. The two real edges were ones the row did not mention: **migration**, where the region import restored a bundle's `published` status onto a claim whose provenance named nobody; and **publish**, which is not an arrival path at all — it is the verb that confers the authority the condition is about, and it recorded a count rather than which facts it promoted, so the publisher of a given claim was recoverable only by joining `updated_at`, which any later write destroys. Both are fixed. **What is not fixed is the word *person*.** `provenance.actor` holds an opaque vendor handle (`slack:U0AQW6KF2EM`) and the record contains no mapping from it to a human being — the audience resolver never persists the vendor roster, by design. #5424 recorded that as a question for this document: does a stable, resolvable handle satisfy *"a human name"*? **Answered 2026-08-25: no. A human-readable name is required.** So the condition's own test — *point at the person* — still fails for every claim whose author has no Atlas account, which in any real workspace is most of them. [#5440](https://github.com/AtlasDevHQ/atlas/issues/5440) is that work, and condition 2 stays open until it lands. The demonstration and its named exceptions are on #5424. ⚠️ *The clause above — "the audience resolver never persists the vendor roster, by design" — describes the posture as it stood on 2026-08-25 and is **superseded as a forward statement** by ADR-0036's `Amendment (2026-08-25, #5440)`, which decides that a bounded directory snapshot IS persisted for principals who authored an ingested episode. It remains an accurate account of why this condition failed; it is no longer a description of the design.*
>
> **Condition 5's row said *"Yes at the record level"* — measured 2026-08-25, it is not** ([#5426](https://github.com/AtlasDevHQ/atlas/issues/5426)). The bi-temporal machinery is real; prod has never run the verb that uses it. `valid_to` is set on **0 of 34** facts, there are **zero** `supersedes` edges, and the only correction verb ever run is `retract` (4 times). Exactly one claim in the record has ever changed — `Series A` / `has target raise of`, `6M` → `8M` — and the `6M` was retired with `retract`, which stamps `invalidated_at`; every fact-serving read, `asOf` included, filters `invalidated_at IS NULL` deliberately ([#4916](https://github.com/AtlasDevHQ/atlas/issues/4916)), because retract is the route a GDPR erasure takes. **So the previous answer is not merely unsurfaced — it is unreadable through the temporal API.** And *"who changed it"* is answerable only from `admin_action_log`, never from the claim: `provenance.actor` names the claim's original author, not the person who retired it. Condition 2 found that *"who made this"* needs a human name; condition 5 finds that *"who changed this"* is not on the claim at all. The surface work #5426 contemplates is premature by that issue's own first criterion.
>
> **Follow-on 2026-08-26** — #5426 was re-scoped from *demonstrate the condition* to *unblock it*, and the blocker turned out to be smaller than the measurement implied. `facts/?status=published` already listed exactly the right population; what was missing was the ACTION on the row — `POST /brain-facts/:id/correct` had shipped with no web caller, so the only button in front of a human stamped the tombstone. A reviewer now says what happened to a published claim in their own words (*"it shouldn't be here"* vs *"it was true — it changed"*) and the verb is derived; the copy names neither verb, which is the condition's own *"without needing to know either word"*. ⚠️ **This makes `supersede` reachable, not chosen.** The condition still turns on prod carrying a `supersedes` edge arrived at through that surface — if the 4-retracts/0-supersedes split was habit rather than affordance, this will not move condition 5, and the next measurement will say so.
>
> **Follow-on 2026-08-26, second** — the record half now holds and the surface exists. A human corrected a published claim through that dialog on `us` prod at 16:25:09Z: `supersedes` edges **0 → 1**, `valid_to` **0 → 1**, and `8M` carries `valid_to` with no `invalidated_at`, so an `asOf` read returns it — the clause that failed on 2026-08-25 now passes. The non-admin half followed the same day ([#5461](https://github.com/AtlasDevHQ/atlas/issues/5461)): `history` rides the `searchBrain` result, so a reader asking an ordinary question is told in the answer that it changed, what it said before, and who changed it, with no `/admin` visit and no history tab — which this condition's issue forbade. ⚠️ **Still not "condition 5 holds":** that wants a real person, in prod, meeting their own changed answer, and the record holds exactly one changed claim. The remaining gap is the *superseded* row's silence about who retired it — `8M` names its original author and nothing on the claim records the retirement — which is condition-2 shaped and one table over. **The clause that is genuinely closed is *"can see the previous answer"*.**
>
> **Condition 6 was re-verified 2026-08-25 and still holds** ([#5427](https://github.com/AtlasDevHQ/atlas/issues/5427)) — at **0%, 1.4% and 29%** coverage across two prod workspaces in a single read, which is the low-coverage regime the condition is written for rather than a comfortable one. A class with no cycle on record renders as never-enumerated with no date; a measured-empty roster reads differently from never having looked; and a real `0 of 191` **is** printed, because its denominator is real and dated — what the page refuses is a *fabricated* denominator, not a zero. **Completed 2026-08-26**: the rendered page was then read in a browser across **both** prod workspaces — `4 of 281` (**1.4%**, below the condition's own 4% benchmark) and a real **`0 of 191`** printed with its dated denominator, alongside never-enumerated classes carrying no date and `People` as a non-surveyable class. The refusal of a single number is in the page's own copy, not only in the code. **Condition 6 holds in full.** The one blemish found — the summary block doubling each class's unit noun — is legibility, not correctness, and is filed on [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422) as condition 3's.
>
> The table is left as written rather than edited in place. It dates the moment the destination was set, and a status table that is quietly refreshed cannot show how far the arc moved — which was the point of writing it down.

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

> ⚠️ **That last sentence was measured and is now half wrong ([#5438](https://github.com/AtlasDevHQ/atlas/issues/5438), 2026-08-25).** Part of the gap closed on machinery after all — a subject-anchor arm on the tension scan, no human involved — because the pair that reproduced it in prod is one **no vocabulary entry can reach**: the extractor segmented the two sentences differently, so an alias at the predicate leaves the subjects apart, and an alias spanning both positions is what §6 forbids. What remains true is the *remainder*: pairs sharing no subject anchor still close on human authoring. The condition-4 entry above carries the limits as a list rather than as this one sentence.
