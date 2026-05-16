-- 0071 — connection_groups.status.
--
-- Adds a lifecycle column to `connection_groups` so the multi-environment
-- admin surface can retire a whole region atomically. The cascade UPDATEs
-- that flip downstream content rows live in the route handler
-- (`POST /admin/connection-groups/:id/archive`); this migration is purely
-- the column + CHECK + default.
--
-- Rationale for `status` over `archived_at`:
--   - Matches the lifecycle vocabulary every other content table already
--     speaks (`status IN ('published', 'draft', 'archived')` on
--     connections / semantic_entities / prompt_collections / query_suggestions).
--   - Lets reads filter with one predicate (`WHERE status = 'active'`)
--     instead of `archived_at IS NULL`.
--   - Leaves room for a future `paused` state without a column rename.
--
-- Enum values:
--   - `active`   — default. Group accepts new members, content writes,
--                  and chat routing.
--   - `archived` — read-only tombstone. Existing members stay attached
--                  so audit history resolves, but new content writes
--                  and the merge wizard's cleanup CTE skip these groups
--                  (the cascade route is the only sanctioned promotion
--                  path back out — admins restore by re-archiving=false
--                  in a future slice, not part of this migration).
--
-- Idempotency: `ADD COLUMN IF NOT EXISTS` and `ADD CONSTRAINT ... IF NOT
-- EXISTS` (via the DO block) make re-runs safe. The default `'active'`
-- backfills every existing row in the same statement — the multi-env
-- launch hasn't shipped a hosted SaaS tenant yet, so the default backfill
-- is the right answer (no historical archives to preserve).

ALTER TABLE connection_groups
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'connection_groups'
      AND constraint_name = 'chk_connection_groups_status'
  ) THEN
    ALTER TABLE connection_groups
      ADD CONSTRAINT chk_connection_groups_status
      CHECK (status IN ('active', 'archived'));
  END IF;
END $$;

-- Partial index on the active set — list views always filter
-- `status = 'active'` and would otherwise scan archived tombstones.
-- Composite with `org_id` mirrors the access pattern in the list
-- handler (`WHERE org_id = $1 AND status = 'active'`).
CREATE INDEX IF NOT EXISTS idx_connection_groups_active
  ON connection_groups (org_id)
  WHERE status = 'active';
