# The warehouse producer emits only what a human enrolled

Status: accepted (2026-08-13, M5 kickoff grill — destination doc: [`docs/prd/company-atlas.md`](../prd/company-atlas.md))

[ADR-0037](./0037-claim-identity-in-the-brain.md) specifies a tier-1 warehouse fact producer's *emission contract* — the bare dimension name, fail-closed on ambiguity, structural cardinality, `subject_cmp` supplied — and deliberately leaves three things to the milestone that builds it: **which entities it produces from, when it runs, and its snapshot discipline** ([#5042](https://github.com/AtlasDevHQ/atlas/issues/5042)). We decided all three with one rule: **a human enrolls `(entity, dimension)` pairs, and the producer emits for those and only those.** There is no sweep mode, and the producer may never widen its own scope.

This ADR does not amend ADR-0037. Its §4 emission contract is untouched — this decides the producer's *reach*, which §4 does not speak to.

## Why reach had to be decided before the producer was built

**The review gate is not optional for this source, and that is a decision two ADRs already made.** [ADR-0036](./0036-atlas-as-company-brain.md) §T9 names write-back as the third writer "beside connector episodes **and warehouse-derived facts** … gated by the same core review gate." The PRD's finish condition 2 admits **no exceptions**, "including for claims that arrived by import." And the gate is not a policy that a producer could opt out of — it is a column default: `reconcile.ts:777` records that migration 0180 defaults `status` to `draft`, and *"that default IS the review gate applying itself"* ([#4769](https://github.com/AtlasDevHQ/atlas/issues/4769)). A fact reaches the record by a human publishing it, or it does not reach the record.

**Every other source in the arc emits at human cadence. This one does not.** A chat connector produces episodes as fast as people talk. A warehouse producer emits one fact per row per dimension, on a schedule, forever. The arithmetic is not close: ten thousand accounts across eight enrolled-by-default dimensions is eighty thousand drafts before anyone has reviewed one. Re-runs are worse rather than better — `reconcile.ts:856` mints **a fresh draft** for a new validity window on every re-observation, and per ADR-0037 §4 each collision with its own prior published snapshot is tension-only, so a changed number costs a draft *and* a tension edge.

So the producer as ADR-0037 imagined it puts an unreviewable queue behind the one gate the product is differentiated by. ADR-0036's own Consequences predicted this in the abstract — *"the human review gate is now load-bearing beyond the KB … its throughput and UX become a first-class concern the moment M1 ships facts at connector scale"* — without naming the source that would cause it.

**Three of the four available escapes cost more than the problem.** Auto-publishing warehouse facts contradicts ADR-0036 §T9 and PRD condition 2, and spends the wedge: §T1's survey found Atlas's gate is *"the only human approval gate in the entire survey between 'an agent extracted a fact' and 'the fact is authoritative.'"* A bulk approve-all UI keeps every invariant nominally and empties condition 2 of meaning — a reviewer approving eighty thousand rows is a rubber stamp with a name attached. Reading tier-1 live at retrieval time instead of materializing facts is prohibited by name in ADR-0037 §5: *"the brain never reads tier-1 live, at any position, for any purpose."*

The fourth escape is to stop treating the warehouse as a corpus to be indexed.

## What enrollment is

A human names the `(entity, dimension)` pairs the brain should hold claims about. The producer reads that list and emits for its members. An unenrolled dimension is not hidden, not filtered, and not pending — **it is outside the producer's reach**, and the coverage surface reports it as such.

This bounds all three of ADR-0037's deferred questions at once:

- **Which entities it produces from** — the enrolled ones. Ambiguity fail-closed (§4) now applies across a set a human chose, so a refusal is legible to the person who caused it rather than emitted into a sweep nobody is watching.
- **When it runs** — on enrollment, and on a cadence thereafter. Cadence stops being frightening once scope is small.
- **Snapshot discipline** — unchanged from §4, and now affordable. At ten enrolled dimensions a re-run mints a handful of tension edges, which is a queue a person drains. **This is why [#5042](https://github.com/AtlasDevHQ/atlas/issues/5042)'s "resolve warehouse↔warehouse re-emission before building" is retired rather than answered**: §4 already ruled it *"tension-only, which is the Fog [#5008](https://github.com/AtlasDevHQ/atlas/issues/5008) records rather than a gap."* It was never an unspecified design hole — it was a volume problem wearing a specification problem's clothes, and enrollment is the volume answer.

## This is a pattern the codebase already has

[ADR-0032](./0032-amendments-refine-never-grow.md) decided that semantic-layer Amendments *"refine coverage that exists … they never expand the whitelisted table set,"* and that a column with no coverage is shown honestly as **uncovered**, routing to the enrich flow — **"a human-initiated act with whitelist consequences."**

The shapes are identical: a machine refines within a boundary, a human moves the boundary, and the space outside is displayed honestly rather than silently omitted. ADR-0032 drew the line because auto-approve made an LLM one click from whitelist expansion; this ADR draws it because machine cadence puts a producer one schedule from an unreviewable queue. The containment is what makes the automation safe to contemplate in both cases.

## Consequences

**Breadth is conceded here too, on purpose.** The PRD's *What the Atlas will not do* #5 — *"It will not try to index everything. Breadth is conceded. A smaller set of facts you can actually trust is the product"* — is usually read as being about which **sources** connect. This ADR applies it *within* a connected source. A connected warehouse is not a mandate to claim everything in it.

**Activation of ADR-0037 is now proportional to enrollment, not automatic.** ADR-0036 §T10's amendment says M5 "carries the burden of activating M4." Under this decision the four dormant mechanisms — the tier guard, the entity resolver, `subject_cmp`, the alias-proposal query — come alive in proportion to what someone enrolled. **A producer nobody enrolls anything into leaves M4 exactly as dead as it is today, with every test green.** That is M1's failure restated: *"'flag on' and 'source connected' are two facts, the sync reports green on either, and only a row count separates them."* M5 therefore closes on prod row counts rather than on merge, tracked past its last PR.

**The entity store inherits the bound.** [#5043](https://github.com/AtlasDevHQ/atlas/issues/5043)'s store resolves surfaces for enrolled entities and abstains elsewhere. Abstention is already its designed behaviour, so partial coverage is not a failure mode — but it does mean an empty store and a working one are indistinguishable from inside the code, which is the second reason the milestone's proof is a row count.

**Someone will propose a sweep mode.** It will arrive as a convenience ("just enroll everything"), as a migration aid ("bulk-enroll on connect"), or as a default ("enroll every dimension the profiler found"). Each is this ADR's rejected alternative with the human step moved somewhere it stops being one. **A bulk-enroll affordance that a person invokes deliberately over a set they can see is enrollment; one that runs on connect, on profile, or on a schedule is a sweep.** The test is whether a person chose the members, not whether a person clicked something.

## Alternatives rejected

- **Auto-publish warehouse facts** (tier-1, primary-key-backed, no LLM — a per-fact reviewer has nothing to add) — contradicts ADR-0036 §T9 and PRD condition 2, and would require amending the wedge rather than the producer.
- **Full sweep plus bulk approval** — preserves every invariant's letter and none of condition 2's meaning.
- **Subject-scoped emission** (emit only for subjects the brain already knows) — bounds volume without a human act, and is circular with [#5043](https://github.com/AtlasDevHQ/atlas/issues/5043), whose entity store is meant to be fed *from* the warehouse.
- **Live tier-1 reads at retrieval time** — prohibited by ADR-0037 §5.

See also: [ADR-0037](./0037-claim-identity-in-the-brain.md) §4 (the emission contract this leaves intact) · [ADR-0032](./0032-amendments-refine-never-grow.md) (the precedent) · [`docs/prd/company-atlas.md`](../prd/company-atlas.md) (conditions 2 and 5).
