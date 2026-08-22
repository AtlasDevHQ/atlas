# Swallowed testimony: the pre-#5332 residue (#5332 AC5)

Until [#5332](https://github.com/AtlasDevHQ/atlas/issues/5332),
`CORROBORATION_LOOKUP_SQL` had no source arm. A person agreeing with a warehouse
reading corroborated **the observation** and returned: no draft was minted,
nothing reached the review queue, and their statement became a `provenance` edge
on a machine-produced row. Under
[ADR-0042](../adr/0042-warehouse-material-is-an-observation-never-a-published-belief.md)
that row is never served, so the testimony was gone from the corpus entirely.

#5332 stopped the minting. It rewrote no history. This page is the other half of
that ticket: **what the already-minted edges are, how to count them, and what we
decided to do about them.**

## The decision

**Leave them.** Do not re-mint the swallowed claims as drafts, and do not delete
the edges.

Three grounds, in the order they actually decide it:

1. **The population is closed and self-clearing.** `observation-reap.ts` scopes
   its freshness signal to *warehouse-class* evidence, so a chat episode on an
   observation never held it alive. Every affected observation ages out of the
   comparison surface on the ordinary reaper schedule once the warehouse stops
   returning its row, taking the edge with it (`brain_edges`' endpoint FKs
   cascade, and the reaper also deletes them by name). Nothing has to be
   migrated for the corpus to converge.
   ⚠️ **This is the ground the other two rest on**, and it is the one that can
   be broken by an unrelated edit — see *What would falsify this* below.
2. **Re-minting would fabricate review material, not recover it.** A draft
   minted now would carry today's `reconciled_at`, this backfill as its
   `producer`, and an episode whose `occurred_at` may be months stale. A
   reviewer reading the queue would see a claim presented as newly extracted
   that nobody said recently. The review gate's value is that a row means *a
   person said this and a person can bless it*; a synthesized row means neither
   half reliably.
3. **The upside is small and the mechanism is loud.** A swallowed claim is one
   that **agreed** with a warehouse value — that is what made it corroborate at
   all. It is the least contested material in the corpus, and if it still
   matters, the person is still saying it: the next time the topic comes up in
   chat, the extractor now mints the draft correctly. The defect suppressed a
   class of *agreement*, which is exactly the class where "wait for it to
   recur" is an acceptable recovery.

What this decision is **not**: a claim that the corpus is unaffected.
#5332's own framing stands — the queue under-represented human material for as
long as the defect was live, and the enumeration below is how you find out by
how much for any given workspace.

Related and deliberately separate: [#5331](https://github.com/AtlasDevHQ/atlas/issues/5331)
covers the two **published** warehouse rows stranded on prod, which get a narrow
`retract` — a verb a person uses. That is a different population (rows, not
edges) and a different remedy. Nothing here substitutes for it.

## Enumerating it

The query below returns one row per swallowed edge, with the episode that was
absorbed and enough of the claim to judge it.

> ⚠️ **The authoritative copy is `SWALLOWED_TESTIMONY_AUDIT_SQL` in
> `packages/api/src/lib/brain/__tests__/corroboration-class-pg.test.ts`**, where
> it is pinned against seeded positives *and* negatives. The block below is a
> reading copy. Nothing keeps the two in step automatically — edit the test,
> then re-copy here.

```sql
SELECT g.id AS edge_id,
       f.id AS observation_id, f.workspace_id, f.status,
       f.subject, f.predicate, f.object,
       e.id AS episode_id, e.source AS episode_source, e.source_id,
       e.source_actor, e.occurred_at
  FROM brain_edges g
  JOIN brain_facts f
    ON f.workspace_id = g.workspace_id AND f.id = g.from_fact_id
  JOIN brain_episodes e
    ON e.workspace_id = g.workspace_id AND e.id = g.to_episode_id
 WHERE g.edge_type = 'provenance'
   AND (f.provenance->>'source' = ANY (ARRAY['warehouse']::text[]))
   AND (e.source = ANY (ARRAY['warehouse']::text[])) IS NOT TRUE
 ORDER BY f.workspace_id, e.occurred_at, g.id;
```

Three things about its shape, each of which was a way to get it wrong:

- **`IS NOT TRUE`, not `NOT (…)`,** on the episode arm. `brain_episodes.source`
  carries no `CHECK` and the region importer writes out-of-vocabulary values
  through it, so a NULL or unrecognized source must count as *not warehouse* —
  the naive negation drops exactly the rows whose provenance is least
  trustworthy. Same reasoning as `notAnObservationSql`, opposite position.
- **The fact arm is a positive allowlist** (`= ANY (warehouse)`), matching
  `observationSql`. An observation is identified by being warehouse-class, never
  by failing to be something else — a source kind this region cannot classify is
  evidence of nothing and must not be swept in on a guess.
- **`f.status` travels.** The decision to leave rests on the rows being `draft`
  and therefore reapable. ADR-0042 makes every observation structurally draft
  and #5342 makes the publish gate refuse one, so a `published` row here is
  pre-gate residue and is #5331's business, not this query's. If the audit ever
  returns one, stop and read that ticket rather than extending this decision to
  cover it.

Run it per region — residency means the process is the region
([ADR-0024](../adr/0024-regional-identity-isolation.md)), so there is no single
database that answers this for all of prod.

## What we measured

- **Locally, against the live schema:** the query is exercised by
  `corroboration-class-pg.test.ts` over three seeded shapes — a chat edge on an
  observation (matches), an observation's own warehouse evidence (must not), and
  a warehouse episode corroborating a human belief (must not, and is the
  *legitimate* cross-class edge that survives #5332).
- **On prod: not run from this change.** The nearest evidence is
  [#5345](https://github.com/AtlasDevHQ/atlas/issues/5345#issuecomment-5377359992)
  (verified 2026-08-22), where the fact store returned eight facts, all
  `provenance.source = "slack"`, zero warehouse. That is a `searchBrain` read,
  not this query, and it post-dates the deletion of the warehouse rows — so it
  bounds the *surviving* observation population near zero and says nothing
  directly about edges that hung off rows already gone. **Treat the prod count
  as unmeasured until someone runs the query above**, and record the number here
  when they do.

## What would falsify this

Ground 1 is a property of code that lives elsewhere, so it can be broken by an
edit that never mentions this page:

- **`observation-reap.ts`'s evidence arm losing its warehouse-class scope.**
  Then a chat edge holds an observation alive indefinitely, the population stops
  clearing, and "leave them" loses its grounds. The behavioural falsifier is
  `observation-reap-pg.test.ts`'s *"a chat episode agreeing with an observation
  does not hold it alive"*; `corroboration-class-pg.test.ts` asserts the arm's
  presence in `OBSERVATION_REAP_SQL` and names that test, so the two halves are
  findable from each other. Deleting either one silently un-grounds this page.
- **Any new writer of a non-warehouse `provenance` edge onto an observation.**
  The population is closed only because `reconcile.ts` is the sole minter and
  #5332 closed it there. A second writer re-opens it, and this decision would
  have to be re-argued rather than inherited.
