# Atlas becomes the data-grounded company brain by assembling assets it already owns

Status: accepted (2026-07-23, "Atlas as the company brain" wayfinder map [#4755](https://github.com/AtlasDevHQ/atlas/issues/4755); landscape research: `.claude/research/4756-company-brain-landscape.md`)

Atlas commits to becoming a **company brain** — an ingest-everything fact graph plus shared cross-agent memory, with the analytics warehouse as the one *authoritative* input — but as a **reframe, not a rebuild**: the bet is an assembly of assets Atlas already owns (the review-gated Knowledge Base [ADR-0028](./0028-knowledge-base-fourth-pillar.md), durable sessions + memory [ADR-0020](./0020-durable-agent-sessions.md), the semantic layer, the connector-sync engine [ADR-0030](./0030-knowledge-sync-connector-seam.md), the MCP server, residency [ADR-0024](./0024-regional-identity-isolation.md), `learn/`), not a new product. The category is **"the data-grounded company brain"**; the wedge — bankable because no closed extract-first competitor can copy it without demoting their own thesis — is **"authoritative company facts, on infrastructure you control."** This ADR records the shape of the bet and the sequence that builds it; **all implementation is gated behind the v0.1.0 public launch** and handed to the milestone cut in the last section.

This is a synthesis ADR. It is the destination of a ten-ticket wayfinding map; each section below is one locked decision (T2–T10), and the map ([#4755](https://github.com/AtlasDevHQ/atlas/issues/4755)) holds the full grilling record.

## Context

The agentic-memory field has converged on a single substrate shape — episode/fact split, subject-predicate-object triples, typed edges, bi-temporal invalidation, provenance-to-source, per-fact ACL, hybrid (semantic + full-text + graph) retrieval fused by RRF — independently arrived at by Hyper (YC P26), Zep/Graphiti, and mem0. **Atlas already owns most of it under different names.** The KB pillar is review-gated draft→published fact curation; durable memory is session state; the ingest spine and connector engine are the acknowledged bottleneck everyone else is paying to cross; the warehouse *is* the connector for the highest-value question class. **The build is substrate-assembly, not invention.**

Three findings from the landscape research (T1) set the strategy and recur through every decision below:

1. **The adoption gap is UX/trust, not benchmark score.** SOTA memory systems crowd the top of LoCoMo/LongMemEval yet see little mass adoption; the founders of the nearest competitor say so plainly. The win is not a higher retrieval score — it is *correctness a human can verify*.
2. **Staleness is the unsolved moat** ("right on Monday, quietly wrong by Friday"). Warehouse facts are structurally immune — the query re-reads live rows — and no competitor grounded in chat/email extraction can claim that.
3. **Silent auto-write memory is a trust liability the field is nervous about.** Atlas's review-gated draft→published gate is the only human approval gate in the entire survey between "an agent extracted a fact" and "the fact is authoritative."

The competitive baseline the bet is drawn against: Hyper (episodes + SPO facts + typed edges + provenance + temporal invalidation + per-fact ACL, injected via silent hooks), nao-os (git-repo brain + agent team + connectors), the "Memory Store" shared cross-agent-memory pattern (a pattern, not a single verified product — realized by mem0/Zep/Vertex/Bedrock), Glean (enterprise search + per-customer-GCP knowledge graph).

## The bet (T2)

**Reframe, don't rebuild.** The bet is real as an assembly of owned assets, not a new product line. The category claim is **"the data-grounded company brain"**: the warehouse is the authoritative spine (facts true by construction — no extraction error, no staleness, provenance = the row itself); extracted facts and memory are a labeled, gated, provenance-bearing *second tier*, never conflated with the first.

The primary risk is the **"worse Glean" trap** — shipping a fuzzy retrieval box that looks like every other company-brain and competes on breadth Atlas will lose. It is defused by one load-bearing guardrail: **claim extraction *trust*, concede *breadth*.** Atlas does not try to out-connector Glean; it offers a smaller set of facts you can actually trust, on a warehouse spine no extraction-first product has. Two supporting guardrails: the analyst core stays best-in-class (the brain never comes at the query product's expense), and **no substrate ships before v0.1.0**.

The committed scope is the **brain**. The AI-employee / work layer (named role-agents, scheduled briefings, autonomous actions) is a **downstream thesis** — the upside that *justifies* the brain, separately argued, deliberately not committed here (see *What this defers*).

## The wedge (T2)

**"Authoritative company facts, on infrastructure you control"** — two compounding legs, each durable because copying it costs the competitor their own business model:

- **Data-groundedness.** Durable not via "we read your warehouse" (anyone can) but via the **trust-tier stance**: a hand-verified semantic layer + query-time RLS make tier-1 facts authoritative *by construction*. A competitor whose thesis is auto-extraction cannot adopt "the warehouse is the authority" without demoting auto-extraction to second-class — which is their whole product.
- **AGPL self-hostability.** Durable via **unwillingness, not inability**: a hosted-SaaS competitor (Glean stores the graph in a per-customer GCP project; Hyper is hosted) *could* build self-host but won't, because it torches their hosted revenue. For regulated buyers "run the whole brain inside your own VPC under AGPL" is a procurement unblock, not a feature.

## The knowledge substrate (T3)

**A new fact/edge/episode substrate with its own trust identity, reusing the KB's lifecycle — not a KB extension** (the option of extending ADR-0028's descriptive-doc model in place was rejected). It reuses KB's review gate, per-org mirror, and `ingest-bundle.ts` seam, but is a distinct subsystem.

- **Three trust tiers:** warehouse facts *authoritative-by-construction*; reviewed facts *authoritative-for-their-class* (they yield to the warehouse in any overlap); raw episodes *source-of-truth for what was actually said*. This **deliberately breaks ADR-0028's flat "descriptive-only" line** for the fact class — the conflict-resolution cost of that break is paid in full by T4.
- **Postgres-authoritative + OKF-projection mirror.** Temporal validity, ACL, and live entity resolution are relational; files-as-truth was rejected. The OKF projection buys the visualizer, export, and greppable self-host for free; typed/temporal edges ride an `atlas:` frontmatter extension.
- **Two-grain graph:** entities coarse (some warehouse-backed and live-resolving), facts fine.
- Durable memory (ADR-0020) is **not** the fact lineage — it is per-session and isolated; the bridge between them is write-back (T9), and episodes are stored by-reference for warehouse/KB-derived facts.

## Temporal, conflict & provenance model (T4)

**The review gate *is* the conflict-resolution mechanism** — T2's "trust over breadth" made mechanical, paying the tier-2 conflict bill T3 banked. Recency-only arbitration (the competitor's current answer, which fails exactly when an intern contradicts the CEO) is rejected.

- **Full bi-temporal, invalidate-never-delete.** Supersession ≠ deletion; an `invalidated_at` column joins T3's three. Staleness is **advisory at ingest, authoritative at the gate** — a human promotion stamps `valid_to`; there is no autonomous supersession; decay only *surfaces*, never auto-demotes.
- **Refuse to auto-arbitrate conflict.** Warehouse-wins plus the human gate dissolve most conflicts; genuine coexisting tension is **surfaced-both-with-provenance**, never ranked (source-authority is a surfacing hint only; recency is the last resort, used only when authority is equal and a single pick is forced). **Predicate cardinality** (single-valued supersedes / multi-valued coexists) is the supersede-vs-coexist switch; corroboration strengthens and is not a conflict.
- **Provenance mandatory — no-provenance-no-promotion.** Immutable/append-only; forks recorded via `derives-from`; warehouse-derived facts pin the SQL + a data snapshot (not a live view).
- **Correction is a first-class human-authored episode** — the second human-authoritative entry point beside the gate, highest-trust, **landing authoritative immediately** — with four verbs (**retract** — the only tombstone path, and the GDPR-erasure verb · **supersede** · **re-authority** · **pin**), a `correct_fact` tool, and never an auto-cascade: retracting a fact others `derive-from` flags the dependents for re-review, never nukes the subtree. **Tier-1 warehouse facts have no correction path** (you fix the data or the semantic layer, not the brain).
- Edges committed: `supersedes` · `in-tension-with` · `derives-from` · `provenance`.

## Access control & residency (T5)

**A new minimal per-fact/per-episode ACL primitive over tiers 2–3 only.** Tier-1 warehouse facts defer to existing warehouse RLS — no double-gating. The grant is a self-contained principal set (`visible_to`), **derived at ingest** by T6 and evaluated read-time-local (consistent with T4's snapshot-not-live reads). Two alternatives were rejected: *"org/group scope is enough for v1"* — which caps the ingest surface to org-public sources, when ingesting HR/exec/DM sources is exactly what makes it a brain rather than a data tool — and *live source-ACL resolution* (connector-coupled, offline-hostile). The accepted cost of derive-at-ingest: source-membership changes don't propagate until re-ingest, so sensitive facts grant to a **synced `audience:`**, where revocation flows through membership live.

- **Grammar:** `org | role:{owner,admin,member} | user:<id> | audience:<source-derived>`. No Better Auth teams (Atlas has none; "group" means connection-group, not people). `audience:` is backed by an Atlas-owned `fact_audience_member` table that T6 populates via source-membership entity resolution.
- **No-grant-no-promotion** (mirrors T4's no-provenance rule); the public majority carries an explicit `[org]`; malformed/unresolvable grants **deny + log**.
- **Bi-temporal ACL = immutable per-version grant snapshot + as-of-now membership.** A read of "what we believed Monday" uses Monday's grant; a tombstone is the only way to hide history.
- Provenance/actor rides the fact's grant; admin/audit override is **region-scoped** (no cross-region super-admin); corrector-masking is /ee.
- **Composition is four gates AND-ed:** residency-invariant-by-construction · org/group-reach ([ADR-0022](./0022-cross-group-reach-llm-composition.md)) · content-mode draft/published · the ACL grant.
- **Seam:** T5 owns the model and a **fail-closed push-down SQL visibility predicate**; T7 *applies* it as a `WHERE` clause (push-down, not post-fetch).

## Ingestion & connectors (T6)

**Reuse the ADR-0030 connector engine verbatim** (scheduling / high-water / incremental-reconcile / backoff / caps — already hardened) and **fork the ingest core** (a full rewrite was rejected; so was extending the engine's fact-scoped half onto episodes).

- **Episodes are immutable, append-only, deduped by stable source-id — they bypass the engine's subtractive-archive + path-upsert entirely** (that half scopes to the fact layer). The reconcile *cadence* is repurposed to re-run extraction.
- **Dumb connectors + one generic extraction stage, run async.** The fetch fiber writes episodes immediately; the extraction fiber drains `extracted_at IS NULL` → LLM → reconcile → `draft`. Facts are **second-order-fresh**; there is no synchronous fast-path.
- **One reconcile stage at ingest** (entity-res → grant → provenance → corroboration-dedup → advisory contradiction) produces fully-formed candidates the reviewer only trust-calls. It is **entry-point-agnostic** — connector episodes, warehouse-derived SQL-pinned facts, and human corrections all converge on it (the seam T9's write-back reuses).
- **Block-vs-flag asymmetry:** no-provenance / no-grant / source-principal-resolution-fail → **block + log** (safety); subject/object entity-res fail → **flag provisional**, cleared by a reviewer via `correct_fact` (quality).
- **Source order is class-major, vendor-minor: chat → transcripts → email → docs/wiki/code/drive** (ranked by density × existing-connection × audience-cleanliness). The class order coincides with the ACL-difficulty gradient, so T5's blocking grant-derivation is validated on easy mode first.
- **Freshness = poll + reconcile universally, plus a webhook fast-path for event-native chat** (an alternate writer into the same idempotent episode store, safe by the source-id dedupe; each connector's obligation is a stable source-id shared across webhook and poll).

## Retrieval & agent interface (T7)

**Explicit-tool-primary; silent hook injection is rejected** — Hyper's undisclosed on-every-prompt hooks are the trust liability T1 named, and refusing them *is* the wedge stance. In-loop context priming stays allowed but **transparent** (the user sees "brain: N facts consulted" with provenance); there is no auto-inject into third-party agents. The accepted cost is adoption friction — external agents must *choose* to consult the brain and often won't; trust-over-zero-friction-capture is the deliberate trade. The surface is **two read tools + one write tool, all explicit, disclosed, and MCP-exposed:**

- **`executeSQL` unchanged** — tier-1 authoritative warehouse stays its own deterministic tool, never folded into a fuzzy query.
- **`searchBrain`** (evolves `searchKnowledge`) — one fused read over the three fuzzy stores (reviewed facts · KB docs · raw episodes), **every result trust-tier + provenance labeled.** Mechanics: query-expand → dense embeddings + sparse FTS fused via RRF → typed-edge graph → optional rerank; staged so embeddings+RRF is the bounded add over today's FTS+1-hop-graph, with **FTS-only graceful degradation when no embedding provider is configured** (a self-host requirement — flagged to T8). Default reads **as-of-now** (superseded/tombstoned hidden); optional `asOf` is a bi-temporal point read using *that version's frozen ACL grant snapshot*; `in-tension-with` surfaces a conflict cluster, never a winner. It applies T5's fail-closed push-down ACL predicate. Two committed edge behaviors: a best-match episode not yet extracted (`extracted_at IS NULL`) is still returned, tagged **`tier: raw-episode, extraction: pending`** with its stable source-id — T6's extraction-lag window degrades to a labeled raw answer, never a blocked read; and warehouse-backed coarse entities carry a **resolver** that resolves identity/label live, while **quantitative current-state stays `executeSQL`** — `searchBrain` never silently runs metric SQL.
- **`proposeFact`** — the only agent write, explicit/logged/draft-only, an entry point onto T6's reconcile stage via T9's write-back path.

Routing is **agent-side, not a hidden classifier**, so the tier line stays visible to the user.

## Open-core boundary (T8)

**Governing test: no brain *capability* is ever /ee-gated — only convenience, governance, or scale.** A self-hoster runs the *complete* brain — ingest → extract → review → store → hybrid-retrieve → correct — for free. This is "durable via unwillingness, not inability" (T2) made mechanical, and it matches "self-hosted is always free" and T5's "restriction is safety, not monetization."

Locked lines (all in `packages/api`, AGPL):

- Substrate + `correct_fact` **core** (T3/T4); extraction **core, BYO-LLM-key**; **all connector classes core, plugin-shaped** ([ADR-0013](./0013-db-stored-plugin-datasource-connections.md)) — no source class is /ee; scheduling/always-on **core** ("always-on" is managed-operation value, not a code gate); retrieval embeddings + RRF + rerank **core behind BYO-provider** (FTS-only is the no-provider floor); the review gate **core** (single-approver draft→published — the wedge-defining trust differentiator); minimal ACL **core and fail-closed** (T5); provenance + audit-log **core**.
- /ee (in `ee/src`, commercial license): advanced approval governance (quorum / separation-of-duties / SLA / masking, via the existing `ApprovalGate`); advanced ACL / label taxonomy / SCIM-IdP audience sync / provenance masking / fact residency; managed LLM (extraction) and embedding endpoints; managed connector operation; the marketplace install/billing veneer; audit-retention policy.
- **Composition adds no new gating mechanism:** new `Context.Tag`s on the existing `enterprise-layer.ts` seam, whose Noop defaults **degrade graceful-to-core** (never fail-loud). The sole fail-closed exception is the core security predicate — which is not /ee.

## Write-back / self-improvement loop (T9)

**A new entry point onto T6's entry-point-agnostic reconcile stage — not new machinery.** Write-back is the third writer (beside connector episodes and warehouse-derived facts) onto the same pipeline, gated by the same core review gate. Five locks:

1. **Trigger** — explicit-act-to-enter (`proposeFact` per T7, or a human "remember this"), review-gate-to-exit. **No silent autonomous *publish*, ever** (write-side symmetry with T7's rejection of silent hooks). An autonomous insight-detector is permitted only as an **opt-in, off-by-default, per-workspace, draft-only suggester** (mirrors `learn/`'s `ATLAS_LEARN_PROMOTE_DECAY_ENABLED`).
2. **Durable-memory bridge** — **one-way, explicit, per-slot; no write-through cache.** Durable memory (ADR-0020) stays session-local scratch; nothing auto-crosses; published facts flow back to sessions via `searchBrain`, never re-hydrated into durable memory (which would collapse T3's boundary and bypass the T4/T5 gates). **ADR-0020's boundary is respected, not moved.**
3. **Provenance** — **lazy session-episode materialization.** A session becomes a tier-3 raw episode only at propose-time (by-reference per T3 where the source is already stored); the candidate `derives-from` it (satisfying no-provenance-no-promotion) and inherits the session's ACL context as the T5 grant seed — defaulting to the **narrowest defensible audience** (the actor plus what the source episode already carried), never a silent `[org]`; widening happens only at the review gate. Eager per-session episoding was rejected.
4. **`learn/` query patterns** — a **distinct class, not tier-2 facts.** Procedural knowledge, not SPO claims under T4; it keeps its own lifecycle, and its authoritative escalation points at the semantic layer / glossary ("metrics are authoritative"), not the fact graph. Write-back's scope is conversational/durable-memory insights → facts.
5. **Corroboration** — reuse T6's dedupe verbatim: re-proposal strengthens (adds a provenance edge, weighting **distinct** sources so self-echo is idempotent), never duplicates; the distinct-source count is surfaced to the reviewer.

## Sequencing & re-aim guide (T10 — the handoff)

### The thin end of the wedge

**Retrieval-fronted thin vertical slice.** The substrate-first vs retrieval-first binary is a trap: retrieval leads because the adoption gap is UX/trust (T1), but `searchBrain` over *only* today's KB + episodes ships a hollow, empty-middle-tier surface — "searchKnowledge renamed," the "worse Glean" trap. So the first post-launch milestone ships `searchBrain` **backed by a deliberately minimal substrate slice** (one chat connector → episodes → extraction → tier-2 facts + review gate + minimal ACL) that fills the middle tier and proves *"authoritative company facts, on infra you control"* end-to-end on one source. The ordering principle is **thin-loop-first, then widen and deepen.**

### In-flight ADR disposition

Edit an in-flight ADR only where this work breaks one of its decisions — an asymmetry that is itself T1's "assembly, not invention" at the ADR layer:

- **ADR-0028 (KB) — amend in place.** The only broken invariant: its flat "descriptive-only" line, for the fact class (T3). The KB pillar itself stands, so **not superseded**. The amendment (a dated forward-pointer block on ADR-0028) **lands with M1**, not with this ADR.
- **ADR-0020 (durable memory) — untouched.** T9's write-back respects the session-local boundary; the change is additive. Inbound cross-reference only.
- **ADR-0030 (connectors) — untouched.** T6 reuses the engine verbatim and forks the ingest core; this ADR documents the fork point. No edit to ADR-0030.

### Re-aim "starting now"

Launch (v0.1.0, target July 2026) is essentially now, at v0.0.58 — so re-aim is **guardrail-heavy, prep-light**. Allowed before launch = opportunistic seam-shaping only, zero net-new brain code:

- Keep ADR-0030's reusable engine **separable** from its fact/KB-scoped subtractive-upsert half whenever that code is touched (so the episode fork is clean later).
- Keep the KB lifecycle (review gate / mirror / `ingest-bundle.ts`) **class-agnostic** whenever touched — don't hard-code "KB-doc-only" assumptions.
- **Reserve the vocabulary** (*episode / fact / trust-tier*) in new schema comments and docs.

Must **not** start yet: any substrate table/column (T3/T4), the ACL primitive (T5), the extraction pipeline (T6), `searchBrain` fusion (T7), `proposeFact`/write-back (T9), the public `searchKnowledge` → `searchBrain` rename (contract cost + premature signal — it ships *with* M1), and any new connector class.

**The test for any borderline case:** *allowed iff it is work you would do anyway on in-flight KB/connector code, merely done with the brain's seams in mind. Net-new code that exists only for the brain is parked until v0.1.0 ships.*

### The milestone cut

All post-v0.1.0; version numbers assigned at kickoff (each is ≥ one minor tag; large ones span several patch tags); tag-named per [ADR-0009](./0009-tag-organized-roadmap.md).

| Milestone | Scope | Proves |
|---|---|---|
| **M1 — Thin wedge slice** | Minimal substrate (`episode`/`fact`/`edge`, T3 schema + T4 temporal columns, *not* the conflict machinery) · one **chat** connector → episodes · one async extraction stage (BYO-LLM-key) · entry-point-agnostic reconcile stage (connector entry wired) · minimal ACL + fail-closed push-down predicate (T5) · KB review gate reused for facts · **`searchBrain`** FTS-first fused trust-labeled read (T7). **ADR-0028 amendment lands here.** | The wedge, end-to-end, on one source. Deliberately the largest single milestone — a vertical slice can't subdivide without shipping something unprovable. |
| **M2 — Temporal & conflict depth** | T4 complete: bi-temporal `asOf` · `in-tension-with` clustering (surfaced-both) · `correct_fact` + four verbs · predicate cardinality. | Hardens the trust claim — staleness is the moat. |
| **M3 — Source breadth** | T6 class expansion: transcripts → email → docs/wiki/code/drive, class-major, plugin-shaped · webhook fast-path for chat. | Breadth — deliberately *after* trust. |
| **M4 — Retrieval depth** | T7 full: embeddings + RRF + optional rerank behind BYO-provider · query-expansion. FTS-only stays the floor. | Retrieval quality on the surface everyone touches. |
| **M5 — Write-back** | T9: `proposeFact` · lazy session-episode materialization · corroboration reuse · opt-in off-by-default autonomous draft-only suggester. | The compounding self-improvement loop. |
| **M6 — /ee governance & scale** | T8 advanced: advanced approval (quorum/SoD/SLA/masking) · advanced ACL / label taxonomy / SCIM audience-sync · managed embedding endpoint · fact residency · audit-retention. | The monetization layer — last by construction. |

**The ordering is the strategy.** Two load-bearing choices: **M2 (trust depth) before M3 (breadth)** is "claim trust, concede breadth" rendered as sequence; **M6 (/ee) dead last** is T8's "no capability is /ee-gated" — the complete, self-hostable brain (M1–M5) ships before any monetization convenience exists. Through-line: **trust before breadth before monetization; every milestone independently ships and leaves the self-hosted brain capability-complete.**

## Consequences

- The brain is mostly assembly of already-correct decisions: exactly one in-flight ADR (0028) has a broken invariant; 0020 and 0030 are respected and reused. This is the "reframe, not rebuild" thesis visible at the ADR layer.
- The three trust tiers are a permanent product invariant, not an implementation detail — every retrieval result and every UI surface must carry the tier label, or the wedge (trust over breadth) is invisible and the "worse Glean" trap re-opens.
- The human review gate is now load-bearing beyond the KB: it is the conflict-resolution mechanism (T4) and the write-back exit (T9). Its throughput and UX become a first-class concern the moment M1 ships facts at connector scale.
- No brain capability may ever migrate to /ee (T8's governing test). Future pressure to gate "always-on" or "managed embeddings" as capabilities must be refused; only convenience/governance/scale wrappers are /ee.

## What this defers (deliberately fog)

Named here so nobody graduates them into build tickets *from this ADR*:

- **The agent-team / AI-employee model** (named role-agents vs configurable team; composition with the agent loop, scheduler, proactive chat) — the downstream thesis that *justifies* the brain, sequenced separately after the brain proves out. This ADR names it as the upside, not a commitment.
- **First work-loops / proof use-cases** (daily briefing, customer report, transcript→issue).
- **Eval strategy** (LoCoMo / LongMemEval-style plus Atlas's own framework). T4 created a natural hook — LongMemEval's "Knowledge Updates" task tests exactly the temporal model — but eval spans the whole brain, not one milestone.

## References

- Wayfinder map: [#4755](https://github.com/AtlasDevHQ/atlas/issues/4755) — the full grilling record for every decision below.
- Decision tickets: [T1 research](https://github.com/AtlasDevHQ/atlas/issues/4756) · [T2 wedge](https://github.com/AtlasDevHQ/atlas/issues/4757) · [T3 substrate](https://github.com/AtlasDevHQ/atlas/issues/4758) · [T4 temporal](https://github.com/AtlasDevHQ/atlas/issues/4759) · [T5 access control](https://github.com/AtlasDevHQ/atlas/issues/4760) · [T6 ingestion](https://github.com/AtlasDevHQ/atlas/issues/4761) · [T7 retrieval](https://github.com/AtlasDevHQ/atlas/issues/4762) · [T8 open-core](https://github.com/AtlasDevHQ/atlas/issues/4763) · [T9 write-back](https://github.com/AtlasDevHQ/atlas/issues/4764) · [T10 sequencing](https://github.com/AtlasDevHQ/atlas/issues/4765).
- Landscape research: `.claude/research/4756-company-brain-landscape.md`.
- Builds on: [ADR-0028](./0028-knowledge-base-fourth-pillar.md) (KB) · [ADR-0020](./0020-durable-agent-sessions.md) (durable sessions) · [ADR-0030](./0030-knowledge-sync-connector-seam.md) (connector seam) · [ADR-0022](./0022-cross-group-reach-llm-composition.md) (cross-group reach) · [ADR-0024](./0024-regional-identity-isolation.md) (residency) · [ADR-0013](./0013-db-stored-plugin-datasource-connections.md) (plugin datasources) · [ADR-0009](./0009-tag-organized-roadmap.md) (tag-organized roadmap).
