# Warehouse material is an observation, never a published belief

Status: accepted (2026-08-19, grill on whether tier-1 material belongs in the fact store at all — upstream of [#5326](https://github.com/AtlasDevHQ/atlas/issues/5326), which shipped in v0.2.12 and is untouched by this)

- **Amends:** [ADR-0036 §T9](./0036-atlas-as-company-brain.md) — the clause naming warehouse-derived facts as gated by the core review gate.
- **Amends:** [ADR-0039](./0039-the-warehouse-producer-emits-only-what-a-human-enrolled.md) — enrollment survives whole, on a different argument. Its review-queue arithmetic no longer holds it up.
- **Amends:** [ADR-0040](./0040-the-class-major-ingest-contract.md) — the warehouse class's authority arm is enrollment, full stop.
- **Untouched:** [ADR-0037](./0037-claim-identity-in-the-brain.md) in its entirety — §4's emission contract, §5's live-read prohibition, and the whole of M4's collision arbitration all survive verbatim.

The warehouse producer mints claims like `<org-id> / plan_tier / business` and routes them through belief machinery: draft status, a human review gate, publication, decay, corroboration, correction. **It should not.** A warehouse value is true iff the row says so, right now, and `executeSQL` answers it live and fresher. We decided: **the producer's output is an *observation* — stored, compared against, never reviewed, never served, never corrected.** It stays in `brain_facts`; it never reaches `published`.

## The split is derivability and volatility, not source

The useful line is not *warehouse vs chat*. It is:

| | Where it belongs |
|---|---|
| **Derivable + volatile** — `plan_tier`, `is_active`, `region`, counts | queried live (`executeSQL`), never stored as belief |
| **Non-derivable + durable** — decisions, rationale, ownership, policy | the fact store, which is what `SEARCH_BRAIN_TOOL_DESCRIPTION` already tells the model it is for |
| **Identity / join material** — *this row is called Atlas* | the entity store ([#5043](https://github.com/AtlasDevHQ/atlas/issues/5043)), which already exists and is fed by this same producer |

And the first row is not an observation about the queue — it is a **property of the emitter**. `buildSnapshotSql` returns `SELECT <cols> FROM <table> LIMIT <cap+1>`. Everything it can ever mint is a column value of a row, so *every claim the producer can produce is derivable and re-queryable by construction*. There is no enrollment of a non-derivable dimension, because a non-derivable dimension is not a column.

The one blurry case is a **human-authored warehouse column** — `accounts.notes`, a `segment` someone typed. It is derivable by SQL but not *derived*: testimony that happens to live in a table. That argues for enrolling it as an **episode source**, and never for keeping tier-1 in the fact store.

## Publication never bought what it was thought to buy

The strongest defence of the current design is **disagreement detection**: a person says "Dharma is on pro", the warehouse says trial, and that tension must surface. Querying alone cannot do that. The defence fails on the evidence, because the code already implements it without publication:

- `CORROBORATION_LOOKUP_SQL` and `TENSION_CANDIDATES_SQL` (`lib/brain/reconcile.ts`) filter `invalidated_at`, `valid_to`, the slot keys and the `_cmp` columns. **Neither filters `status`.**
- `loadTensions` (`lib/brain/search.ts`) is called `(db, factIds, ctx, requestId)` — **no `mode`**. The counterpart read in `lib/brain/tensions.ts` is ACL-gated, never status-gated.
- `WAREHOUSE_EVIDENCE_SQL` (`lib/brain/coverage-warehouse.ts`) joins `brain_facts` with **no status arm**, and says why: filtering by status *"describes the review backlog rather than the coverage."*

So an unpublished warehouse row already corroborates, already earns `in-tension-with` edges, already surfaces to the agent as a counterpart inside a published fact's cluster, and already counts as observed evidence on the Coverage Surface. **Draft is what buys disagreement detection. Publication buys exactly one thing: the serving path** — `searchBrain` returning the warehouse row directly, in answer to a question with no rival in it. That is the one path `executeSQL` serves fresher, and it is the path this ADR closes.

ADR-0041 is worth noting here: it decided, for its own reasons and one subsystem over, that a warehouse row counts as *observed* the moment it exists and that review status is irrelevant to what it means. This ADR is that conclusion, generalized.

**Two arguments that look better than disagreement detection, and are not.**

- **History.** `asOf` reads exist ([#4916](https://github.com/AtlasDevHQ/atlas/issues/4916)) and a warehouse without an SCD cannot answer *"what plan was Dharma on in July"*. But the producer's re-emission is **tension-only by design** — it mints a fresh draft and explicitly does not stamp `valid_to` on its predecessor ([#5033](https://github.com/AtlasDevHQ/atlas/issues/5033)'s symmetric tier guard; [#4759](https://github.com/AtlasDevHQ/atlas/issues/4759) §2 forbids a machine invalidating a fact outright). Repeated runs accumulate coexisting live claims with open windows, not a timeline. The design cannot grow the one feature that would justify it, and the honest fix is warehouse-shaped: a snapshot table, an SCD, a `dbt` snapshot.
- **"The row is tier-1, so it is authoritative by construction."** See below — it is an equivocation.

## An observation is not a belief

**Observation** — a recorded reading of a warehouse value at an instant, produced by the warehouse producer for an enrolled `(entity, dimension)` pair. Collectively, observations form the **comparison surface**.

What an observation does: supplies `subject_cmp`, feeds the entity store, participates in cross-tier collision arbitration, earns `in-tension-with` edges against reviewed facts, counts as evidence on the Coverage Surface.

What an observation is not: a claim anyone believes, a candidate for review, a thing that can be corroborated, a thing that can be served.

**Structurally**: it stays in `brain_facts` at `status = 'draft'` and is discriminated on `provenance.source` via the existing `isWarehouseDerivedSource` predicate — no migration, no new status vocabulary, and no allowlist entry on `scripts/check-brain-fact-promotion.sh`, whose whole purpose is keeping `brain_facts.status` single-writer. The refusal goes in **`classifyFactForPromotion`** (`lib/brain/promotion.ts`), which is pure and already has three consumers — the publish adapter, the review queue's pre-flight (`candidates.ts`), and `correction.ts`. One arm there is inherited by all three: the gate refuses it, the queue shows it as refused with a reason rather than as a publishable row, and the correction path stays consistent.

Note that `status = 'draft'` now means two things — *awaiting a human* for episode classes, *not servable, ever* for observations. That cost is accepted because the discriminator is a column any reader can inspect, not a convention. **The serving exclusion must cover both arms of `brainFactStatusClause`**: developer mode is `status IN ('published','draft')`, so "never published" alone leaks the whole comparison surface to the agent under `/ee` developer overlay.

## The tier-1 correction guard was the right rule at the wrong gate

`lib/brain/correction.ts` refuses every correction verb on a warehouse-derived fact because *"tier-1 is authoritative by construction"* — and its own next sentence concedes *"tier-1 proper is never stored at all."* `TRUST_TIERS` (`lib/brain/types.ts`) says the same thing from the other side: *"Tier 1 has NO representation in the brain tables — warehouse facts resolve live through the semantic layer."*

Both cannot be true of the same row. **"Authoritative by construction" is a property of the query, not of the row the query produced.** A stored row is a snapshot: authoritative *as of an instant*, and demonstrably not authoritative now — two published warehouse facts on prod today describe an organization deleted this morning, and the producer cannot supersede them (no row left to re-read) while a human may not retract them (tier-1). They are permanent.

So the guard inherits authority from a read it did not perform, at a time it did not run. That is the category error, stated precisely, and it is why the guard had to be written as a blanket refusal rather than as a rule with a shape. **The same rule applied one gate earlier stops being a patch and becomes the definition**: refuse at *publish*, not at *correction*. Under this ADR `warehouseTarget` is not deleted — it is moved to the side it always belonged on.

## What is untouched

- **All of ADR-0037.** §4's emission contract, §5's *"the brain never reads tier-1 live, at any position, for any purpose"*, `subject_cmp`, the entity store, the alias-proposal query, and every one of M4's collision mechanisms. The agent reaching a warehouse value through `executeSQL` is not the brain reading tier-1 — it is the agent's other tool, and the prohibition is about the brain's own reads.
- **[#5326](https://github.com/AtlasDevHQ/atlas/issues/5326)** (the producer reads every member of a connection group; cross-member subject collision refused). Correct, shipped, verified, and orthogonal.
- **Enrollment** (ADR-0039). See below.
- **`SEARCH_BRAIN_TOOL_DESCRIPTION`**, which already reads *"Use this when asked about decisions, rationale, ownership, or policy. Don't use this for quantitative state (`executeSQL`)."* This ADR makes the tool honest about what it does rather than requiring new words.

## Consequences

**Corroboration must exclude observations, and doing so exposes a live defect.** `writeCandidate` runs `CORROBORATION_LOOKUP_SQL` **first and returns on a hit**, and that lookup has no status arm. So today: the warehouse holds `Dharma / plan_tier / trial`; a person says in Slack "Dharma's on trial, we should upsell"; the extractor's claim matches the warehouse row, corroborates it, and returns. **No draft is minted and nothing reaches the review queue** — the person's statement becomes a provenance edge on a warehouse row. Under this ADR that row can never be served, so the testimony would be swallowed entirely. Excluding observations from the lookup is therefore required, and it follows from the definition: only a belief can be corroborated. Agreement remains recoverable as the complement of the tension scan. **The defect is live today independently of this decision, and it is part of why every warehouse candidate in the queue is derivable: a human claim that happens to agree with one never becomes a candidate at all.**

**`WAREHOUSE_ROW_CAP`'s stated justification evaporates.** Its doc records *"The review gate is the constraint, so the bound is expressed in units of review rather than of database load"*, and refuses a knob because one *"would loosen the product's differentiating gate."* With no review gate downstream, 1,000 is a number in the wrong unit. The cap must be re-argued in units of snapshot cost and identity blast radius — it is not raised or lowered by this ADR, only re-grounded. This is what [#5329](https://github.com/AtlasDevHQ/atlas/issues/5329) becomes: the same code defect, a different reason to care, and a body that must be rewritten so nobody fixes it for a reason that is no longer true.

**[#5330](https://github.com/AtlasDevHQ/atlas/issues/5330) dissolves.** The review gate cannot reject a warehouse draft because `retract` is a correction verb and tier-1 has no correction path. Under this ADR the gate is never offered one. Close as obsolete, superseded here.

**Enrollment survives on a better argument.** ADR-0039's case was *"an unenrolled sweep puts an unreviewable queue behind the one gate the product is differentiated by."* That queue no longer exists. What remains, and is sufficient: **snapshot cost** against the customer's warehouse per dimension per cadence; **identity blast radius**, since every emitted row writes entity-store entries and `subject_cmp` and a sweep silently re-keys the corpus; and the **deliberate act** that ADR-0041's labelling policy already leans on. What enrollment is no longer is review-queue flow control.

**ADR-0040's authority arm relocates rather than empties.** The warehouse class's authority arm was *"enrollment plus the review gate"*; it is now **enrollment**, full stop. Authority over a derivable value was never the review gate's to grant — it belongs to whoever authored the semantic layer and the enrollment. *"The contract automates availability and never automates authority"* survives intact.

**PRD condition 2 is strengthened, not waived.** *"Every authoritative claim has a human name on it… there are no exceptions"* is not engaged by observations, which are never authoritative and never served. And the current design's compliance is nominal: a reviewer whose only options are *approve* or *leave it in the queue forever* — who may not reject it (#5330) and may not correct it afterwards (`correction.ts`) — is not the person who made anything authoritative. Removing warehouse rows from the gate removes the one population where condition 2 passed on paper and failed in substance.

**The two already-published rows get `retract`, narrowly.** Lift `warehouseTarget` for `retract` **only**; keep it for `supersede`, `re-authority` and `pin`. Those three assert a belief *about* a warehouse value and stay incoherent. `retract` asserts only *this row should not have been blessed* — which is exactly what happened, and exactly what a human is entitled to say. A migration would write `status` outside the publish adapter and need a one-off guard allowlist entry: worse than using the verb that already exists. The unpublished candidates need no action; they simply become observations, which is the correct reading of what they always were.

**Enforcement is a test, not a grep guard.** `check-brain-fact-promotion.sh` greps for *code shapes* because a rogue status writer is a shape. This rule is a runtime predicate over stored provenance — there is no shape to grep, and a guard that cannot express the rule it is named for is worse than none. `promotion.ts` is pure; a test that a warehouse-sourced draft is refused by all three of its consumers is a measurement that can fail, which is the bar [`docs/agents/practices.md`](../agents/practices.md) sets.

**Someone will propose publishing them again.** It will arrive as a retrieval complaint (*"the Atlas doesn't know what plan they're on"*), and the answer is that it does — through `executeSQL`, fresher, and the tool description already routes there. The test for any such proposal is the one this ADR turns on: **name something publication buys that the observation does not already deliver.** Disagreement detection is not it.

## Alternatives rejected

- **Keep publishing, and fix #5329 and #5330 individually.** Both are real, and both are symptoms: one is a producer that cannot express a filter for a queue that should not exist, the other a gate that cannot reject rows it should never see. Fixing them separately treats the patches as the design.
- **A new terminal `observed` status.** Honest vocabulary, and `draft` would keep meaning one thing. Rejected because it makes the producer a `brain_facts.status` writer on INSERT — precisely the shape `check-brain-fact-promotion.sh` exists to refuse — for a discriminator that already exists in `provenance.source` and is already load-bearing.
- **A separate observations table.** Would require re-implementing the corroboration lookup, the tension scan, the coverage join and the ACL clause against a second table — two spellings of "what is in tension", which is the drift hazard `lib/brain/tension-sweep.ts` was written to warn about.
- **Delete the warehouse producer.** Overshoots by a wide margin. Four of its five consumers never needed publication; only the serving path did.
- **Keep tier-1 out of `brain_facts` entirely and re-derive comparisons at query time.** Prohibited by ADR-0037 §5 — the brain would have to read tier-1 live.

See also: [ADR-0037](./0037-claim-identity-in-the-brain.md) §4–§5 (untouched) · [ADR-0039](./0039-the-warehouse-producer-emits-only-what-a-human-enrolled.md) (enrollment, re-argued above) · [ADR-0041](./0041-the-coverage-surface-counts-what-it-can-see.md) (which reached this conclusion first, for coverage) · [ADR-0043](./0043-the-company-keystone-is-asked-for-never-researched.md) (the non-derivable, durable material the fact store is actually for) · [`docs/prd/company-atlas.md`](../prd/company-atlas.md) (conditions 2 and 6).
