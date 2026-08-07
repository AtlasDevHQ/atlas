# The Atlas is the product; the brain is the category

Status: **proposed** (2026-08-07, brain-milestone review — destination doc: [`docs/prd/company-atlas.md`](../prd/company-atlas.md))

[ADR-0036](./0036-atlas-as-company-brain.md) §T2 committed to *"the data-grounded company brain"* as **both** the category claim and the product noun. We decided to **split them**: the category claim stands unchanged — it is how a buyer finds Atlas and how the field talks — while the thing itself is named **the Company Atlas**, or in-product simply **the Atlas**.

This ADR **supersedes ADR-0036 §T2's product naming only.** The bet, the wedge, the two compounding legs, and the "worse Glean" guardrail are untouched — this ADR is downstream of them and argues *from* them.

## Why the product noun has to move

**"Brain" is a breadth word, and breadth is the thing ADR-0036 concedes on purpose.** It promises total recall and one mind. §T2's primary named risk is the worse-Glean trap — competing on breadth Atlas will lose — and its defusing guardrail is *claim extraction **trust**, concede **breadth***. The product noun argues against the product strategy every time it is spoken, which is a cost paid on every surface, forever.

**"Atlas" is a bounded-coverage word.** An atlas is surveyed, dated, attributed, indexed — and it marks where the map ends. Terra incognita is a feature of an atlas, never an embarrassment. It is also, already, the name of the company, so the product noun stops being a second brand to maintain.

**The metaphor is load-bearing, not decorative** — this is what moved the decision from taste to evidence. Every mapping below is an existing ADR-0036/0037 decision restated; none was invented to fit:

| Cartographic idea | The decision it already is |
|---|---|
| A **legend** — what the symbols mean, before you read the map | The curated workspace vocabulary ([ADR-0037](./0037-claim-identity-in-the-brain.md)) |
| **Survey date + surveyor** on every sheet | Provenance mandatory; no-provenance-no-promotion (§T4) |
| **Surveyed coastline** vs **sketched interior** | Tier-1 authoritative-by-construction vs tier-2 reviewed (§T3) |
| **Disputed borders**, drawn dashed, both claims shown | `in-tension-with` — surfaced-both, never ranked (§T4) |
| **Editions**; superseded ones stay on the shelf | Bi-temporal, invalidate-never-delete, `asOf` (§T4) |
| **Scales** — world map and street map in one volume | The two-grain graph: entities coarse, facts fine (§T3) |
| The **cartographer signs it** | The review gate; the human is the invalidation authority (§T4) |
| **Terra incognita, marked** | Extraction-pending episodes; unconnected sources |

The disputed-border row is the one that decided it: cartography has a **400-year-old visual convention** for exactly the thing §T4 refuses to auto-arbitrate. A product that must show unresolved tension without ranking it does not have to invent a way to do that.

**The vocabulary was tested before it was proposed.** [`docs/prd/company-atlas.md`](../prd/company-atlas.md) states the arc's destination end-to-end in atlas language. It held for every tier, for coverage and limits, for provenance, for disputes, and for editions. It strained in exactly one place — **durable session memory**, which [ADR-0020](./0020-durable-agent-sessions.md) already keeps outside the fact lineage, and which §T9 explicitly refuses to merge into it. The metaphor's seams landed on the architecture's seams. That is the strongest available evidence that the vocabulary describes the system rather than decorating it.

## What is renamed, and when

Three layers, decided independently, because they have wildly different costs and only one is expensive.

### Layer 1 — the product surface. Rename now; nothing blocks it.

Admin navigation, docs guides, `apps/www`, and every label a person reads. This is where the whole benefit is and it costs almost nothing: [#5066](https://github.com/AtlasDevHQ/atlas/issues/5066) already made *Company Brain* a **nav group rather than a table name**, so the seam this needs exists.

**Tool *descriptions* are in this layer, and that is the non-obvious part.** A tool's description is prose the model reads; changing it is not a contract break. The agent tells the user *"brain: N facts consulted"* because the description taught it that word. So the vocabulary reaches end users through the description **without waiting on the tool rename below** — which is what makes Layer 1 worth doing on its own rather than banking it.

### Layer 2 — the agent-facing contract. One decision, timed, never standalone.

The tool **name** `searchBrain` and the wire enum values (`tier: "fact"`, `"raw-episode"`) are a contract: they are MCP-exposed and third-party agents bind to them. Renaming is a real break.

**It happens before the `v1.0.0` contract freeze, bundled into the milestone that already changes the tool** — retrieval depth — and **never as a standalone rename PR.** Two reasons the timing is forced rather than preferred: `v1.0.0` is reserved for frozen REST + MCP + plugin SDK contracts ([ADR-0008](./0008-versioning-and-release-tags.md)), so the window closes permanently; and `searchBrain` is itself only one milestone old — it replaced `searchKnowledge` in M1 — so the population bound to the name is the smallest it will ever be.

### Layer 3 — internal schema. Explicitly not renamed.

`brain_facts`, `brain_edges`, `brain_vocabulary_edge`, `lib/brain/**`, the migration series, and `ATLAS_BRAIN_EXTRACTION_ENABLED` **stay as they are.** Nobody outside the codebase reads them, and churning them mid-arc means touching the just-bumped region bundle v3, the bundle-scope registry, the cleanup rule map, and their tripwire tests — for zero user-visible value. `ATLAS_BRAIN_EXTRACTION_ENABLED` additionally costs a coordinated three-region deploy to rename, which buys nothing an operator would notice.

**This asymmetry is the point, and it is ADR-0036's own "reframe, not rebuild" applied to the name.** A rename that reaches the schema is a rebuild wearing a rename's clothes.

## The tier names

The three trust tiers have internal names and no user-facing ones. Proposed:

| Wire value (unchanged) | What a person reads | Why they can trust it |
|---|---|---|
| tier-1 warehouse | **Surveyed** | True by construction — the answer re-reads live rows, so it cannot go stale between readings |
| tier-2 reviewed | **Attested** | A named colleague read this claim and stood behind it, and is on the record |
| tier-3 episode | **On the record** | What was actually said, unedited. Testimony, not fact |

**Display names and wire values are decoupled** — the wire values move with Layer 2 or not at all. What does *not* move is ADR-0036's consequence that the tiers stay permanently distinguishable to whoever is reading: *"every retrieval result and every UI surface must carry the tier label, or the wedge is invisible and the worse-Glean trap re-opens."* Renaming the label never weakens that; it is an attempt to make the label land on someone who has not read an ADR.

## Consequences

- **The category claim keeps working where it should.** Search, positioning, and landscape comparisons still say "company brain," because that is the phrase a buyer types. The product noun is what a customer lives inside. Nothing here is a repositioning.
- **The two vocabularies cannot be left coexisting.** They are both live in-repo today (this ADR and the destination doc are written in one; everything else in the other), and that state is worse than either. **Accepting this ADR obliges Layer 1 to follow promptly**; rejecting it obliges the destination doc to be rewritten in brain language.
- **[#5044](https://github.com/AtlasDevHQ/atlas/issues/5044) grows slightly and gets cheaper.** The Brain-arc renumber already has to rewrite the milestone names; doing the noun in the same pass costs one extra find-and-replace and avoids a second churn of the same lines.
- **`brain-*.mdx` guide filenames become misleading.** Renaming files means redirects. The honest read is that URLs are a Layer 1 cost that Layer 1's argument has to cover — not a reason to keep the noun.
- **Anyone reading the code will see two vocabularies for a long time**, and that is accepted. The mapping is one sentence — *`brain_*` is the Atlas's storage layer* — and it lives in CLAUDE.md.

## Alternatives rejected

- **Keep "brain" everywhere.** The status quo, and cheapest. Rejected because the cost is not the rename; it is the word arguing against the strategy on every surface for the life of the product. That bill grows.
- **Rename everything now, schema included.** Rejected as a rebuild in a rename's clothes — maximum blast radius during an in-flight arc, against a just-bumped region bundle, for no user-visible gain over Layer 1 alone.
- **Rename internals only, keep "brain" in the product.** Rejected as exactly backwards: it pays the entire cost where nobody benefits and none of it where the argument lives.
- **Wait for the arc to complete, then rename once.** Superficially disciplined, and it fails on Layer 2's timing: the `v1.0.0` contract freeze closes the window, and every additional milestone shipped under the old noun adds surfaces, docs, and bound clients to the eventual sweep. **The cheapest moment to do this is the earliest one that is safe**, and Layer 1 is safe now.

## What this ADR does not decide

- **Whether the tier names are the right three words.** They are a proposal; the decoupling from wire values is what makes them cheap to revise.
- **Any part of the coverage surface** the destination doc's finish condition 6 requires. Design is a separate brief.
- **Anything about the AI-employee layer**, which ADR-0036 defers and the destination doc puts outside the line.
