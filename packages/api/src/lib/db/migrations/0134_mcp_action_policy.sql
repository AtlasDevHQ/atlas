-- 0134: MCP action policy — per-workspace kill-switch (#3509, ADR-0016 gate 1).
--
-- The customer-admin allow/deny over MCP action *categories* (e.g. "no
-- datasource creation via MCP at all"). Gate 1 of the dispatch order
-- (packages/mcp/src/dispatch-gate.ts) consults this table and short-circuits
-- a blocked category BEFORE scope / RBAC / approval — distinct from the
-- non-configurable origin ceiling. The decision is the customer admin's, never
-- the operator's (no env var); see ADR-0016 and CONTEXT.md ("MCP action policy").
--
-- Status-style table: one row per (org_id, category). The DEFAULT posture is
-- `allowed` and is represented by the ABSENCE of a row — a category is blocked
-- iff a row exists with status = 'blocked'. The dashboard (#3510) upserts an
-- explicit `allowed`/`blocked` row so a re-enable keeps an audit trail
-- (updated_by/updated_at) rather than silently deleting state.
--
-- Drizzle-managed (mirrored in db/schema.ts as `mcpActionPolicy`, same PR).
-- `org_id` is the Better-Auth organization id (TEXT, no FK — `organization` is
-- not a Drizzle table, matching settings / pii_column_classifications / the
-- other org-scoped Atlas tables). Additive CREATE only — no DROP, so no
-- two-phase-drop discipline applies; mirror lands in the same commit so a
-- later `drizzle-kit generate` can't emit a DROP.

CREATE TABLE IF NOT EXISTS mcp_action_policy (
  org_id TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'blocked',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, category),
  CONSTRAINT chk_mcp_action_policy_status CHECK (status IN ('allowed', 'blocked'))
);

-- Gate-1 lookups are per-workspace ("which categories does this org block?").
-- The composite PK already indexes (org_id, category) left-to-right, so a bare
-- org_id range scan is covered — no extra index needed.
