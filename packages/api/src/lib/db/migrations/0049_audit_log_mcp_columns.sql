-- 0049 — Audit-log MCP filter columns (#2067).
--
-- Adds three nullable columns so the admin audit surface can answer
-- governance questions shaped around the MCP transport — "what did
-- Claude Desktop do in my workspace last week?" — without a JSONB
-- scan or join. Each column is independently nullable: legacy rows
-- (and any non-MCP write path that hasn't been threaded yet) keep
-- behaving exactly as they did pre-#2067.
--
-- Columns:
--   actor_kind  — discriminator on who initiated the query. Today
--                 only `'mcp'` is populated; `'human'` / `'agent'` /
--                 `'scheduler'` are reserved for future writers and
--                 left NULL until those paths thread the field. The
--                 UI surfaces all four in the filter dropdown so the
--                 schema doesn't drift when later writers come online.
--   client_id   — OAuth client_id (e.g. `claude-desktop`, a DCR UUID)
--                 for hosted-MCP rows. NULL for stdio MCP and every
--                 non-MCP row.
--   tool_name   — MCP tool dispatched (`executeSQL` / `runMetric` /
--                 etc). NULL for non-MCP rows.
--
-- All three are nullable with no default so existing rows stay
-- untouched — no rewrite, no I/O storm on the migration.
--
-- Index choice: btree on (org_id, actor_kind, timestamp DESC) covers
-- the hot filter path — "MCP rows in this workspace, newest first" —
-- without bloating writes for the NULL-actor_kind majority. Partial
-- WHERE clause keeps the index from indexing every legacy row.
--
-- CHECK constraint pins actor_kind to the canonical four values (plus
-- NULL for legacy / non-attributed rows). When a future writer needs a
-- new kind, the migration is a one-line ALTER — the cost of a CHECK
-- here (catching typos like 'mpc' before they pollute the table) beats
-- silent-zero-rows in the admin filter when nobody notices.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_kind TEXT,
  ADD COLUMN IF NOT EXISTS client_id  TEXT,
  ADD COLUMN IF NOT EXISTS tool_name  TEXT;

DO $$ BEGIN
  ALTER TABLE audit_log
    ADD CONSTRAINT chk_audit_log_actor_kind
    CHECK (actor_kind IS NULL OR actor_kind IN ('human', 'agent', 'mcp', 'scheduler'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_audit_log_org_actor_ts
  ON audit_log (org_id, actor_kind, timestamp DESC)
  WHERE actor_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_client_id
  ON audit_log (client_id)
  WHERE client_id IS NOT NULL;
