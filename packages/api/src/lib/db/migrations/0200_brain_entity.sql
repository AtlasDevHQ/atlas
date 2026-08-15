-- 0200 — The entity store, and the naming dimension that feeds it (#5043,
-- ADR-0037 §5, bounded by ADR-0039).
--
-- Two writes, one slice, because neither is usable without the other: the store
-- holds `(canonical surface, stable id)` per warehouse row, and the canonical
-- surface has exactly one non-guessing source — a dimension a human named.
--
-- ## What the store is for
--
-- ADR-0037 §5 gives the store two jobs and forbids it a third.
--
--   1. **Answer `surface → stable id`.** That id reaches `subject_cmp` and
--      `object_cmp` and nothing else — no slot key, no surface column, no join
--      arm. An id at a slot orphans the existing corpus the moment it starts
--      answering, which is #5000 re-caused by the fix for #5000.
--   2. **Emit vocabulary edges.** `lexicalNorm(primary key surface) →
--      lexicalNorm(canonical surface)` at both entity positions, an ordinary
--      `brain_vocabulary_edge` row under ADR-0037 §6's authority. That is the
--      store's whole slot-side contribution: it is not consulted at reconcile
--      time for the slot at all.
--   3. **It may do nothing clever at read time.** No fuzzy matching, no
--      embeddings, no LLM disambiguation. Every equivalence is a precomputed,
--      approved edge. A PROHIBITION, stated because someone will propose
--      read-time matching later — the same posture that already refuses stemming
--      in the lexical layer and near-miss detection in the proposal query.
--
-- ## Why the canonical surface needs a human
--
-- `warehouse-producer.ts` states the limit this table lifts: *"the semantic
-- layer marks which dimension identifies a row and marks nothing as the row's
-- NAME, so the primary key is the only identifying surface available without a
-- guess."* A surrogate-keyed row therefore collides with its own re-emissions
-- and with nothing else.
--
-- Guessing a `name`-ish column by heuristic is the failure `subject-cmp.ts`
-- calls a CONFIDENTIALITY limit rather than an advisory one: a wrong subject is
-- a homonym, corroboration is the one identity consumer with no grant arm, and
-- publish overwrites `visible_to` with the union of evidence grants. So the
-- naming dimension is named by a person, on ADR-0039's own pattern — a machine
-- refines within a boundary, a human moves the boundary.
--
-- It is a FLAG ON AN ENROLLMENT rather than a column of its own or a fourth
-- table, and that is load-bearing twice over. The snapshot query selects the
-- enrolled columns only, so a naming dimension that is not enrolled would name a
-- column the producer never reads. And the store inherits ADR-0039's bound for
-- free: entries exist for enrolled entities and for nothing else, which is the
-- partial coverage that ADR is explicit is not a failure mode.
--
-- ## Fail-closed, at the one place it can be lost
--
-- Nothing here is UNIQUE on a norm, and the omission is the design. Two rows of
-- one table can legitimately carry the same name — two `Acme` accounts — and a
-- unique index would make the producer's second row an error to be swallowed or
-- a row to be dropped, both of which lie about coverage. Instead BOTH rows are
-- stored and the READER abstains: `entity-store.ts`'s lookup answers only when a
-- norm matches exactly one id, so an ambiguous name resolves to nothing.
--
-- The edge producer refuses the same pair for a sharper reason: `1 → acme` and
-- `2 → acme` are each legal under `brain_vocabulary_edge`'s at-most-one-parent
-- key (the parent is per `from_norm`), and together they would merge two
-- distinct entities into ONE slot key workspace-wide, with no inverse. That is
-- ADR-0037's forbidden direction reached through the front door.
--
-- ## Two accepted costs, carried from ADR-0037 §5 rather than discovered here
--
--   - Entries are SNAPSHOTS. A deleted or renamed warehouse row leaves a stale
--     entry until the producer re-runs, and a re-keyed one when it does.
--   - An entity's CANONICAL SURFACE changing — a warehouse rename, a human
--     re-picking the naming dimension — re-keys brain facts workspace-wide,
--     because the edge it emits is what the slot keys read. That blast radius is
--     reachable from a warehouse rename nobody thinks of as a brain operation.
--     `brain_vocabulary_edge`'s removal path (a recomputation, not a patch) is
--     what makes it undoable; nothing makes it invisible.
--
-- ## First-sight resolution is given up
--
-- A vocabulary answers only for edges someone already wrote. A genuinely new
-- entity spelling waits for a second occurrence AND a human before it collides.
-- That is weaker than "entity resolution" normally promises and it is the trade
-- ADR-0037 §5 took deliberately.

-- ---------------------------------------------------------------------------
-- The naming dimension
-- ---------------------------------------------------------------------------

ALTER TABLE brain_enrollment
  ADD COLUMN IF NOT EXISTS naming boolean NOT NULL DEFAULT false;

-- AT MOST ONE naming dimension per entity, structurally.
--
-- A partial unique index rather than a CHECK, because the property is across
-- rows. Without it two naming dimensions would mint two canonical surfaces for
-- one row and the store would hold whichever the producer's loop reached last —
-- a non-deterministic canonical surface, which is the one thing the id's
-- determinism argument cannot survive.
--
-- `WHERE naming` and not a plain unique: the false rows are the ordinary case
-- and there are many per entity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_brain_enrollment_naming
  ON brain_enrollment (workspace_id, entity)
  WHERE naming;

-- ---------------------------------------------------------------------------
-- The store
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS brain_entity (
  -- Better-Auth organization id. Workspace-global, TEXT/no-FK like every other
  -- org-scoped Atlas table. The brain is workspace-scoped where the semantic
  -- layer is `connection_group`-scoped, which is one of the three reasons
  -- ADR-0037 §5 makes the semantic layer an INPUT and never the store.
  workspace_id text NOT NULL,

  -- The stable id — `warehouseRowId`'s `wh_<sha256 of (workspace, entity,
  -- primary key)>`.
  --
  -- ⚠️ GLOBALLY UNIQUE, not merely deterministic and workspace-scoped, and the
  -- distinction is a contract clause rather than an implementation note. A
  -- derived id (`dim_plan:7`) collides across regions for two DIFFERENT rows,
  -- and a collision here is a false `same` at the publish gate: two distinct
  -- entities merged, with no inverse. A digest over the triple cannot collide
  -- for two different rows and is identical for the same row on every run, which
  -- is what makes a re-emission corroborate its predecessor instead of
  -- contradicting it.
  entity_id text NOT NULL,

  -- The semantic-layer entity this row came from — `semantic_entities.name`,
  -- matching `brain_enrollment.entity`. Stored so a stale entry can be traced to
  -- the enrollment that produced it, and so a re-run can replace one entity's
  -- entries without touching another's.
  entity text NOT NULL,

  -- The primary key's surface, VERBATIM as the producer emitted it. This is the
  -- subject surface that appears on every fact the producer wrote, so it is the
  -- handle by which a person reading `brain_facts` can find the entry.
  key_surface text NOT NULL,
  -- `lexicalNorm(key_surface)` — the `from_norm` of the vocabulary edge, and one
  -- of the two lookup columns.
  --
  -- Materialized rather than computed at read time on `brain_facts`'s own
  -- reasoning: the norm is what is INDEXED and what is JOINED, and a functional
  -- index would be a second implementation of `lexicalNorm` in SQL that nothing
  -- pins against the TypeScript one. Both writers norm in TypeScript; the region
  -- importer refuses a row whose norms do not match its surfaces.
  key_norm text NOT NULL,

  -- The naming dimension's value for this row, VERBATIM. The human surface —
  -- what a person says and what an extractor emits.
  canonical_surface text NOT NULL,
  -- `lexicalNorm(canonical_surface)` — the `to_norm` of the vocabulary edge, and
  -- the lookup column that matters: it is what an LLM-extracted claim about
  -- "Acme Corp" resolves through.
  canonical_norm text NOT NULL,

  -- When the snapshot that produced this entry was taken. Entries are snapshots
  -- (see the header), and this is the column that says how old one is.
  snapshot_at timestamptz NOT NULL,

  -- The ID is the identity, not the surface. A re-run for the same warehouse row
  -- yields the same digest and therefore updates in place — a renamed row keeps
  -- its id and gains a new canonical surface, which is exactly the re-key the
  -- header names as an accepted cost.
  PRIMARY KEY (workspace_id, entity_id),

  -- `''` on any of these is an entry that cannot do either of its jobs: an empty
  -- id reaches `subject_cmp` as a value that compares equal to every other empty
  -- id, and an empty norm is 0187's `DEFAULT ''` hazard through the front door —
  -- the one key value that joins every other degenerate row.
  CONSTRAINT ck_brain_entity_id_present CHECK (entity_id <> ''),
  CONSTRAINT ck_brain_entity_names_present
    CHECK (entity <> '' AND key_surface <> '' AND canonical_surface <> ''),
  CONSTRAINT ck_brain_entity_norms_present
    CHECK (key_norm <> '' AND canonical_norm <> '')
);

-- The resolver's lookup: one statement per episode over the deduplicated surface
-- set, matching `canonical_norm` OR `key_norm` within one workspace.
--
-- TWO indexes and not one composite: the two columns are alternatives in the
-- same query, so a `(workspace_id, canonical_norm, key_norm)` tree would serve
-- the canonical arm and nothing else.
--
-- ⚠️ Deliberately NOT unique — see the header's fail-closed section. The reader
-- abstains on an ambiguous norm; it does not get to assume the database made
-- ambiguity impossible.
CREATE INDEX IF NOT EXISTS idx_brain_entity_canonical_norm
  ON brain_entity (workspace_id, canonical_norm);
CREATE INDEX IF NOT EXISTS idx_brain_entity_key_norm
  ON brain_entity (workspace_id, key_norm);

-- The producer's own read: replace one entity's entries on a re-run without
-- scanning the workspace. `(workspace_id, entity)` is the prefix of no other
-- index here, since the PK's second column is `entity_id` rather than `entity`.
CREATE INDEX IF NOT EXISTS idx_brain_entity_entity
  ON brain_entity (workspace_id, entity);
