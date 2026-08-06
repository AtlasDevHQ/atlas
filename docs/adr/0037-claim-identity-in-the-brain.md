# ADR-0037 — Claim identity in the brain

- **Status:** Accepted
- **Date:** 2026-08-03
- **Amends:** [ADR-0036 §T4](0036-atlas-as-company-brain.md) — the arbitration section
- **Map:** [#5004](https://github.com/AtlasDevHQ/atlas/issues/5004) (T1–T12). Each section below states a decision; the linked ticket carries the argument, the counter-cases, and the accepted costs.

## Context

Two contradictory `Business tier` prices coexist in prod with no `in-tension-with` edge, because the extractor emitted `priced at` once and `is priced at` five minutes later ([#5000](https://github.com/AtlasDevHQ/atlas/issues/5000)).

Exact-string identity is load-bearing in **three** consumers, not one:

| Consumer | Module | What silently no-ops |
|---|---|---|
| `TENSION_CANDIDATES_SQL` | `lib/brain/reconcile.ts` | the advisory `in-tension-with` edge |
| `CORROBORATION_LOOKUP_SQL` | `lib/brain/reconcile.ts` | provenance-strengthening — mints a duplicate row instead |
| `supersessionCollisionJoin` | `lib/content-mode/adapters/brain-facts.ts` | promote-time supersession, the oversight disclosure, **and** the publish preview |

The third changes the severity story: a reviewer who *already knows* about the contradiction still cannot fix it, because promoting the corrected fact will not stamp the old one's `valid_to`. ADR-0036 §T4's human-as-invalidation-authority is **unreachable through the UI**, not merely un-prompted.

The identity model is decided **at the reconcile seam and is source-agnostic** — producers supply claims, never matching rules.

## Decision

### 1. The identity key ([T3](https://github.com/AtlasDevHQ/atlas/issues/5007))

```
key = alias( lexicalNorm( surface ) )
```

Materialized at the reconcile seam, never re-derived by a consumer. One namespace (norms), not norm-vs-id.

- **`lexicalNorm`** — pure, total, vocabulary-free, offline: case-fold, unify separators, trim, collapse runs. **Nothing else.** No stemming, no lemmatisation, no copula-stripping — the corpus's `led_by`/`leads` are *inverse* relations any stemmer would collapse, and over-match at a join arm is the irreversible direction.
- **`alias`** — the curated workspace vocabulary, rewriting one norm to another canonical norm. Defaults to identity.

**Consequence: #5000's own fix is a vocabulary entry, not a normalization rule.**

**Columns.** `subject_key`, `predicate_key`, `object_key` are `NOT NULL`. The **surface** columns are never rewritten — retention is what makes an alias reversible, and the FTS vector keeps reading the surface so a vocabulary edit cannot silently re-rank `searchBrain`.

**Index cost is zero net new**: repoint and tighten `idx_brain_facts_subject` to `(workspace_id, subject_key, predicate_key) WHERE invalidated_at IS NULL AND valid_to IS NULL`.

### 2. One relation, three-valued agreement ([T2](https://github.com/AtlasDevHQ/atlas/issues/5006))

One shared **slot** relation `(subject, predicate)`, composed with a **three-valued agreement** on the object. Both destructive operations demand **positive evidence**; the `unknown` band falls to tension alone.

| Column | Null | Proves |
|---|---|---|
| `object_key` | no | *sameness* |
| `object_cmp` | **yes** | *difference* — a typed canonical value, parsed **fail-closed** |
| `subject_cmp` | **yes** | *difference* — **inverted polarity**, see §5 |

- **same** — `object_key` equal, **or** both `object_cmp` non-null and equal
- **different** — both `object_cmp` non-null and unequal
- **unknown** — everything else → **tension only, never a stamp**

A type qualifies for `object_cmp` only if its parse is unambiguous and its equality decidable. Bare `$499` parses to NULL — `$` is ambiguous across currencies. **The design is safe even when the parser is cowardly.**

**Amended by [#5030](https://github.com/AtlasDevHQ/atlas/issues/5030) (shipped):** `object_cmp` landed as one nullable `TEXT` column (migration 0191, `lib/brain/object-cmp.ts`) holding a **tagged** canonical value — `money:USD:499`, `number:499`, `date:2026-08-04`, `time:…Z`, `bool:true`, `entity:01J…`. Four refinements to the rule as written above, each with a reason the spec could not have anticipated without an implementation:

- **`different` additionally requires the two values to share a TAG.** The rule as stated — *both non-null and unequal* — calls `number:499` and `money:USD:499` different, and nothing proves the bare number is not dollars. Cross-tag is `unknown`. The pair is reachable the moment one producer declares a slot's type and another does not, which is precisely what the producer declaration below is for. Spelled once, in `comparableDifferentSql`, as a `split_part(v, ':', 1)` equality beside the `<>` — plus a membership test against the tag vocabulary and a `strpos(v, ':') > 0` arm on both operands, because `split_part` returns the WHOLE STRING for a separator-less value, so a bare tag name (`'entity'`) otherwise reads as provably different from every real value of its type. Unreachable from the parser; reachable from #5035's importer, which is the second writer of this column.
- **The tag is a contract, not an encoding detail.** [#5035](https://github.com/AtlasDevHQ/atlas/issues/5035) discriminates store-local ids from value-typed canonicals on it — §8's *"null wherever it holds a store-local id"* is unimplementable without one.
- **`date` and `time` are separate tags.** A calendar day and an instant are not the same kind of thing; sharing a tag would make a daily-granularity producer supersede an instant-granularity one on every observation. Instants canonicalize to UTC, so a zone conversion is never a contradiction.
- **⚠️ Proven difference VETOES sameness, because `same` and `different` as stated above are NOT disjoint.** `lexicalNorm` treats `-` as a separator and trims it, so `-499` and `499` produce the SAME `object_key` while their comparable values are `number:-499` and `number:499` — same tag, unequal, provably different. Under the rule as written the key arm fires *same*: corroboration merges the two rows, the second claim never gets a row, Atlas records one more piece of evidence for the opposite-signed belief, and the rival scan never runs. That is [T2](https://github.com/AtlasDevHQ/atlas/issues/5006)'s own *"corroboration merges two distinct beliefs into one row … Silent, unattended, no human in the loop"*, reached through the arm nobody changed, and a signed number is exactly what a warehouse producer emits for a margin or a variance. So corroboration is `(key equal OR value equal) AND NOT provably-different`, and the three verdicts are disjoint by construction rather than by assumption.

Also, and stated because a list is the thing this ADR otherwise refuses: **the currency check is an explicit ISO-4217 SET, not a three-letter shape test.** A shape test is an accept-everything rule with 17,576 entries — `12 mos` → `money:MOS:12` and `1 yrs` → `money:YRS:1` share the `money` tag and read as *provably different*, one contract length against the same contract length. The symbol allowlist §2 refuses is refused because being wrong there makes an ambiguous surface PARSE (a stamp); being wrong in this list makes a well-formed surface ABSTAIN (a missed supersession, repaired by adding the code). Residual, irreducible: some codes are ordinary abbreviations (`KGS` is both the Kyrgyzstani som and kilograms), so `10 kgs` reads as money — wrong about the type, right about the verdict.

The producer declaration (`FactCandidate.objectType`, on `predicate_cardinality`'s precedent) **narrows and never overrides**: it may supply a currency the surface lacks (`499` + declared USD → `money:USD:499` — the case the feature exists for), and every disagreement with the surface resolves to NULL. **No currency SYMBOL is ever accepted**, including `€` and `£`: an allowlist of "safe" symbols is a maintenance surface where one wrong entry buys an irreversible stamp.

**The consequence to state plainly, because it reads as a regression:** with `passthroughEntityResolver` shipped as the default, an entity-valued object (`Ada / reports to / Grace` vs `Alan`) has **no** comparable value on either side and **never supersedes**. Only parseable values do, plus resolved entity ids once [#5031](https://github.com/AtlasDevHQ/atlas/issues/5031) lands. That is the abstain band working, not a gap — the pair still carries its advisory tension edge and a human still arbitrates at the review gate.

**Amended by [#5031](https://github.com/AtlasDevHQ/atlas/issues/5031) (shipped):** "once #5031 lands" is the wrong milestone — that issue built the batched, role-less **seam** (`EntityResolver`: one call per episode over the deduplicated subject and object surfaces, absent key = abstain, `ResolvedEntity` collapsed to an id). Resolved entity ids arrive the day a workspace injects a real **store**; the shipped `passthroughEntityResolver` abstains on everything, so the consequence above is unchanged by the seam landing. The same issue split abstain from failure — an honest "no entry" sets no flag, and a **failed** batch withholds `object_cmp` from the ROW while keeping the surface parse for the two lookups, so an outage can neither manufacture a `valid_to` stamp nor disable `objectSameSql`'s difference veto.

### 3. Cardinality is a property of the predicate ([T6](https://github.com/AtlasDevHQ/atlas/issues/5010))

`predicate_cardinality` was **not** unpopulated, as previously believed. `extract.ts:484` writes the model's per-claim guess and `correction.ts:1380` inherits it — so supersession fired at roughly P(model says `single`)², from **two independent model calls**, against a prompt biased toward `multi`. A **fourth independent cause** of #5000's symptom, and the only one that is not a string-matching problem.

- Cardinality attaches to the **canonical predicate**, carried by the vocabulary and **read live** — it has exactly one load-bearing consumer, so there is no seam to drift.
- **The both-sides clause is deleted.** Two rows in one slot can no longer disagree, because they no longer each carry an opinion.
- The row column is **dropped**; the extractor's guess becomes a non-load-bearing provenance hint.
- **`single` requires positive evidence.** Absent → `multi`; ambiguity → `multi`. A predicate whose cardinality depends on the subject's type (`located in`) is simply never marked `single`.
- Three sources may declare it: **warehouse structural**, **correction events** (a human correcting a slot asserts by action that it holds one value), and direct authoring.

**We under-supersede deterministically rather than supersede stochastically.**

**Shipped by [#5027](https://github.com/AtlasDevHQ/atlas/issues/5027)** — migration 0192, `lib/brain/cardinality.ts`. Four notes where the implementation is more specific than the decision above, or where it deliberately fell short of it:

- **The row column is not dropped yet.** `brain_facts.predicate_cardinality` is `NOT NULL` with a live CHECK, so #5027 stops *reading and writing* it — it leaves `INSERT_FACT_SQL`'s explicit column list and falls to its schema default — and [#5028](https://github.com/AtlasDevHQ/atlas/issues/5028) drops it one release later, per the two-phase discipline. Read *"the row column is dropped"* above as the destination, not as the state after #5027.
- **The extractor's guess kept ONE consumer**, which "non-load-bearing hint" is meant to permit and is worth naming: it still gates the advisory `in-tension-with` edges at ingest, and it now rides in provenance as `cardinalityHint`. It reaches no `valid_to` stamp. A tension edge is recoverable in both directions, which is exactly what an LLM guess is worth; the correction path stopped *inheriting* one and derives `single` from the verb instead.
- **Source 2 PROPOSES; it does not declare.** §3(d) left open whether a correction event may write without a human, and §6's auto-approve arm is reachable only at an *entity* position — a predicate is not one — so the repeat-gated proposer writes `status = 'pending'` and `cardinalitySingleSql` reads only `approved`. The store is one relation with a status rather than the two 0190 uses, and the difference is argued at 0192's header: neither of 0190's reasons for splitting reaches a table with no closure and one status-filtered reader.
- **The repeat gate has a second arm the decision did not name**, and it is what makes §3(d)'s typo risk *measurable* rather than merely acknowledged: it counts **distinct subjects**, and only supersessions whose replacement is **provably different** from what it replaced (§2's `object_cmp`). Two entity-valued names are `unknown`, never *different*, so `Bob` → `Bobby` does not count — and neither does the genuine replacement `Bob` → `Carol`, which is accepted because such a pair cannot supersede at the publish gate either. **The residual stands:** a fat-finger on a comparable value (`499` → `4999`) is provably different and does count. It raises a proposal, a human reads it, and that is the whole mitigation.

### 4. Cross-tier collision ([T4](https://github.com/AtlasDevHQ/atlas/issues/5008))

A warehouse predicate becomes collidable by being **an ordinary surface on an ordinary stored row**. Live tier-1 never enters the model — only the snapshot-pinned `brain_facts` row is collidable.

- The producer emits the **bare** dimension/measure name or metric id; qualification rides non-load-bearing in provenance; it **fails closed** on a dimension name ambiguous across the entities it produces from.
- **Cross-tier collision is tension-only in both directions.** "Warehouse-wins" is a surfacing hint, not a mechanism — this **corrects** #4759 §3 item 1's *"gone by construction"* rather than implementing it.
- **Identity is source-agnostic; *consequence* is tier-ordered.** `supersessionCollisionJoin` gains a tier guard: a draft may not stamp `valid_to` on a published warehouse-derived fact. It goes **inside** the join, never at a call site, so the disclosure, the preview and the transaction cannot disagree about the pair — all three drop it, and publish logs a count of what it held back. **Shipped in #5033** (`supersedableTierSql`), and four properties of the shipped guard are decisions rather than details:
  - **Symmetric** — applied to the draft alias as well as the published one, per the bullet above; warehouse↔warehouse re-emission is therefore also tension-only, which is the Fog #5008 records rather than a gap.
  - **An allowlist over the source vocabulary, not `<> 'warehouse'`.** An unresolvable kind (`warehouse:prod`, `snowflake`) is held back too. `isWarehouseDerivedSource` answers `false` for one, and the region import is the one producer with no vocabulary gate — this is #4964's conclusion arriving where the consequence is a `valid_to` stamp instead of a lost correction refusal. The list is derived from `EPISODE_SOURCE_SPECS`'s declared classes, so a future warehouse-class member inherits the guard with no second edit.
  - **A provenance carrying no `source` key at all still supersedes** — the same carve-out `correction.ts` makes for the correction path, for the same reason: retiring it would break facts no import ever touched. The residual (deleting `source` from a bundle evades both gates) is the one the record already accepts.
  - **A held-back pair is counted, logged and audited — never merely absent.** All three surfaces — disclosure, preview, transaction — drop it, so they still agree; what would otherwise be lost is the *distinction*, since an empty `superseded` reads identically to "nothing collided". `promoteBrainFacts` therefore also asks the collision's complement (`TIER_HELD_BACK_COUNT_SQL`, behind a savepoint so a diagnostic can never roll back a publish), logs it, and carries it to `admin-publish.ts`'s durable audit row. The tension edge is where a human arbitrates; this count is how anyone learns there was something to arbitrate — which matters because a post-ingest re-key or the `TENSION_EDGE_CAP` fan-out bound can leave a held-back pair with no edge behind it.
- **No reserved roots** — a warehouse norm may itself be aliased.

**Aliases are proposed by the seam from structural evidence** — same `subject_key`, equal non-null `object_cmp`, differing `predicate_key` — repeat-gated. **Lexical near-miss detection is prohibited**: it ranks `led_by`/`leads` first, and approving that stamps `valid_to` across the manager graph.

> **Correction to the record.** The seam's structural proposal covers *restatement* collisions and **cannot** cover *contradiction* collisions. #5000's own pair disagrees on the object (499 vs 599), so the proposal query returns **nothing** for it. #5000's vocabulary entry arrives through direct human authoring (§6).

**Amended by [#5034](https://github.com/AtlasDevHQ/atlas/issues/5034) (shipped):** the query is `ALIAS_PROPOSAL_SQL` in `lib/brain/alias-proposal.ts`, a self-join on `idx_brain_facts_subject` with no new index, feeding `proposeAliasEdges` as `source_class: 'seam'`. Seven things the decision above did not carry, each stated because a reader would otherwise assume the opposite:

- **The repeat gate counts DISTINCT SUBJECTS, and the threshold is two.** Distinct subjects because a pair is a claim about two *predicates* and only variety across subjects makes it that — one company with two offices produces two agreeing evidence rows and tells you nothing about whether `located in` and `has office in` name one relation. Two rather than `CORRECTION_REPEAT_THRESHOLD`'s three, on T3 §1's Pattern-identity precedent, and the difference is in the evidence rather than the appetite: a correction event is circumstantial where agreement-without-a-slot is positive and typed. **Its honest cost is stated rather than designed away** — two companies founded and incorporated in the same year still reach the queue, and the human is the filter.
- **Direction reads a POSITIVE warehouse allowlist (`WAREHOUSE_SOURCES`), never the negation of §4's tier guard.** The two lists do not partition a *stored* value: an unclassifiable kind (`warehouse:prod`) falls out of both, and negating `supersedableTierSql` would read it as warehouse-derived — evidence of nothing becoming evidence of a direction, at the one decision that picks the canonical target of a workspace-wide re-key. Unclassifiable on either side therefore yields an **undirected** candidate, which routes the choice to a human. **Both-warehouse is undirected too**: the rule is *exactly one*, and with two closed spaces nothing in the evidence prefers one.
- **The hint seam ships as a RANK, and what enforces that is named precisely.** `hintedRank` is the only function that reads a hint and it returns a `number`, so nothing hint-consuming has a list to append to; `applyHintRanks` is `candidates.map(…)` over the query's own output. ⚠️ **It is NOT closed by the type, and the first draft of this bullet said it was.** A reviewer compiled the counter-example: `candidates` is a reassignable parameter, TypeScript cannot express *"the same members"*, and branding the destination is unavailable because `AliasProposalInput` must stay open for human-authored proposals. What the type does buy is that `AliasRankHint` carries a `norms` TUPLE rather than `fromNorm`/`toNorm`, so a hint is no longer structurally an `AliasCandidate` and cannot be spread into one. **The falsifier of record is the `an extractor hint may become a candidate` row in `scripts/mutations/alias-proposal.md`** — do not delete it as redundant with a compile-time guarantee that is not there. The bonus is held below one step of the structural curve, so a hint may re-order two equally-supported pairs and may never lift a two-subject pair above a three-subject one.
- **The producer is bounded TWICE, and neither bound is sufficient alone.** The trigger is `await`ed inside the extraction drain's `concurrency: 1` loop with no per-tick timeout, so a call that never SETTLES would stop the whole brain-extraction fiber forever, with no error to catch and no dead fiber to log. `boundedTransaction`'s `SET LOCAL statement_timeout` / `lock_timeout` make Postgres CANCEL rather than abandon, which is what reclaims the pooled connection — `Promise.race` cannot, as `correction.ts`'s `proposeUnderDeadline` records. ⚠️ **But `withBrainTransaction` issues `BEGIN` BEFORE the callback, so those settings cannot bound their own arrival, and against the failure they exist for they never land** — `ALIAS_PROPOSAL_DEADLINE_MS` in `extract.ts` is the only thing that lets the drain advance. That advance is itself a hazard and is bounded in turn: a stall preceding the first `SET LOCAL` leaks the connection it held, so the first timeout in a tick trips a per-tick breaker and later episodes skip the trigger — one leaked connection per cycle instead of one per episode, out of a pool of five. Read `ALIAS_PROPOSAL_CANDIDATE_CAP` for the matching correction: `LIMIT` bounds the QUEUE and not the scan, because it applies after `GROUP BY`.
- **The trigger is `reconcileFacts`'s new `ReconcileReport.comparable`, from the ingest drain only.** The candidate set is a pure function of the rows carrying a non-null `object_cmp`, so an episode that created none provably cannot have changed it — skipping is lossless rather than sampled, and today it skips nearly always, which is the honest shape of *on day one it returns zero rows*. ⚠️ **That trigger is the producer's ONLY caller, so "re-derived next run" is weaker than it sounds**: there is no scheduler fiber and no admin re-run verb, so a failed run's candidates wait for another comparable-creating episode in that workspace, which may not arrive. Stated rather than softened because the first cut's log line promised *"nothing is permanently lost"*. A low-frequency `registerPeriodicFiber` sweep is the durable floor and is deliberately out of this slice — it is a second trigger with its own enablement, cadence and audit questions. **`correction.ts` is not wired either**, on the same terms.
- **The proposal is at the PREDICATE position only, so it can never auto-approve.** `autoApproveEligible` refuses every non-entity position before it reads the threshold — which is what makes it safe for the rank to move at all.
- **The `predicate_key` projection is an exemption to §6's *keys are never projected to the wire*, and a narrow one.** What that rule protects is a key *beside its claim*; this query returns two norms and a count — no fact id, no surface, no row — and norms are what the vocabulary is made of. `keys-not-on-the-wire.test.ts` carries the entry and `alias-proposal.test.ts` carries the compensating pin that `subject_key` stays an aggregate input.

The falsification is `alias-proposal-corpus.ts` over `alias-proposal-pg.test.ts`, on §9's terms: 14 cases, every prohibition paired with a firing control, and `inverse-relations` carrying its control *inside its own workspace* because a query returning the empty set satisfies every prohibition in the file. `scripts/mutations/alias-proposal.md` is the measured table.

### 5. Subject/object identity ([T5](https://github.com/AtlasDevHQ/atlas/issues/5009), [T12](https://github.com/AtlasDevHQ/atlas/issues/5017))

**The entity store is brain-owned, workspace-scoped, internal-DB-resident.** The semantic layer's glossary and entities are **inputs**, never the store — they are type-level where the brain names instances, `connection_group`-scoped where the brain is workspace-scoped, and unjoinable as YAML.

> **General rule, derived twice: the brain never reads tier-1 live, at any position, for any purpose.**

**The store's slot-side contribution *is* an alias edge**, so it is not consulted at reconcile time for the slot at all. The injected resolver survives at the `_cmp` positions only: `surface → stable id`, **batched per episode**, absent-means-abstain, **globally-unique ids**. `ResolvedEntity.canonical` retires; the resolver never rewrites a surface column. **The store may do nothing clever at read time** — no fuzzy matching, no embeddings, no LLM disambiguation. Every equivalence is a precomputed, approved edge.

**Subject homonymy is a confidentiality limit, not an advisory one.** `CORROBORATION_LOOKUP_SQL` is the only consumer with **no grant arm and no cardinality arm**; it attaches a public episode as evidence to a private fact, and publish then **overwrites `visible_to` with the union of evidence grants**. Homonymy falsifies the safety argument at `promotion.ts:348-350` (*"a reader of either already saw it said"*) — **the claim was not stated in B.**

- `subject_cmp` is nullable, resolver-supplied, and **inverted**: non-null and unequal ⇒ *not the same slot* ⇒ suppress **corroboration, tension, and supersession alike**. It is **not** a mirror of `object_cmp`.
- Accepting was never a deferral: the vocabulary is a **function on surfaces**, and no function on surfaces maps one surface to two referents.
- **Honest limit:** only a warehouse-backed subject can supply one. The extracted↔extracted homonym — the case that occurs today — stays accepted, guarded by a **review-gate widening disclosure fired only when `added` is non-empty**.

**Failure semantics.** Block-vs-flag is reaffirmed: a quality failure never drops a candidate. But abstain and failure **split** — an honest no-entry abstains **silently**; only an outage sets `provisional`, whose one remaining job is ***"this row's keys are worth recomputing."***

**Amended by [#5031](https://github.com/AtlasDevHQ/atlas/issues/5031) (shipped):** read *"this row's keys are worth recomputing"* as the pre-implementation formulation. The shipped flag means this row's **`object_cmp`** is worth recomputing and explicitly **not** its keys — the resolver reaches no key at any position, so a replay recomputes those to the same bytes under the same vocabulary. Two more clauses the spec did not carry: the trigger widened from "an outage" to **the store did not ANSWER**, which includes a **contract violation** (a blank or non-string id, a key that is not a requested surface, a duplicate key, more entries than surfaces requested) — those change on replay exactly as an outage does, and that is the criterion. And the marker is **not total**: a candidate that CORROBORATES writes no provenance payload, so it carries no flag; its `provenance` edge to the episode is how those facts are found.

**Amended by [#5032](https://github.com/AtlasDevHQ/atlas/issues/5032) (shipped):** migration 0193 adds `subject_cmp`; `lib/brain/subject-cmp.ts` owns its one arm and all three consumers take it unchanged. Five things the decision above did not carry, each stated because a reader would otherwise assume the opposite:

- **The value comes from a resolved entity id and NEVER from a parse of the surface.** `subjectComparableValue` takes an id, not a surface — the signature is part of the guard. Routing the subject through `comparableValue` would make *"the extractor can never supply one, for any subject, ever"* false in the tree, which is the same class of defect this slice corrects at `widenGrantFromEvidence`. It also buys almost nothing: the column is only consulted where the subject KEYS already matched, so a parse changes a verdict only for surfaces that normalize together while parsing apart (`-499` / `499`) — and there the failure it buys is a SUPPRESSED corroboration, the direction nobody can report.
- **The arm is spelled once, as `(comparableDifferentSql(…)) IS NOT TRUE`, and there is deliberately no positive counterpart.** No consumer asks *"are these provably the same subject?"* — the slot keys answer that — and adding a `subjectSameSql` would invite restoring `object-cmp.ts`'s two-arm symmetry, which is where the inverted polarity gets lost. `IS NOT TRUE` and never `NOT (…)`: `NOT NULL` is NULL and a `WHERE` treats that as false, so the readable spelling suppresses every claim whose subject has no comparable value — at this position, nearly the whole corpus.
- **The suppression lives in `collisionCorePredicate`, not beside the tier guard.** A homonym pair never collided, so it must not appear in `TIER_HELD_BACK_COUNT_SQL` or `CARDINALITY_HELD_BACK_COUNT_SQL` as *"curate this and it will supersede"* — a claim no vocabulary edit or tier change could make true.
- **There is no at-rest/lookup split, unlike `object_cmp`.** That split exists because an outage's surface FALLBACK can out-prove the id it replaced; there is no fallback here, so a failed batch yields `null` at every site — which suppresses nothing, i.e. exactly the pre-#5032 behaviour.
- **The disclosure is reader-scoped with NO `withheld` counterpart**, and the asymmetry with `willSupersede` is a stated gap rather than an oversight. Counting the widenings a reader cannot see means running the grant grammar over other readers' episode grants, which `oversight.ts`'s no-unscoped-content rule forbids and which a SQL restatement of that grammar would answer wrongly. So an empty list means *"none that you can see"*, never *"none"*; `PromotionReport.widened` covers the rest, one moment too late to be notice.

**Accepted cost, unchanged and now visible in the product:** nothing distinguishes the homonym from the honest corroborations in that list. A reviewer told *"publishing widens this to `org`"* can publish or not.

### 6. The vocabulary ([T11](https://github.com/AtlasDevHQ/atlas/issues/5016))

**Workspace-scoped — a derived invariant, not a choice.** All three identity consumers already carry no grant arm, and grant-scoping would need `alias(norm, reader)` when keys are materialized by a fiber that has no reader. *(Cost, named as a cost: the vocabulary is the one piece of brain state with no ACL, permanently. Per-team terminology is refused by this decision, not merely unimplemented.)*

**The leak is accepted, in a corrected form.** The private codename is **not** inferable — for a reader to observe a merge, both facts must already be visible. What leaks is one bit of a relation, plus a new withheld-handle on a public fact. The vocabulary changes the **rate** of three deliberate disclosures, not their nature. Two pins:

1. **The declined surface rewriting (§5) is *why* this stays one bit.** "Just show the canonical name" is a **privacy** regression, not only a reversibility one.
2. **Keys are never projected to the wire.** No read surface may select a key or `_cmp` column. A prohibition, not an omission.

**Authority: `decideAmendment`'s shape, not the publish gate.** An alias is not a `brain_facts` row and has no `status`, so ADR-0036's *"there is no approve verb here, and that is the design"* does not transfer. Warehouse-derived entity edges backed by a primary key may **auto-approve**; extractor-derived and seam-proposed edges always **queue**. **#4507's permanent rejection memory** stops a producer re-writing what a human removed.

**The vocabulary is two relations, not one.** T3 §8's forest invariant was self-contradictory (depth-1 *and* composing), and its only fix — path compression — **destroys the reversibility T3 called the sole thing that makes a bad alias undoable**. So:

| | What it is |
|---|---|
| **Approved edges** | the human's decisions; at-most-one-parent; never rewritten by another approval |
| **Effective target** | the transitive closure — what `alias` reads |

Removal becomes a **recomputation**, and `alias` is a function by construction. **Position-scoped**, else a *predicate* approval re-keys *subjects* workspace-wide.

**Proposal visibility is positional**; the blast-radius preview reuses the #4912 disclosure shape (unscoped total, reader-scoped pairs gated on **both** sides, `withheld = total − scoped`), widened by §3 to cover **newly-supersedable**, not merely newly-colliding. **Direct human authoring is admitted**, on the owner/admin entitlement.

**Amended by [#5025](https://github.com/AtlasDevHQ/atlas/issues/5025)'s design pass (2026-08-05), before implementation.** Three things this section left open and one it got wrong, found by grilling the surface against the schema that actually shipped:

- **The approval surface is ONE queue, and the alias preview must name its target's cardinality.** The two proposal kinds interact in a way neither preview alone discloses: approving `is priced at → priced at` moves that predicate's whole population into a slot where, if `priced at` is curated `single`, supersession is now armed for claims that were safe a moment earlier. Migration 0192's header records the mechanism (*an alias approval MOVES a predicate's population under a different entry*); this records the consequence for the reviewer. An alias preview whose target is curated `single` states that, with the count of pairs the merge arms. Independent previews were the simpler build and would have left the compound case invisible.

- **Direct human authoring writes THROUGH the proposal table**, as a `human`-sourced proposal decided `approved` in the same transaction. §6 admits direct authoring without saying how, and the direct spelling (`approveAliasEdge` straight) has a hole: rejection memory is `approved → rejected` on the proposal row, so a hand-authored edge that is later removed leaves nothing to write it onto — and the next producer run re-proposes the exact pair a human just deleted, which is #4507's failure returning through the one path direct authoring exists to serve. The cost is a queue row that was never queued; the queue read excludes same-transaction-decided rows so history does not render as work.

- **The count in a cardinality-flip preview is a FLOOR, and says so.** It inherits `WILL_SUPERSEDE_TOTAL_SQL`'s deliberate over-statement (it counts colliding live drafts, including ones the promotion classifier will refuse) — kept, because replicating the refusal rules in SQL is the second spelling `oversight.ts` declines. But a flip is not a batch: it applies to every future claim in the slot, so the number is *also* a lower bound that grows. The disclosure reads *"at least N today, and every future claim in this slot"* rather than *"N pairs"*. Precision was available only by paying for the second spelling, and would still have been a floor.

- **⚠️ Correction to [T11](https://github.com/AtlasDevHQ/atlas/issues/5016) §5(b): entity-position proposals cannot be gated on "both evidence rows", because the evidence is not stored.** `brain_vocabulary_proposal` (0190) carries `from_norm` / `to_norm` and no fact ids — deliberately, since 0190 handed the evidence shape to [#5034](https://github.com/AtlasDevHQ/atlas/issues/5034). The producer cannot scope at write time either: it is a fiber with no reader, and one proposal is legitimately visible to one approver and not another. So the rule ships **re-derived at read time**: the queue joins `brain_facts` on the two norms at that position and surfaces the proposal only when the reader's own fail-closed predicate admits at least one row on **each** side.

  That is a different rule, and arguably the better one — what an approver must be able to see is the **populations being merged**, not the two rows that happened to trigger the proposal, which they can never be shown anyway. The intent T11 §5(b) states is preserved (*a private-only equivalence is not surfaced, which is the correct failure*); the mechanism is not. Recorded as a correction rather than a clarification because the ADR's text is unimplementable against the shipped schema, and a reader checking the code against §5(b) would otherwise conclude the code is wrong.

### 7. Migration ([T8](https://github.com/AtlasDevHQ/atlas/issues/5012))

**Backfill at the slot; fix forward at the object.**

- **"Re-reconcile" is structurally unavailable** — `writeCandidate` corroborates first and returns, so a replay never reaches the tension pass. Existing rows get an **admin-triggered, bounded tension sweep**, not a replay.
- Two artifacts: a day-one `.sql` migration (`ADD COLUMN` → `UPDATE` → `SET NOT NULL`, **unscoped by `status`**), and the drift re-key inside the decide transaction.
- **`updated_at` is not touched.** It sorts the publish preview; a workspace-wide re-key stamping it would reshuffle every reviewer's queue into backfill order. *`updated_at` means this claim's content or review state moved; a key recomputation moved neither.*
- **The drift re-key is a sequential scan, not an indexed one** — PG 16 has no skip scan, `predicate_key` is the third index column, and the rewrite must cover the **tombstoned and superseded rows the partial index excludes**, or the re-derive-from-surface undo silently stops working. Correcting the language, not adding the index.
- **`object_cmp` is never backfilled.** The store's arrival must not retroactively manufacture positive evidence of difference on rows a reviewer already saw as `unknown` — and unlike a cardinality flip, an auto-approved producer run has no gate on which to hang a preview.
- The publish path takes **no advisory lock**, so `SUPERSEDE_STAMP_SQL` **re-checks the collision join** (making the UPDATE correct standalone, the module's own redundancy principle), plus a **distinct identity-mutation lock namespace** that does not serialize publish against ingest.
  - **Amended by [#5024](https://github.com/AtlasDevHQ/atlas/issues/5024) (shipped):** the publish path now **does** take an advisory lock — the distinct identity-mutation namespace this line reserves (`IDENTITY_MUTATION_LOCK_NAMESPACE`, 5024, in `lib/brain/identity.ts`), acquired before the drafts are read and bounded by a `SET LOCAL lock_timeout`. The re-check landed as specified and is kept alongside the lock rather than replaced by it, per `DRAFT_FACTS_SQL`'s stated redundancy principle. Read *"the publish path takes no advisory lock"* as the pre-#5024 state that motivated the namespace, not as a property of the shipped system.

### 8. Row-copy paths ([T10](https://github.com/AtlasDevHQ/atlas/issues/5015))

> **A row-copy path carries keys verbatim; a claim-supply path never supplies them.**

Region import and `correction.ts`'s inherit-identity-from-target are **both row-copy** — which is why they agree, and why neither is an exception to *"canonicalization runs at the seam."*

- **Keys travel verbatim** on a v3 bundle. Re-deriving fails to **over**-match (irreversible); carrying fails to **under**-match (recoverable). The importer has no re-derive precedent — every column travels verbatim today.
- **Neither `_cmp` column travels.** A foreign region's store id is non-null and unequal to every local id, making it **counterfeit positive evidence of difference** — strictly worse than NULL, inverting the abstain band at the one position that has one. Both are nulled at import and marked `provisional`; value-typed `object_cmp` travels.
- **`correction.ts` inherits the slot** and derives the object fresh. Without this it stops being the immune producer the moment keys exist — retiring a belief while its successor lands in a different slot, unreachable from the slot every future collision joins on.
- The vocabulary and the entity store are **`exported`** (`stays` is *deletion*). The merge unions **approved edges**, refuses cycle-closing edges, logs refusals, and recomputes the closure — closing a forest hole enforced per-vocabulary but never across the two an import brings together.
- **No per-row vocabulary version stamp.**

**Amended by [#5035](https://github.com/AtlasDevHQ/atlas/issues/5035) (shipped) — the bundle half, as built.** Five things the resolution did not carry, all of which a reader of the code will meet:

- **The discriminator is the MANIFEST, not field presence.** Bundle v3 carries the three slot keys and both `_cmp` columns; v1/v2 carry none, and their facts are keyed once at import. Reading "does this fact have a `subjectKey`?" instead would make a v3 producer that dropped a key indistinguishable from a legacy bundle — and the legacy arm *re-derives*, which is the over-match direction this section refuses. So the five fields are **required** from v3 and **refused** below it, on the same fail-loudly discipline the #4460 pillar sections already had.
- **`alias_dest` is the destination's POST-MERGE vocabulary**, which is why the importer's vocabulary section now runs **before** the brain. Keyed in the old order, the legacy arm would compose only the destination's pre-existing decisions and discard every edge arriving in the same bundle — the half of the merge that exists to be composed.
- **`predicate_cardinality` leaves the format here.** #5027 moved cardinality onto the canonical predicate and the per-row values are LLM guesses, so the exporter stops projecting it and the importer lets the column fall to its schema default. A legacy bundle's value is *accepted and ignored*. The bundle version bumps exactly once across this arc; [#5028](https://github.com/AtlasDevHQ/atlas/issues/5028) drops the database column and does not touch the format.
- **The null-out is keyed on #5030's TAG**, through `regionPortableComparable` — `entity:` is dropped, every value-typed tag travels. It is one rule applied at both positions rather than two rules that happen to agree; at the subject every value the column's own writer can produce is `entity:`, so the effect there is *always NULL*, which is the pre-migration behaviour exactly. A malformed or untagged stored value is also dropped: it would compare unequal to every honest value and manufacture difference out of a string nobody can read.
- **`keys-not-on-the-wire.test.ts` grants the exception by naming three whole files** (`export.ts`, `migration.ts`, `admin-migrate.ts`), because the scan cannot tell a row-copy projection from a new read surface in the same file. That switches **both** of its arms off for those files, and the compensating pin is `bundle-identity-v3.test.ts` — narrower than what the exemption turns off, which is the same trade the `cardinality.ts` and `alias-proposal.ts` exemptions record.

⚠️ **Accepted cost, stated so nobody "fixes" it by dropping the marker.** `provenance.provisional` becomes **non-rare immediately after a migration** — every imported fact whose entity-valued positions were nulled carries it — which dents the *"rare by construction"* argument [#4772](https://github.com/AtlasDevHQ/atlas/issues/4772)'s review filter rests on. The marker is what makes the null-out recoverable rather than merely safe: `object_cmp IS NULL` matches every honest abstain, so there is no key-based way to find those rows without it. The right response to a noisy filter is to recompute the rows, not to stop marking them. The second accepted cost is the one this section already names: every migrated fact's entity-valued positions **abstain** until recomputed, so the destination temporarily cannot supersede across a migrated corpus.

### 9. How this is falsified ([T7](https://github.com/AtlasDevHQ/atlas/issues/5011))

The existing fixtures agree **by construction** — in the `-pg` suites the predicate is a SQL literal in the seeder, not a fixture parameter, and the unit fake answers the corroboration lookup with JS `===`, making it a second implementation of the defect.

- **The eval lane produces the fixture; the deterministic suite consumes it.** Humans author the *messages*; the real extractor supplies the *predicates*; regeneration is a **reviewed commit**.
- **Prerequisite, and it is not test work:** `ANTHROPIC_API_KEY` is **not wired**, and `eval-informational-gate.sh` treats `skipped` as a pass — so the repo's only real-model gate has been **permanently green without ever running**, with a 3-byte baseline. Wire the secret and make `skipped` fatal *before* the lane is trusted.
- **Every prohibition is paired with a positive control** that proves the machinery ran. Most targets here pass green against machinery that does nothing at all.
- **One corpus, three verdicts** — each consumer asserts a different verdict on the same rows, so they cannot drift into disagreeing about what collides.
- **One side of every identity assertion must be a value the system produced, not a value the test wrote.**

The consolidated target list lives in [T7's resolution](https://github.com/AtlasDevHQ/atlas/issues/5011).

## Consequences

**What this fixes.** All three consumers agree on a definition that holds. Corroboration strengthens provenance instead of minting duplicates; tension edges appear between genuinely contradictory claims; and the promote-time join matches, so ADR-0036 §T4's human-as-invalidation-authority becomes reachable through the UI.

**What it does not fix, stated plainly.** **This model does not automatically fix #5000.** The prod pair needs a human to author *both* an alias entry and a `single` cardinality entry, and the seam's structural proposal cannot propose either (§4). The map makes the bug **fixable and detectable**, not fixed.

**What stays dormant.** Warehouse-wins does nothing mechanical; `subject_cmp` is permanently NULL; entity edges have no source; the proposal query returns zero rows — all until a tier-1 warehouse producer exists, which no milestone had scoped.

**Corrections to the record.** #4759 §3 item 1's *"gone by construction"* (§4); `promotion.ts:348-350`'s widening safety argument (§5); T3 §8's *"indexed rewrite"* and its forest invariant (§6, §7); T4 §3's worked example (§4).

## Alternatives rejected

- **The glossary as the vocabulary** ([T1](https://github.com/AtlasDevHQ/atlas/issues/5005)) — a *definition* store with no alias field, type-level and warehouse-anchored, `connection_group`-scoped, and one opaque YAML blob the identity joins cannot join against.
- **Canonical-predicate-at-extraction** — per-producer matching policy in disguise, not reproducible offline, and an extractor asked for a canonical predicate **cannot honestly abstain**.
- **Similarity / stemming / edit distance** — ranks the `led_by`/`leads` inverse pair first, and approving it stamps `valid_to` across the manager graph.
- **Per-source-class identity policy** — makes collision behaviour O(|classes|²) and reopens this ADR at every new connector.
- **Grant-scoped aliasing** — needs a reader at a seam that has none; the cost of closing the leak structurally is named in §6.
