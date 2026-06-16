-- 0138 — durable partial-profile marker for generated semantic layers (#3682).
--
-- The universal profiler fails CLOSED above a 20% table-failure threshold
-- (ProfilingFailedError reason `threshold_exceeded`), but BELOW it the failed
-- tables are silently absent from the generated layer and the whitelist +
-- persist proceed on the partial set. The operator/MCP client gets a success
-- response; the per-table `errors[]` rides along transiently but nothing durable
-- records that the persisted layer is INCOMPLETE — so after a restart (or in a
-- different process: web `/chat` vs a stdio MCP server) the incompleteness is
-- invisible, and the publish flow promotes a silently-partial layer.
--
-- This table is the durable signal: one row per (org, connection group) records
-- how many tables were attempted, how many failed, and which ones — so the
-- partial state survives a restart and is readable by the publish flow
-- (`/api/v1/admin/publish` warns about the layers it just promoted) before an
-- admin makes a degraded layer live.
--
-- NOT content-mode-managed: this is operator-facing DIAGNOSTIC metadata ABOUT a
-- layer, not agent-queryable content that members see, so it intentionally stays
-- out of `CONTENT_MODE_TABLES` (it carries no draft/published status and is never
-- promoted by the publish transaction — the publish flow READS it, not promotes
-- it). It is upserted in place on every (re)profile, so a clean re-profile after
-- a permission fix clears a prior partial marker (`partial = false`).
--
-- Additive-only: a brand-new table, no constraint changes to existing tables,
-- so it ships safely in a single release (the two-phase-drop discipline only
-- governs DROP COLUMN / DROP TABLE). The Drizzle mirror in `db/schema.ts`
-- (`semanticProfileStatus`) lands in the SAME PR so `check-schema-drift` stays
-- green and the next `drizzle-kit generate` doesn't emit a DROP for this table.
--
-- Not Better-Auth-managed, so this file does NOT join MANAGED_AUTH_MIGRATIONS
-- (db/internal.ts).
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE ... INDEX IF NOT EXISTS`
-- are no-ops on re-run.

CREATE TABLE IF NOT EXISTS semantic_profile_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  -- Group scope, mirroring `semantic_entities.connection_group_id`: NULL is the
  -- flat default group. Uniqueness keys on COALESCE(.., '__default__') so the
  -- NULL-scope row stays a single bucket (the GROUP_SCOPE_SENTINEL convention).
  connection_group_id TEXT,
  total_tables INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  -- [{ "table": "<name>", "error": "<DSN-scrubbed message>" }]. Already scrubbed
  -- at the profiler host boundary before it reaches here (#3579).
  failed_tables JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Denormalised `failed_count > 0` so the publish-flow read can filter on a
  -- partial-row index without recomputing.
  partial BOOLEAN NOT NULL,
  profiled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Natural key: one status row per (org, group). The COALESCE sentinel makes the
-- NULL-scope (default-group) row unique just like the `semantic_entities`
-- partial indexes (migration 0063). Drizzle can't represent an expression index,
-- so this is managed here in raw SQL and mirrored by a NON-unique placeholder
-- index in `db/schema.ts` (same name) so `drizzle-kit generate` doesn't emit a
-- spurious DROP/CREATE INDEX — see the note there. (check-schema-drift.sh only
-- checks table presence, not indexes.) The `ON CONFLICT` target in
-- `upsertProfileStatus` matches this expression exactly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_semantic_profile_status_org_group
  ON semantic_profile_status (org_id, COALESCE(connection_group_id, '__default__'));

-- The publish-flow read only ever wants the PARTIAL layers for an org; a partial
-- index keeps that scan tiny even when most layers are complete.
CREATE INDEX IF NOT EXISTS idx_semantic_profile_status_org_partial
  ON semantic_profile_status (org_id) WHERE partial;

COMMENT ON TABLE semantic_profile_status IS
  'Durable partial-profile marker (#3682): one row per (org, connection group) recording how many tables were attempted vs. failed during the last profile, so a sub-threshold partial semantic layer is marked incomplete durably (survives restart) and is visible to the publish flow. Diagnostic metadata — NOT content-mode-managed.';
