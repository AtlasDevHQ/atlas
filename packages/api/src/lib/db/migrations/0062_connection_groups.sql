-- 0062 — Connection groups foundation (PRD #2336, issue #2339).
--
-- Introduces `connection_groups` and a new nullable `connections.group_id`
-- column. Backfills 1:1 so every existing connection lands in a single-
-- member group named after itself. Existing single-connection orgs see
-- zero behavior change.
--
-- Content tables (semantic_entities / dashboard_cards / scheduled_tasks /
-- approvals / pii_column_classifications) are NOT touched in this slice —
-- those migrations land in #2340–#2344. This file is the table + the
-- one-time backfill, nothing else.
--
-- Vocabulary: schema + code use `connection_group`; UI copy says
-- "environment". See PRD #2336 § Vocabulary.

CREATE TABLE IF NOT EXISTS connection_groups (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT '__global__',
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, org_id)
);

-- Group name is a display label. Two groups in the same org may not share
-- a name, but the literal value is mutable — foreign keys reference `id`.
CREATE UNIQUE INDEX IF NOT EXISTS uq_connection_groups_org_name
  ON connection_groups (org_id, name);

CREATE INDEX IF NOT EXISTS idx_connection_groups_org
  ON connection_groups (org_id);

-- Nullable during transition. NULL = legacy "no group" — the visibility
-- and content-mode paths still resolve correctly because every existing
-- row is backfilled below. New connections land non-null via the API.
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS group_id TEXT;

-- FK target is composite (id, org_id). Use a paired check rather than a
-- single-column FK so the (group_id, org_id) tuple is co-located with the
-- group itself — cross-org membership cannot exist.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'connections'
      AND constraint_name = 'fk_connections_group'
  ) THEN
    ALTER TABLE connections
      ADD CONSTRAINT fk_connections_group
      FOREIGN KEY (group_id, org_id)
      REFERENCES connection_groups (id, org_id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_connections_group
  ON connections (group_id, org_id);

-- 1:1 backfill. Every existing connection that lacks a group_id gets a
-- single-member group named after itself.
--
-- Idempotency notes:
--   - `ON CONFLICT (id, org_id) DO NOTHING` on the INSERT keeps any pre-
--     existing matching group row intact, so re-runs (mid-migration retry,
--     follow-up migration sweep) are safe.
--   - The UPDATE's `EXISTS (...)` predicate stamps `group_id` only when
--     the matching group row is present in connection_groups, so a future
--     re-run that finds the connection already grouped takes no action,
--     and a re-run that finds the group row missing leaves `group_id` NULL
--     rather than dangling a FK violation.
--
-- Group id strategy: prefix the source connection id with `g_` so a
-- subsequent "rename" doesn't conflict with the connection's own id.
-- For connections like `__demo__` the resulting group id is `g___demo__`
-- — ugly but stable and unambiguous; admins rename via the UI anyway.
WITH source AS (
  SELECT id, org_id
  FROM connections
  WHERE group_id IS NULL
)
INSERT INTO connection_groups (id, org_id, name)
SELECT 'g_' || id, org_id, id FROM source
ON CONFLICT (id, org_id) DO NOTHING;

UPDATE connections
SET group_id = 'g_' || id
WHERE group_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM connection_groups g
    WHERE g.id = 'g_' || connections.id
      AND g.org_id = connections.org_id
  );
