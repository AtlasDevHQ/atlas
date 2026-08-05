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

### 3. Cardinality is a property of the predicate ([T6](https://github.com/AtlasDevHQ/atlas/issues/5010))

`predicate_cardinality` was **not** unpopulated, as previously believed. `extract.ts:484` writes the model's per-claim guess and `correction.ts:1380` inherits it — so supersession fired at roughly P(model says `single`)², from **two independent model calls**, against a prompt biased toward `multi`. A **fourth independent cause** of #5000's symptom, and the only one that is not a string-matching problem.

- Cardinality attaches to the **canonical predicate**, carried by the vocabulary and **read live** — it has exactly one load-bearing consumer, so there is no seam to drift.
- **The both-sides clause is deleted.** Two rows in one slot can no longer disagree, because they no longer each carry an opinion.
- The row column is **dropped**; the extractor's guess becomes a non-load-bearing provenance hint.
- **`single` requires positive evidence.** Absent → `multi`; ambiguity → `multi`. A predicate whose cardinality depends on the subject's type (`located in`) is simply never marked `single`.
- Three sources may declare it: **warehouse structural**, **correction events** (a human correcting a slot asserts by action that it holds one value), and direct authoring.

**We under-supersede deterministically rather than supersede stochastically.**

### 4. Cross-tier collision ([T4](https://github.com/AtlasDevHQ/atlas/issues/5008))

A warehouse predicate becomes collidable by being **an ordinary surface on an ordinary stored row**. Live tier-1 never enters the model — only the snapshot-pinned `brain_facts` row is collidable.

- The producer emits the **bare** dimension/measure name or metric id; qualification rides non-load-bearing in provenance; it **fails closed** on a dimension name ambiguous across the entities it produces from.
- **Cross-tier collision is tension-only in both directions.** "Warehouse-wins" is a surfacing hint, not a mechanism — this **corrects** #4759 §3 item 1's *"gone by construction"* rather than implementing it.
- **Identity is source-agnostic; *consequence* is tier-ordered.** `supersessionCollisionJoin` gains a tier guard: a draft may not stamp `valid_to` on a published warehouse-derived fact. It goes **inside** the join, never at a call site, so the disclosure and the preview show the same held-back pair the transaction skips.
- **No reserved roots** — a warehouse norm may itself be aliased.

**Aliases are proposed by the seam from structural evidence** — same `subject_key`, equal non-null `object_cmp`, differing `predicate_key` — repeat-gated. **Lexical near-miss detection is prohibited**: it ranks `led_by`/`leads` first, and approving that stamps `valid_to` across the manager graph.

> **Correction to the record.** The seam's structural proposal covers *restatement* collisions and **cannot** cover *contradiction* collisions. #5000's own pair disagrees on the object (499 vs 599), so the proposal query returns **nothing** for it. #5000's vocabulary entry arrives through direct human authoring (§6).

### 5. Subject/object identity ([T5](https://github.com/AtlasDevHQ/atlas/issues/5009), [T12](https://github.com/AtlasDevHQ/atlas/issues/5017))

**The entity store is brain-owned, workspace-scoped, internal-DB-resident.** The semantic layer's glossary and entities are **inputs**, never the store — they are type-level where the brain names instances, `connection_group`-scoped where the brain is workspace-scoped, and unjoinable as YAML.

> **General rule, derived twice: the brain never reads tier-1 live, at any position, for any purpose.**

**The store's slot-side contribution *is* an alias edge**, so it is not consulted at reconcile time for the slot at all. The injected resolver survives at the `_cmp` positions only: `surface → stable id`, **batched per episode**, absent-means-abstain, **globally-unique ids**. `ResolvedEntity.canonical` retires; the resolver never rewrites a surface column. **The store may do nothing clever at read time** — no fuzzy matching, no embeddings, no LLM disambiguation. Every equivalence is a precomputed, approved edge.

**Subject homonymy is a confidentiality limit, not an advisory one.** `CORROBORATION_LOOKUP_SQL` is the only consumer with **no grant arm and no cardinality arm**; it attaches a public episode as evidence to a private fact, and publish then **overwrites `visible_to` with the union of evidence grants**. Homonymy falsifies the safety argument at `promotion.ts:348-350` (*"a reader of either already saw it said"*) — **the claim was not stated in B.**

- `subject_cmp` is nullable, resolver-supplied, and **inverted**: non-null and unequal ⇒ *not the same slot* ⇒ suppress **corroboration, tension, and supersession alike**. It is **not** a mirror of `object_cmp`.
- Accepting was never a deferral: the vocabulary is a **function on surfaces**, and no function on surfaces maps one surface to two referents.
- **Honest limit:** only a warehouse-backed subject can supply one. The extracted↔extracted homonym — the case that occurs today — stays accepted, guarded by a **review-gate widening disclosure fired only when `added` is non-empty**.

**Failure semantics.** Block-vs-flag is reaffirmed: a quality failure never drops a candidate. But abstain and failure **split** — an honest no-entry abstains **silently**; only an outage sets `provisional`, whose one remaining job is ***"this row's keys are worth recomputing."***

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
