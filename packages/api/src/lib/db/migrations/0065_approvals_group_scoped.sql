-- 0065 — Group-scoped approval queue (PRD #2336, issue #2344).
--
-- Adds `approval_queue.connection_group_id` and drops the vestigial
-- `connection_id NOT NULL DEFAULT 'default'` so the row keys on the
-- environment group rather than the originating connection. The HITL
-- assumption baked into the PRD: one approval covers any group member
-- running the same query. Keying on connection forced re-approval per
-- replica even when an admin had already greenlit the query for the
-- group — the exact dogfood pain #2336 set out to remove.
--
-- `connection_id` stays on the table for the transitional window so
-- audit reviewers can see which member originated the request. The
-- NOT NULL DEFAULT 'default' goes away: legacy callers that didn't
-- stamp a real connection_id were silently rewritten to the string
-- 'default' on insert, which is itself drift the audit log should not
-- carry post-#2344. Nullable from here; the column gets removed in a
-- follow-up slice once the SDK consumers settle.
--
-- Migration sequencing: #2344 owns 0065. #2340 (semantic) shipped at
-- 0063; #2343 (PII) lands at 0064; #2342 (dashboards) at 0066. All
-- four slices share the same recipe: nullable FK to connection_groups,
-- backfill via the 0062 1:1 map, no NOT NULL flip in this PR.

-- ── 1. Column ─────────────────────────────────────────────────────────
--
-- Nullable initially. Legacy rows pre-#2344 carry `connection_group_id
-- IS NULL` until the backfill below resolves them; the `hasApprovedRequest`
-- lookup uses a COALESCE sentinel so a NULL-group approval and a NULL-
-- group execution lookup match each other, preserving pre-migration
-- semantics until every consumer threads connection_id through.
ALTER TABLE approval_queue
  ADD COLUMN IF NOT EXISTS connection_group_id TEXT;

-- Composite FK so an approval row's `connection_group_id` can never
-- reference a group in a different org. Same shape as `connections.group_id`
-- in 0062. ON DELETE RESTRICT: dropping a group with live approval rows
-- pointing at it must fail loudly — admins are expected to expire or
-- reject the queue before tearing down the group. The route-layer
-- DELETE handler in `admin-connection-groups.ts` already checks for
-- members; this FK is the last-resort defence if a caller bypasses it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'approval_queue'
      AND constraint_name = 'fk_approval_queue_group'
  ) THEN
    ALTER TABLE approval_queue
      ADD CONSTRAINT fk_approval_queue_group
      FOREIGN KEY (connection_group_id, org_id)
      REFERENCES connection_groups (id, org_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- Lookup index supporting the new read path:
--   `WHERE org_id = $1 AND requester_id = $2 AND query_sql = $3
--    AND status = 'approved' AND COALESCE(connection_group_id, '__default__')
--                                 = COALESCE($4, '__default__')`
-- Same `__default__` sentinel as semantic_entities (0028 / 0063) so the
-- NULL-group execution path keeps a hot index path. Partial on
-- status = 'approved' because that's the only state the lookup ever
-- reads — keeps the index small.
CREATE INDEX IF NOT EXISTS idx_approval_queue_group
  ON approval_queue (org_id, connection_group_id, requester_id)
  WHERE status = 'approved';

-- ── 2. Backfill ───────────────────────────────────────────────────────
--
-- Resolve every existing row's `connection_group_id` from its
-- `connection_id` via 0062's 1:1 mapping. The default literal
-- 'default' (legacy NOT NULL DEFAULT) joins through to a group named
-- 'default' if one exists for the org; otherwise it stays NULL and the
-- lookup falls through to the legacy "no group" path. Same join
-- predicate as 0063 so demo / `__global__` rows resolve via the same
-- visibility rule the whitelist already uses.
--
-- Idempotent: the predicate `connection_group_id IS NULL` ensures
-- re-runs leave already-resolved rows alone.
UPDATE approval_queue aq
   SET connection_group_id = c.group_id
   FROM connections c
   WHERE aq.connection_id IS NOT NULL
     AND aq.connection_group_id IS NULL
     AND c.id = aq.connection_id
     AND (c.org_id = aq.org_id OR c.org_id = '__global__');

-- ── 3. Drop legacy NOT NULL DEFAULT 'default' on connection_id ────────
--
-- The vestigial guard from the pre-#2344 era — every insert that didn't
-- carry a connection_id got rewritten to the string 'default', which
-- then drifted into the audit log as if a connection actually named
-- 'default' was the source. Now that the lookup keys on group, the
-- column can carry the originating connection_id verbatim (including
-- NULL for callers that genuinely have no member context yet).
--
-- The DROP NOT NULL is wrapped to be re-runnable: a second migration
-- pass against an already-migrated schema is a no-op rather than an
-- error.
DO $$ BEGIN
  ALTER TABLE approval_queue ALTER COLUMN connection_id DROP NOT NULL;
EXCEPTION
  WHEN others THEN
    -- Column was already nullable (re-run) or another structural change
    -- removed the NOT NULL constraint. Either way, the post-condition
    -- (column is nullable) is the goal; swallow the exact reason.
    NULL;
END $$;

ALTER TABLE approval_queue ALTER COLUMN connection_id DROP DEFAULT;

COMMENT ON COLUMN approval_queue.connection_group_id IS
  'Group scope for this approval (#2344). NULL for legacy pre-#2344 rows; new rows carry the connection''s group_id resolved via 0062''s 1:1 backfill. The hasApprovedRequest lookup keys on this column so one approval covers every member of the group running the same query.';

COMMENT ON COLUMN approval_queue.connection_id IS
  'Originating connection id (audit trail). Nullable post-#2344 — the lookup keys on connection_group_id; this column survives so audit reviewers can see which member submitted the request. Removed in a follow-up slice once SDK consumers settle.';
