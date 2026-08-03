# T1 · Does the semantic glossary already carry the workspace vocabulary?

Research resolving [#5005](https://github.com/AtlasDevHQ/atlas/issues/5005), a child of the
claim-identity wayfinder map [#5004](https://github.com/AtlasDevHQ/atlas/issues/5004).
Date: 2026-08-03. Read-only; no code changed.

**Short answer: no, and not partly.** The glossary is a *definition* store, not an
*equivalence* store — it has no field that can say "these two surface strings mean the
same thing," which is the entire relation the brain's identity model needs. Its grain is
type-level and warehouse-anchored on both the subject and predicate axes, its scope axis
is `connection_group` where the brain's is `workspace`, and its DB form is one opaque YAML
blob per group, which cannot participate in the SQL joins where brain identity is actually
enforced. T3 and T5 do **not** collapse into one answer.

Three things do carry forward, and they are the useful part of this ticket:

1. Entity **dimension/measure names and metric ids** are a real, closed, typed,
   already-per-group predicate vocabulary — for the **warehouse side only**. That makes
   the pinned warehouse↔extracted case tractable from one end (feeds T4/T5).
2. `dedup-key.ts` and `amendment-identity.ts` are strong prior art for **how to site and
   structure** an identity formula, and explicitly *not* prior art for computing
   equivalence. The distinction is worth stating in the ADR.
3. The glossary's `status: ambiguous` convention is the closest in-tree precedent for
   "this term does not resolve to one meaning — surface it, don't pick." If the identity
   model needs a *maybe-same* state, that's the shape, and it lands on the review gate
   §T4 already makes the arbitration mechanism.

---

## 1. What the glossary actually holds

### Storage

One `glossary.yml` per group directory, across all three ADR-0012 layouts — the flat
default root, canonical `groups/<group>/`, and legacy `<source>/`. `loadGlossaryTerms`
(`lib/semantic/lookups.ts:92`) walks `getGroupDirs(root, null)` and reads a `glossary.yml`
from each. Two YAML shapes are honoured: the canonical object map
(`terms: { <name>: {…} }`) and a legacy array (`terms: [{ term, … }]`).

On disk the root is `getSemanticRoot()` (`lib/semantic/files.ts:23`), with a per-org
mirror at `.orgs/<orgId>/` (`lib/semantic/sync.ts:57`). On SaaS the authoritative copy is
the DB, mirrored back to disk.

**The DB form is one row for the whole document.** `sync.ts:739-758` upserts it as
`entity_type = 'glossary'`, `name = 'glossary'`, `yaml_content = <the entire file>`. There
is no row per term, no per-term id, no per-term index. This matters in §5.

### Scope

`semantic_entities` is unique on
`(org_id, entity_type, name, COALESCE(connection_group_id, '__default__'))`
(`lib/db/schema.ts:520`, `536-538`; real expression indexes in migration 0063). So the
glossary is scoped **per org AND per connection group**.

`brain_facts.workspace_id` (`lib/db/schema.ts:3262`) is the Better-Auth organization id —
the same top-level tenant as `org_id`. But the brain has **no group axis at all**. It
partitions by ACL grant (`visible_to`, T5) instead. The two scope models are not nested;
they are orthogonal below the org.

### Lifecycle

The glossary is draft/published like everything else in `semantic_entities`:
`status IN ('published','draft','draft_delete','archived')` (`schema.ts:517`, `524`), with
the exotic content-mode adapter at `lib/content-mode/adapters/semantic-entities.ts`. Same
gate *family* the brain reuses, different table and different adapter.

### Term shape

`GlossaryTermLookup` (`lookups.ts:68-81`):

| Field | Type | Notes |
|---|---|---|
| `term` | string | Non-empty, loader-enforced. The object-map key or the array form's `term`. |
| `status` | string \| null | The literal `"ambiguous"` is load-bearing — MCP clients surface ambiguity to the user rather than silently picking a mapping. |
| `definition` | string \| null | Free prose. |
| `note` | string \| null | Free prose. |
| `possible_mappings` | string[] | **Term → column/table**, not term → other phrasings. |
| `source` | string | The resolved group. |

Real files also carry `tables: [...]` (see `semantic/glossary.yml`,
`internal/semantic/atlas-dogfood/glossary/glossary.yml`); `GlossaryShape`
(`shapes.ts:91`) is `.passthrough()`, so incidental keys survive but aren't typed.

The *write* surface is narrower still (`expert/amendment-validation.ts:108-125`, `151`):

- `add_glossary_term` — `{ term, definition, ambiguous? }`, `.passthrough()`
- `update_glossary_term` — `.strict()`, and only `definition` / `ambiguous` are in
  `AMENDMENT_MUTABLE_FIELDS`. `term` is the *selector*, never renameable.

**There is no alias, synonym, or `also_known_as` field anywhere in the shape.** The one
field that looks structurally relevant, `possible_mappings`, points at warehouse columns —
wrong direction, wrong endpoints. And `searchGlossary` (`lookups.ts:110`) is a
case-insensitive **substring** scan over term/definition/note/possible_mappings: a
retrieval affordance, not an equivalence relation. Nothing in the glossary can express
"`priced at` and `is priced at` are the same predicate," which is #5000's failure verbatim.

### Who authors it

Four producers. All four are warehouse-anchored:

1. **Generation** — `atlas init` / the semantic generator, from the profiled schema.
2. **The expert analyzer** — `findGlossaryGaps` (`expert/categories.ts:311-345`). A
   hardcoded regex of business abbreviations
   (`acv|arr|mrr|churn|ltv|cac|nps|dau|mau|wau|gmv|arpu|aov|ctr|cvr|roi|roas`) matched
   against **column names**, proposing `{ term: abbrev, definition: "", ambiguous: true }`.
   The vocabulary's growth mechanism is literally *"this abbreviation appears in a column
   name."*
3. **Agent `propose_amendment`** during chat (`lib/tools/propose-amendment.ts:34`) —
   "*Glossary amendments … write the group's glossary document; entityName is the table the
   term relates to.*" Every glossary amendment hangs off a table.
4. **Hand-edited YAML** / the admin surface, through the same amendment pipeline.

All four presuppose a datasource. **A workspace ingesting Slack with no warehouse
connected has an empty glossary** — and four of the brain's five episode source kinds are
non-warehouse (`lib/brain/sources.ts:326-330`: `slack`/chat, `zoom`/transcript,
`outlook`/email, `warehouse`, `human`), with the one warehouse kind having no connector yet.

---

## 2. Grain — is it right for brain subjects and/or predicates?

The ticket anticipated a partial fit (subjects yes, predicates no). The evidence says
something sharper: **it's a systematic level mismatch on both axes**, though for different
reasons.

Look at what's actually in the files rather than at what the shape permits.

Demo glossary (`semantic/glossary.yml`): `GMV`, `AOV`, `LTV`, `churn`, `conversion`,
`return_rate`, `SKU`.

Dogfood glossary (`internal/semantic/atlas-dogfood/glossary/glossary.yml`): `org`,
`workspace`, `active org`, `paying org`, `trial`, `plan tier`, `BYOT`, `region`,
`agent run`, `query`, `surface`, `chat platform`, `platform_admin`, `active user`,
`conversation`, `thread`, `install`, `status`, `role`, `signup`, `active subscription`,
`churn`.

### Subjects — one level too coarse

Every single term above is **type-level**: a class (`org`, `conversation`), a measure
(`GMV`, `LTV`), or a filter predicate over warehouse rows (`paying org` — *"plan_tier IN
('starter','pro','business')"*). Not one is an instance.

Brain subjects are **instance-level**: `Business tier`, `Series A`, `the deploy box`,
`deploy-01`. The ticket's own example is the clean demonstration — the dogfood glossary
defines **`plan tier`**, the dimension. `Business tier` is a *value of* that dimension. The
glossary would define the column; the brain names the members.

Could a term be hand-authored at instance grain? Technically yes — the shape doesn't
forbid it. But none of the four producers would generate one there, and the two
structural fields (`tables`, `possible_mappings`) both point at warehouse schema, which is
what the grain is built for. The honest statement: *not the grain, and nothing in the
system pushes it there.*

### Predicates — no fit at all

Every term is a noun phrase. The write schema is `{ term, definition, ambiguous }` —
nothing verb-shaped, no arity, no cardinality. And the brain's predicate carries
`predicate_cardinality` (`single`/`multi`, `schema.ts:3339`) — the supersede-vs-coexist
switch — for which the glossary has no analogue and no place to put one.

### Where there *is* overlap

On the **object** side, and on **documentation**. A glossary term is a good candidate for
what a warehouse fact's object *means* (`churn` is defined as a 180-day rule, not a
column), and the glossary is where a predicate's *meaning* would sensibly be documented
once you have a canonical one. Neither is identity. Both are downstream of T3, not inputs
to it.

---

## 3. What `amendment-identity.ts` and `dedup-key.ts` already settled

Both are leaf modules with **no imports**, and both docstrings say why in the same words:
so every consumer imports one formula rather than re-spelling it, which is *"the
mechanical guarantee"* that two surfaces can't drift apart (`dedup-key.ts:5-11`,
`amendment-identity.ts:19-23`).

`dedupKey(name, groupId)` → `` `${name}\0${groupId ?? ""}` `` (`dedup-key.ts:18`). NUL is
illegal in both components, so the split is unambiguous — `users` + `g_users` cannot
collide with another decomposition.

`amendmentIdentityKey(group, entity, type, target)` → `` `${g}:${e}:${type}:${target?}` ``
(`amendment-identity.ts:101`).

**Four things transfer directly:**

1. **A position may collapse on purpose, and it collapses to what the thing *belongs to*
   — not to what produced it.** Glossary amendment types replace the entity component with
   the literal `"glossary"` (line 108) because a term belongs to the group's one document,
   not to the table that surfaced it. Keying on the host entity leaked: rejecting `MRR`
   under `orders` did not suppress `MRR` under `customers`, and pending-dedup queued two
   rows both upserting the identical term. That is the same rule as the map's
   source-agnostic constraint, discovered independently in another subsystem.

2. **The distinguishing target is type-dispatched, never a blind `.name` read.**
   `amendmentTargetName` (line 49) switches per type because each stores its target under
   a different field; one uniform read collapsed distinct changes into one identity and
   turned a permanent rejection guard into an over-broad block. The brain analogue is a
   caution against one canonicalization function applied uniformly to S, P and O —
   `reconcile.ts` already treats subject and object as one role-parameterized kind
   (`EntityRole`) and predicate as neither.

3. **Deliberate coarseness is a legitimate answer, and it is stated in the code.**
   `add_query_pattern` returns `undefined` for its target because the generated name
   carries a per-run index and is not stable identity — so all query-pattern proposals for
   an entity are *one* identity, on purpose (lines 44-48). The brain equivalent: it is
   legitimate for the identity model to declare some claims deliberately
   non-distinguishable rather than invent a key for them.

4. **Unreconstructable → matches nothing.** `amendmentIdentityFromRow` returns `null` on a
   malformed payload or a missing `amendmentType` (lines 117-137) — *"an unreconstructable
   row is never treated as matching any identity."* Fail-closed toward no-match, never
   toward matches-everything. That composes with reconcile's existing block-vs-flag
   asymmetry.

**What does not transfer — and this is the important half.** Both are **exact-string
composition**. Neither normalizes, lowercases, stems, trims beyond the caller, or resolves
synonyms: `dedupKey("Users", g) ≠ dedupKey("users", g)`. They solve **siting and
structure** — where the formula lives, which positions it names, how a position may
collapse, what an unreadable input means. They do **not** solve equivalence, which is the
actual hard part of #5004. Treating them as prior art for the matching rule would import
the wrong lesson; treating them as prior art for the module shape is exactly right, and it
answers the map's *"the three consumers must end up consistent"* note — the same move
#4912 already made once inside the brain when it single-sited
`supersessionCollisionJoin`.

---

## 4. Warehouse-side predicate vocabulary (feeds T4)

Here the semantic layer *does* have something real — but it is the **entity and metric
definitions**, not the glossary.

- **Dimensions** — entity YAML `dimensions[]` is `{ name, sql, type, description,
  sample_values?, primary_key? }` (see `semantic/entities/orders.yml`).
- **Measures** — the sibling list; `entities.ts:1274-1275` pairs `dimensions`/`measures`.
- **Metrics** — `MetricDefinition` (`lookups.ts:213-225`): `id`, `label`, `description`,
  `sql` (authoritative, used exactly as written), `type`, `aggregation`, `unit`, `source`,
  and `binding: { entity, measure }`.

A tier-1 warehouse producer emitting SPO would most naturally place a dimension *value* at
the subject, the **column / measure / metric being read** at the predicate, and the value
at the object. So the warehouse-side predicate vocabulary is
**`entity.dimension` names ∪ `measure` names ∪ `metric.id`** — and it has three properties
the extracted English predicate space does not:

- **Closed and enumerable in advance.** Per group, loadable today via
  `loadMetricDefinitions` and the entity scan. You can list the entire left-hand column of
  the mapping before the producer exists.
- **Described.** Every dimension and metric already carries a `description`, which is what
  an LLM-assisted mapping step would consume.
- **Typed, with units.** `dimension.type` and `metric.unit` are what make §T4 §3's
  *"quantitative claim the warehouse can check"* mechanically decidable rather than a
  string comparison. Worth pulling into T4 regardless of how identity resolves.

The sharp consequence the map already anticipated is confirmed, and now with the reason:
`price` will never string-match `is priced at`, and **the glossary is not the bridge**.
`possible_mappings` runs *business term → column*, which is both the wrong direction and
the wrong pair of endpoints — it never maps a column to the English verb phrases that
assert it.

---

## 5. Coupling risk vs ADR-0036 §T3

§T3 chose *"a new fact/edge/episode substrate with its own trust identity, reusing the
KB's lifecycle — **not** a KB extension"* (`docs/adr/0036-atlas-as-company-brain.md:38`);
extending ADR-0028's descriptive-doc model in place was explicitly rejected. Reusing the
glossary as the brain's vocabulary partly reverses that. Five reasons it should not be
done — and they are independent, so they don't stand or fall together:

1. **The ADR already ruled on this exact seam, in the opposite direction.** §T9 bullet 4:
   `learn/` query patterns are *"a distinct class, not tier-2 facts. Procedural knowledge,
   not SPO claims under T4; it keeps its own lifecycle, and its authoritative escalation
   points at the semantic layer / glossary ('metrics are authoritative'), not the fact
   graph."* The ADR's picture has procedural query knowledge escalating **into** the
   semantic layer while declarative company facts live in the brain. A vocabulary
   dependency runs an arrow back the other way across the one boundary §T9 drew by name.

2. **The tool contract already states the boundary.** `lib/tools/search-brain.ts:172` —
   searchBrain is *"never the SQL whitelist, metrics, or glossary."* A vocabulary
   dependency wouldn't violate that sentence literally (it's about what searchBrain
   returns), but it would make the two pillars share a mutable artifact whose lifecycle
   neither owns end to end.

3. **The scope axes don't line up, and forcing them is a live hazard.** Glossary is
   `(org, connection_group)`; the brain is `(workspace)` + per-fact ACL grant. To use a
   glossary as brain vocabulary you must either **pick a group** — arbitrary, since a
   Slack episode has no connection group — or **union across groups**, which silently
   crosses the ADR-0022 cross-group reach boundary, in the identity layer, where nothing
   audits it. The map's fog entry *"whether a vocabulary learned from private channels
   leaks phrasing across grants"* is the mirror image of this; the glossary version is
   worse, because group-reach is an **enforced** boundary rather than an advisory one.

4. **Availability is inverted.** The vocabulary would be emptiest exactly where the brain
   is most valuable — a workspace ingesting chat/transcript/email with no warehouse
   connected. Every glossary producer requires a datasource; four of five episode source
   kinds do not have one.

5. **Substrate mismatch — you cannot join against it.** Brain identity is enforced *in
   SQL*: `TENSION_CANDIDATES_SQL` and `CORROBORATION_LOOKUP_SQL` (`lib/brain/reconcile.ts`)
   and `supersessionCollisionJoin` (`lib/content-mode/adapters/brain-facts.ts:361`). The
   glossary's DB form is a single opaque `yaml_content` blob, one row per group. There is
   nothing to join to. Any use would mean parsing YAML in application code per reconcile
   call — which is *fine behind the `EntityResolver` seam* (it already runs before the
   transaction opens, precisely so a DB-backed resolver can check out its own connection),
   but useless as a **stored key**, and the three consumers above compare stored columns.

Point 5 also generalizes past the glossary, and is worth carrying into T3 as a constraint
in its own right: **whatever canonical form is chosen must be materialized into a column
the three consumers can compare**, not computed at read time. That is the shape
`correction.ts:1377` already has — it inherits `subject` and `predicate` verbatim from the
target and is immune by construction because identity is *carried*, never re-derived.

---

## Consequences for the map

- **T3 (canonical predicate) must own its own vocabulary.** The glossary cannot supply it:
  wrong grain, no synonymy field, warehouse-gated availability, group-scoped, blob-stored.
  Do not extend it. T3 and T5 do **not** collapse — the ticket's cheap-check hypothesis is
  answered negative.
- **T5 gains a real input, on the warehouse side only.** Entity dimension names, measure
  names, and metric ids form a closed, per-group, described, typed predicate space for
  tier-1. The pinned warehouse↔extracted case is tractable from one end; the other end
  (extracted English) stays open and is T3's problem.
- **Site the identity formula the way `dedup-key.ts` and `amendment-identity.ts` are
  sited** — a leaf module, no imports, one exported function, imported by all three
  consumers. That is the structural answer to *"the three consumers must end up
  consistent."*
- **Materialize, don't compute.** The canonical form must land in a comparable column, per
  point 5 above.
- **`status: ambiguous` is the precedent for a maybe-same state.** It is the only place in
  the tree where a term is allowed to not resolve, and the resolution is *surface it to a
  human*, never silently pick. If identity needs that state, it lands on the review gate —
  which §T4 already makes the arbitration mechanism, so no new authority is invented.

### One thing this ticket did not settle

Whether the glossary should *consume* brain output later — an extracted predicate that
stabilizes becoming a documented term. That is the §T9 arrow pointing the way the ADR
already sanctions, and it is downstream of having a canonical predicate at all. Not fog on
this map; a note for whoever picks up write-back.

---

## Files read

- `packages/api/src/lib/semantic/` — `shapes.ts`, `lookups.ts`, `search.ts`, `sync.ts`,
  `files.ts`, `mirror-fs.ts`, `entities.ts`, `amendment-identity.ts`, `dedup-key.ts`,
  `expert/amendment-validation.ts`, `expert/categories.ts`, `expert/apply.ts`
- `packages/api/src/lib/brain/` — `reconcile.ts`, `extract.ts`, `correction.ts`,
  `sources.ts`, `search.ts`
- `packages/api/src/lib/content-mode/adapters/brain-facts.ts`,
  `adapters/semantic-entities.ts`, `tables.ts`
- `packages/api/src/lib/db/schema.ts` (`semantic_entities`, `brain_episodes`, `brain_facts`)
- `packages/api/src/lib/tools/propose-amendment.ts`, `search-brain.ts`, `descriptions.ts`
- `docs/adr/0036-atlas-as-company-brain.md` (§T3, §T4, §T5, §T9)
- Data: `semantic/glossary.yml`, `internal/semantic/atlas-dogfood/glossary/glossary.yml`,
  `semantic/entities/orders.yml`
