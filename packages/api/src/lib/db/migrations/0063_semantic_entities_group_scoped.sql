-- 0063 — Group-scoped semantic entities (PRD #2336, issue #2340).
--
-- Adds `semantic_entities.connection_group_id` and reshapes the three
-- partial unique indexes from 0028 to key on the new column. The
-- multi-environment semantic layer (us-int + eu + apac as one logical
-- "prod") needs `(org_id, entity_type, name, group_id)` to be the
-- natural key — `connection_id` made the same entity duplicate per
-- replica, which is the dogfood pain that motivated this PRD.
--
-- `connection_id` stays nullable on the table for transitional dual-
-- write. It goes away in a follow-up slice (PRD §"Migration sequencing")
-- once the per-group write paths and the SDK consumers have settled.
--
-- 0028-class regression guard:
--   The new indexes MUST include `entity_type` in the unique key.
--   Migration 0024/0025 dropped it once, took out two prod regions,
--   and was the reason 0028 exists. `migrate-pg.test.ts` asserts the
--   index definitions explicitly so a future "fix" that drops the
--   column fails CI before it ships.

-- ── 1. Column ─────────────────────────────────────────────────────────
--
-- Nullable initially. Legacy demo entities at org_id='__global__' carry
-- `connection_id IS NULL` (they don't belong to any tenant connection)
-- and stay that way — the COALESCE sentinel in the partial unique
-- indexes preserves uniqueness for the NULL row in the same shape
-- 0025 introduced. Flipping this to NOT NULL would orphan them at boot.
ALTER TABLE semantic_entities
  ADD COLUMN IF NOT EXISTS connection_group_id TEXT;

-- Lookup index for the new column. The partial unique indexes below
-- enforce uniqueness; this one supports the read paths (`WHERE
-- connection_group_id = $1` in entity loaders / whitelist).
CREATE INDEX IF NOT EXISTS idx_semantic_entities_group
  ON semantic_entities (connection_group_id, org_id);

-- ── 2. Backfill ───────────────────────────────────────────────────────
--
-- Resolve every existing row's `connection_group_id` from its
-- `connection_id` via 0062's 1:1 mapping. The join allows either
-- a per-org connection or a `__global__` shadow (the demo / built-in
-- connections moved to `__global__` by migration 0060), matching the
-- visibility resolution `listEntitiesWithOverlay` and the whitelist
-- already use.
--
-- Idempotent: the predicate `connection_group_id IS NULL` ensures
-- re-runs (mid-migration retry, follow-up sweep) take no action on
-- rows already resolved.
--
-- Rows with `connection_id IS NULL` stay `connection_group_id = NULL`
-- — they're the legacy NULL-scoped rows the original 0025 COALESCE
-- sentinel was introduced to keep unique. Same here.
UPDATE semantic_entities se
   SET connection_group_id = c.group_id
   FROM connections c
   WHERE se.connection_id IS NOT NULL
     AND se.connection_group_id IS NULL
     AND c.id = se.connection_id
     AND (c.org_id = se.org_id OR c.org_id = '__global__');

-- ── 3. Indexes — replace the connection-keyed indexes from 0028 ───────
--
-- The new natural key is `(org_id, entity_type, name,
-- COALESCE(connection_group_id, '__default__'))` per status. The
-- sentinel preserves NULL-safety for legacy demo entities the same
-- way 0025 did. `entity_type` is in the key — the 0028 prevention
-- assertion in `migrate-pg.test.ts` pins this.
--
-- Index names are reused. The drop+create pattern is atomic inside
-- the migration so callers querying mid-migration never see an
-- absent unique constraint.
DROP INDEX IF EXISTS uq_semantic_entity_published;
DROP INDEX IF EXISTS uq_semantic_entity_draft;
DROP INDEX IF EXISTS uq_semantic_entity_tombstone;

CREATE UNIQUE INDEX uq_semantic_entity_published
  ON semantic_entities (org_id, entity_type, name, COALESCE(connection_group_id, '__default__'))
  WHERE status = 'published';

CREATE UNIQUE INDEX uq_semantic_entity_draft
  ON semantic_entities (org_id, entity_type, name, COALESCE(connection_group_id, '__default__'))
  WHERE status = 'draft';

CREATE UNIQUE INDEX uq_semantic_entity_tombstone
  ON semantic_entities (org_id, entity_type, name, COALESCE(connection_group_id, '__default__'))
  WHERE status = 'draft_delete';
