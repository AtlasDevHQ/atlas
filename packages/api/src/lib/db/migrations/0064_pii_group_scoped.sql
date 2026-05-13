-- 0064 — Group-scoped PII classifications (PRD #2336, issue #2341).
--
-- Mirrors the 0063 reshape on the PII table: flips the natural key from
-- `connection_id` to `connection_group_id`, drops the legacy `NOT NULL
-- DEFAULT 'default'` on `connection_id`, and recreates the unique index
-- keyed on the group. PII scanning runs once per group; classifications
-- are group-wide.
--
-- HITL assumption (locked per #2341 prompt): replicas inside a group
-- share schema, so a column's PII classification is the same across all
-- group members. The unique index `UNIQUE(org_id, table_name,
-- column_name, COALESCE(connection_group_id, '__default__'))` is the
-- DB-level encoding of that invariant. Reassigning a connection between
-- groups intentionally does NOT carry classifications — staging admins
-- decide their own posture (the migration-pg smoke pins this).
--
-- `connection_id` stays on the table as a nullable transitional column
-- for SDK back-compat (mirrors the 0063 strategy for `semantic_entities`).
-- Final removal lives in #2346 alongside the rest of the deprecation tail.

-- ── 1. Column ─────────────────────────────────────────────────────────
--
-- Nullable initially. Rows whose `connection_id` references a connection
-- that has since been deleted backfill to `connection_group_id = NULL`
-- and live in the COALESCE sentinel bucket with other un-scoped rows.
-- Flipping this to NOT NULL would orphan those legacy rows at boot.
ALTER TABLE pii_column_classifications
  ADD COLUMN IF NOT EXISTS connection_group_id TEXT;

-- Lookup index for the new column. The unique index below enforces
-- uniqueness; this one supports the read path (`WHERE
-- connection_group_id = $1` in `listPIIClassifications` and the masking
-- cache loader).
CREATE INDEX IF NOT EXISTS idx_pii_column_classifications_group
  ON pii_column_classifications (connection_group_id, org_id);

-- ── 2. Backfill ───────────────────────────────────────────────────────
--
-- Resolve every existing row's `connection_group_id` from its
-- `connection_id` via 0062's 1:1 mapping. The join allows either a
-- per-org connection or a `__global__` shadow (the demo / built-in
-- connections moved to `__global__` by 0060), matching the visibility
-- resolution semantic-entities (#2340) and the whitelist use.
--
-- Idempotent: the predicate `connection_group_id IS NULL` ensures
-- re-runs take no action on rows already resolved.
--
-- Rows whose `connection_id = 'default'` (the literal baseline default)
-- without a matching connection row stay `connection_group_id = NULL`
-- — they fall into the COALESCE sentinel bucket the same way 0063's
-- legacy NULL-scope rows do. Admin can re-scope them by hand if needed.
UPDATE pii_column_classifications pc
   SET connection_group_id = c.group_id
   FROM connections c
   WHERE pc.connection_id IS NOT NULL
     AND pc.connection_group_id IS NULL
     AND c.id = pc.connection_id
     AND (c.org_id = pc.org_id OR c.org_id = '__global__');

-- ── 3. Dedup pre-existing multi-connection rows ───────────────────────
--
-- Defensive sweep for the case an admin merged multiple connections
-- into one group BEFORE 0064 runs (#2339 ships the admin UI to do
-- exactly this). Without this step, each connection's per-row
-- classification collapses into the same group bucket and the new
-- unique index below fails to build with 23505.
--
-- Strategy: rank rows in each (org_id, table_name, column_name,
-- COALESCE(group_id)) bucket by (updated_at DESC, id DESC) and keep
-- only `rn = 1`. `updated_at` is the natural "freshest review" tie-
-- breaker (admins who recently reviewed a row should win over a stale
-- auto-detected one); `id` is the deterministic fallback for two rows
-- updated in the same statement.
--
-- Idempotent: a re-run sees one row per partition and finds nothing to
-- delete.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY
             org_id,
             table_name,
             column_name,
             COALESCE(connection_group_id, '__default__')
           ORDER BY updated_at DESC, id DESC
         ) AS rn
  FROM pii_column_classifications
)
DELETE FROM pii_column_classifications pc
USING ranked r
WHERE pc.id = r.id
  AND r.rn > 1;

-- ── 4. Drop legacy NOT NULL DEFAULT on connection_id ──────────────────
--
-- The baseline shape was `connection_id TEXT NOT NULL DEFAULT 'default'`.
-- That literal default silently bucketed every row without an explicit
-- connection into a `'default'` sentinel — a footgun once connections
-- became first-class (orgs with no connection named "default" still got
-- `connection_id = 'default'`). The group_id is the natural key now;
-- callers that don't have a connection should write NULL and rely on
-- the COALESCE sentinel.
ALTER TABLE pii_column_classifications
  ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE pii_column_classifications
  ALTER COLUMN connection_id DROP DEFAULT;

-- ── 5. Replace the unique index with the group-keyed shape ────────────
--
-- The baseline keyed uniqueness on `(org_id, table_name, column_name,
-- connection_id)` via an INLINE `UNIQUE(...)` constraint inside the
-- baseline `CREATE TABLE`. Postgres auto-names that constraint by
-- truncating the full generated name
-- `pii_column_classifications_org_id_table_name_column_name_connection_id_key`
-- to 63 bytes:
-- `pii_column_classifications_org_id_table_name_column_name_connec`.
-- That constraint backs an index of the same name — NOT
-- `pii_column_classifications_unique`. A bare `DROP INDEX IF EXISTS
-- pii_column_classifications_unique` leaves the old constraint in
-- place, and the new group-keyed rows then collide with the old
-- connection-keyed constraint at first insert.
--
-- The first DROP CONSTRAINT covers the actual baseline name; the second
-- is defensive for prerelease installs that ran an earlier 0064 draft
-- comment / name guess. The DROP INDEX covers self-hosted installs that
-- hit the masking module's `ensureTable` bootstrap path before the
-- migration ran (the bootstrap creates an index with the COALESCE-less
-- inline UNIQUE — same column set, but explicitly named through the
-- constraint).
--
-- 0064 swaps the natural key to `COALESCE(connection_group_id,
-- '__default__')` so multi-member groups collapse to one classification
-- row per column, matching the semantic-entities shape (#2340). The
-- drop+create is atomic inside the migration so callers querying
-- mid-migration never see an absent unique constraint.
ALTER TABLE pii_column_classifications
  DROP CONSTRAINT IF EXISTS pii_column_classifications_org_id_table_name_column_name_connec;
ALTER TABLE pii_column_classifications
  DROP CONSTRAINT IF EXISTS pii_column_classifications_org_id_table_name_column_name_co_key;
DROP INDEX IF EXISTS pii_column_classifications_unique;

CREATE UNIQUE INDEX pii_column_classifications_unique
  ON pii_column_classifications (org_id, table_name, column_name, COALESCE(connection_group_id, '__default__'));
