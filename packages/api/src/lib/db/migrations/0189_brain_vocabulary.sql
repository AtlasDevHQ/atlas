-- 0189 — The vocabulary: approved edges plus a derived effective-target
-- closure, position-scoped (#5022, ADR-0037 §6 "The vocabulary").
--
-- Slice B of the claim-identity arc. 0187 added the key columns and 0188
-- re-keyed the stragglers; both ran with `alias` as the identity function,
-- because the vocabulary it composes over did not exist. This migration is
-- that vocabulary — the OUTER layer of `key = alias(lexicalNorm(surface))`.
--
-- Two tables, and the split is the whole design rather than a normalization
-- preference. ADR-0037 §6 retracts T3's "forest invariant" by name for being
-- self-contradictory — it stated depth-1 (*every canonical target is itself
-- unaliased*) AND asserted composition works, and approving `price → unit
-- price` after `is priced at → price` makes `price` an aliased target, so both
-- cannot hold. The only reconciliation under one table is path compression at
-- approval time, and compression rewrites edges nobody approved in that action
-- and destroys the one property that makes a bad alias undoable: after
-- compressing, removing `price → unit price` cannot restore `is priced at →
-- price`, because that edge is gone.
--
--   brain_vocabulary_edge   — the human's decisions. Durable, at-most-one
--                             parent, never rewritten by another approval.
--   brain_vocabulary_target — the transitive closure of those edges. Derived,
--                             recomputed wholesale, and what `alias` reads.
--
-- Removal stops being a destructive write and becomes a RECOMPUTATION: delete
-- `price → unit price`, recompute, and `is priced at` lands back on `price`.
--
-- ## Position-scoped, and it is a compulsion rather than a permission
--
-- `slot_position` is part of the primary key of both tables. A
-- position-agnostic vocabulary would not merely PERMIT cross-position
-- composition, it would COMPEL it: `owned by → platform` plus `platform →
-- platform team` puts two edges in one chain, the closure composes them, and a
-- PREDICATE approval has silently re-keyed SUBJECTS workspace-wide — in the
-- irreversible direction, since once two spellings share a key nothing in the
-- key column tells them apart. The overlap surface is not hypothetical:
-- warehouse predicates are bare common nouns (`price`, `owner`, `status`,
-- `tier`, `region`), which is exactly the population most likely to also be
-- subject or object norms.
--
-- Counter-case recorded rather than re-argued (#5022): T3 §3 chose ONE
-- namespace so a curated entry and an uncurated key are directly comparable,
-- and position-scoping reintroduces a second space to keep from colliding.
-- Three forests is three enforcement paths that can drift. Accepted, because
-- the alternative silently re-keys a position nobody approved.
--
-- ## No ACL arm, and that is derived rather than chosen
--
-- Neither table carries `visible_to`. All three identity consumers are already
-- workspace-scoped with no grant arm at all (`CORROBORATION_LOOKUP_SQL`,
-- `TENSION_CANDIDATES_SQL`, `supersessionCollisionJoin`), so identity in this
-- system has never been per-reader — and the INPUT does not exist either:
-- grant-scoping needs `alias(norm, reader)` at a seam materialized at write
-- time by an ingest fiber that has no reader. ADR-0037 §6 names the cost out
-- loud: the vocabulary is the one piece of brain state with no ACL,
-- permanently, and per-team terminology is REFUSED by that decision rather
-- than merely unimplemented.
--
-- ## `slot_position`, not `position`
--
-- `POSITION` is a SQL-standard function name and a Postgres non-reserved
-- keyword. It is legal as a column name, and the prefix is still worth the six
-- characters: it says WHICH position (the claim's SPO slot) in a schema that
-- also has grid positions on dashboard cards.
--
-- ## What is deliberately NOT here
--
-- No `cardinality` column. Slice C (#5027) attaches cardinality as a SECOND
-- property of the same canonical predicate, and the room it needs is a table of
-- its own keyed on the canonical norm — NOT a column on either table below.
-- `brain_vocabulary_target` is strictly derived: every recompute DELETEs the
-- workspace's rows for a position and rebuilds them, so a human-set cardinality
-- parked there would be destroyed by the next unrelated approval. Keeping the
-- derived relation free of authored state is what leaves slice C room rather
-- than designing it out.
--
-- No proposal queue, no rejection memory, no decide-seam plumbing — #5023 owns
-- the approval flow and #5025 the UI. This migration is the schema and the
-- closure the flow will write through.

CREATE TABLE IF NOT EXISTS brain_vocabulary_edge (
  workspace_id TEXT NOT NULL,
  -- Which claim slot this edge governs. Part of the PK, so the three positions
  -- are three independent forests and an approval in one cannot reach another.
  slot_position TEXT NOT NULL,
  -- The norm being aliased AWAY (the child) and the norm it was approved onto
  -- (the parent). Both are LEXICAL NORMS, not surfaces: `alias` composes over
  -- `lexicalNorm`, so one entry covers every casing and separator variant of
  -- both sides.
  --
  -- NORMAL FORM IS NOT ENFORCED HERE, and an earlier version of this comment
  -- claimed it was. The CHECKs below test the position enum, non-emptiness and
  -- the 1-cycle — none of them rejects `Priced At`, and a faithful SQL check
  -- would be a third implementation of `lexicalNorm` (0187 already carries the
  -- second). The two write paths carry it instead: `approveAliasEdge` re-norms
  -- both endpoints, and the region importer REFUSES a non-norm row rather than
  -- rewriting another region's decision (`admin-migrate.ts`'s validation). A
  -- stored `Priced At` on the `from` side is an alias that can never match.
  from_norm TEXT NOT NULL,
  to_norm TEXT NOT NULL,
  -- The approver, and the one column an audit of a workspace-wide re-key reads
  -- first. THREE legal values, and #5023 added the third:
  --
  --   NULL             — auto-approved. No human was behind it (ADR-0037 §6's
  --                      auto-approve split). A sentinel like 'system' here
  --                      would be indistinguishable from a user id, which is
  --                      why the machine case is the NULL one.
  --   'local-operator' — a human on a self-hosted no-auth deployment, where
  --                      `unauthenticated-local` is the only origin there is
  --                      and carries no user id. Written rather than NULL so a
  --                      human re-key does not read as a machine one; the
  --                      sentinel is `correction.ts`'s, not a new invention.
  --   anything else    — the approving user's id.
  --
  -- So `approved_by IS NOT NULL` means "a human", and it means it by
  -- construction rather than by luck.
  approved_by TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- AT-MOST-ONE-PARENT, structurally. `from_norm` in the key is what makes
  -- `alias` a function: a second approval for the same norm raises a unique
  -- violation instead of silently retargeting a human's prior decision.
  --
  -- ADR-0037 §6 states at-most-one-parent by name in its own table. What did NOT
  -- imply it is T3's "no cycles + targets unaliased" framing — which §6 RETRACTS
  -- and lists under "Corrections to the record", so do not read it as the ADR's
  -- position. That is why the property is spelled structurally here AND checked
  -- explicitly in `approveAliasEdge`: the check turns the violation into a typed
  -- refusal naming the existing target, and the PK is what holds under two
  -- concurrent approvers.
  --
  -- It doubles as the closure walk's access path: the recompute's anchor scopes
  -- on this key's leading two columns and its recursive term joins on all three.
  -- Zero net new indexes on this table, the same result ADR-0037 §1 got for the
  -- slot index.
  PRIMARY KEY (workspace_id, slot_position, from_norm),
  CONSTRAINT ck_brain_vocabulary_edge_slot_position
    CHECK (slot_position IN ('subject', 'predicate', 'object')),
  -- An empty norm is not a slot. `identityKey` returns NULL for a surface that
  -- norms away (`-`, `___`, `  `) for the reason 0187's header gives about
  -- `DEFAULT ''` — a stored empty key is the one value that joins every other
  -- degenerate row — and a vocabulary entry naming `''` on either side would
  -- reintroduce it through the front door.
  CONSTRAINT ck_brain_vocabulary_edge_norms_present
    CHECK (from_norm <> '' AND to_norm <> ''),
  -- The 1-cycle. Longer cycles are refused in `approveAliasEdge` (a CHECK
  -- cannot see other rows); this is the one length a CHECK can catch, and
  -- catching it here means the trivial case cannot depend on application code.
  CONSTRAINT ck_brain_vocabulary_edge_not_self
    CHECK (from_norm <> to_norm)
);

CREATE TABLE IF NOT EXISTS brain_vocabulary_target (
  workspace_id TEXT NOT NULL,
  slot_position TEXT NOT NULL,
  -- The aliased norm, and the ROOT of its approved chain.
  --
  -- A row exists here IFF the norm has an approved parent. Unaliased norms are
  -- absent, not stored as `norm = effective_target`: `alias` is total by
  -- falling back to its input, so a self-row would be a second encoding of
  -- "no entry" — and the two encodings would drift the first time a recompute
  -- wrote one and a reader tested for the other.
  norm TEXT NOT NULL,
  effective_target TEXT NOT NULL,
  recomputed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, slot_position, norm),
  CONSTRAINT ck_brain_vocabulary_target_slot_position
    CHECK (slot_position IN ('subject', 'predicate', 'object')),
  CONSTRAINT ck_brain_vocabulary_target_norms_present
    CHECK (norm <> '' AND effective_target <> ''),
  -- Same 1-cycle refusal as the edge table, reached from the derived side: a
  -- closure that mapped a norm to itself would be `alias` claiming an entry
  -- exists while answering exactly what no-entry answers.
  CONSTRAINT ck_brain_vocabulary_target_not_self
    CHECK (norm <> effective_target),
  -- DERIVED-NESS, made structural. Every closure row must name a norm that
  -- actually has an approved parent, so the derived relation can never outlive
  -- the decision it was derived from.
  --
  -- RESTRICT and deliberately NOT CASCADE, which is the choice most likely to
  -- be "simplified" later. Cascade looks like the tidy answer and is a WRONG
  -- one: with `a → b` and `b → c`, deleting `b → c` must move `a`'s row from
  -- `c` back to `b`, and cascade would delete `b`'s row and leave `a` pointing
  -- at a `c` nobody approves any more — a wrong closure, committed, with nothing
  -- to surface it.
  --
  -- What RESTRICT buys is precise, and less than an earlier version of this
  -- comment claimed: it stops an edge being dropped while ITS OWN closure row
  -- stands. It does not by itself force a full rebuild — a caller could delete
  -- one closure row plus its edge and strand the rest. `recomputeEffectiveTargets`
  -- clears the whole position, so the correct ordering falls out of calling it;
  -- the FK is what stops a caller SKIPPING it silently.
  CONSTRAINT fk_brain_vocabulary_target_edge
    FOREIGN KEY (workspace_id, slot_position, norm)
    REFERENCES brain_vocabulary_edge (workspace_id, slot_position, from_norm)
    ON DELETE RESTRICT
);

-- No index beyond the two primary keys, and that is measured against the two
-- readers rather than assumed. `loadClaimVocabulary` selects every row for one
-- workspace (`WHERE workspace_id = $1`) and the recompute/removal statements
-- scope on `(workspace_id, slot_position)` — both are leading prefixes of the
-- PKs above. A curated vocabulary is human-authored and small; the walk is
-- bounded by chain depth, not by corpus size.
