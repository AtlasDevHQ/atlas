-- 0066 — Group-scoped dashboard cards (PRD #2336, issue #2342).
--
-- This slice moves `dashboard_cards` onto the multi-environment
-- connection-group axis introduced in 0062 / extended for semantic
-- entities in 0063. Cards now scope to a `connection_group_id` and
-- execute against the group's primary member (a new nullable
-- `primary_connection_id` on `connection_groups`). Side-by-side
-- multi-member rendering is explicitly out of scope for this PR —
-- the v1 default is primary-member execution per the PRD.
--
-- Migration numbering: this branch owns 0066. The two prior 1.4.4
-- slices land their own migrations:
--   0064 — PII column classifications group-scoping (#2341).
--   0065 — Approvals + scheduled-tasks group-scoping (#2342 sibling).
-- If 0064 / 0065 land out of order, the runner's idempotency contract
-- (record-of-applied-migrations in `__atlas_migrations`) keeps the set
-- consistent; what matters is that 0066 is the last in the sequence.
--
-- What this migration does:
--   1. Adds `connection_groups.primary_connection_id` as a nullable
--      composite FK to `connections (id, org_id)`. NULL means "fall
--      back to first member ordered by (created_at, id)" — the
--      resolver in lib/dashboards-group-resolve.ts handles both.
--   2. Adds `dashboard_cards.connection_group_id` (nullable, no FK
--      enforced — see § "Why no FK on connection_group_id" below).
--   3. Backfills cards from the existing `connection_id` via 0062's
--      `g_<connId>` 1:1 mapping.
--
-- Why no FK on `dashboard_cards.connection_group_id`:
--   `dashboard_cards` doesn't carry its own `org_id` — the parent
--   `dashboards` row provides the org scope. A composite FK to
--   `(id, org_id)` on `connection_groups` would require either
--   denormalising `org_id` onto every card or relaxing the FK to a
--   single-column reference, and the latter would silently allow a
--   card in org A to point at a group in org B. 0063 made the same
--   trade-off for `semantic_entities.connection_group_id` — the org
--   scope is enforced one layer up, in the route handler, and the
--   real-Postgres smoke test (#2342) pins the column shape so this
--   choice cannot silently regress.

-- ── 1. connection_groups.primary_connection_id ─────────────────────
--
-- Composite FK on `(primary_connection_id, org_id)` so the primary
-- pointer is org-isolated by construction. ON DELETE SET NULL: when
-- a connection is removed from the org we silently clear its
-- "primary" flag rather than blocking the delete — the resolver's
-- fallback path (first member by created_at, id) keeps the card
-- rendering until an admin re-pins. Without SET NULL the FK would
-- default to NO ACTION and break dependent deletes.
--
-- The "SET NULL on (primary_connection_id)" variant uses the column-
-- list form available in PG 15+ so we don't null the composite
-- `org_id` column too (org_id is NOT NULL on connection_groups, same
-- shape as the 0062 commentary). Drizzle's `onDelete` API doesn't
-- expose the column-list form, so the schema mirror in `schema.ts`
-- declares this FK manually via `foreignKey({...}).onDelete("set null")`
-- and a CHECK constraint enforces the matching action — the smoke
-- test in `migrate-pg.test.ts` keeps the two in lockstep.
ALTER TABLE connection_groups
  ADD COLUMN IF NOT EXISTS primary_connection_id TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'connection_groups'
      AND constraint_name = 'fk_connection_groups_primary'
  ) THEN
    ALTER TABLE connection_groups
      ADD CONSTRAINT fk_connection_groups_primary
      FOREIGN KEY (primary_connection_id, org_id)
      REFERENCES connections (id, org_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Lookup index for the new column. The FK above does NOT auto-create
-- a btree on the referencing side, so the ON DELETE SET NULL sweep
-- would otherwise full-scan the table on every connection delete.
CREATE INDEX IF NOT EXISTS idx_connection_groups_primary
  ON connection_groups (primary_connection_id, org_id);

-- ── 2. dashboard_cards.connection_group_id ─────────────────────────
--
-- Additive column. No FK constraint per the § above. The lookup
-- index supports the read path (`WHERE connection_group_id = $1` in
-- the card resolver + admin filters).
ALTER TABLE dashboard_cards
  ADD COLUMN IF NOT EXISTS connection_group_id TEXT;

CREATE INDEX IF NOT EXISTS idx_dashboard_cards_group
  ON dashboard_cards (connection_group_id);

-- ── 3. Backfill ────────────────────────────────────────────────────
--
-- Pre-0066 cards reference `connection_id`. Resolve each one through
-- 0062's 1:1 mapping (`g_<connId>`) to the corresponding group. The
-- join allows either the card's parent-dashboard org or the
-- `__global__` shadow (the demo / built-in connections moved to
-- `__global__` by migration 0060), matching how 0063 backfilled
-- semantic entities.
--
-- Idempotent: `connection_group_id IS NULL` ensures re-runs (mid-
-- migration retry, follow-up sweep) take no action on rows already
-- resolved. Cards with `connection_id` NULL stay NULL — they pick up
-- the workspace default at execution time, unchanged from pre-0066.
UPDATE dashboard_cards dc
   SET connection_group_id = c.group_id
   FROM connections c, dashboards d
   WHERE dc.dashboard_id = d.id
     AND dc.connection_id IS NOT NULL
     AND dc.connection_group_id IS NULL
     AND c.id = dc.connection_id
     AND (c.org_id = d.org_id OR c.org_id = '__global__');
