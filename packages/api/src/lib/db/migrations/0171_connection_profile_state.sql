-- 0171 — per-connection profile-tier state (baseline + LLM), #4509.
--
-- Two tracked tiers of "knowing a connection" (CONTEXT.md § Semantic
-- improvement, "Baseline profile / LLM profile"):
--
--   • Baseline profile — cheap, deterministic (schema/types/counts/samples via
--     the unified profiler capability). Runs automatically when a *profilable*
--     connection is created (REST/OpenAPI excluded by the capability gate);
--     pre-existing connections backfill lazily on first need. The payload is the
--     `TableProfile[]` the profiler produced, stored so briefings + the coverage
--     view read the physical schema from tracked data WITHOUT re-querying the
--     customer database just to start a chat.
--
--   • LLM profile — the enrichment pass. NEVER automatic, billing-gated, and
--     tracked per connection: when it last ran and over what scope.
--
-- One row per (org, connection install_id). `org_id` is nullable: on SaaS every
-- write supplies the workspace, but a self-hosted deployment with no active org
-- writes a NULL owner (the LLM-tier enrich path threads `orgId ?? null`), so a
-- NULL owner is a VALID live row here, not a legacy artifact — a future cleanup
-- must not treat NULL-owner rows as historical. Uniqueness keys on the COALESCE
-- sentinel so the NULL-owner rows stay a single bucket (mirrors migration 0138's
-- convention), and the `ON CONFLICT` targets in `connection-profile.ts` match it.
--
-- NOT content-mode-managed: this is operator/agent-facing DIAGNOSTIC metadata
-- ABOUT a connection (profile freshness + payload), not member-visible content
-- with a draft/published lifecycle, so it stays out of `CONTENT_MODE_TABLES`.
--
-- Additive-only: a brand-new table, no constraint changes to existing tables,
-- so it ships safely in a single release (the two-phase-drop discipline only
-- governs DROP COLUMN / DROP TABLE). The Drizzle mirror in `db/schema.ts`
-- (`connectionProfileState`) lands in the SAME PR so `check-schema-drift` stays
-- green and the next `drizzle-kit generate` doesn't emit a DROP for this table.
--
-- Not Better-Auth-managed, so this file does NOT join MANAGED_AUTH_MIGRATIONS
-- (db/internal.ts).
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE ... INDEX IF NOT EXISTS`
-- are no-ops on re-run.

CREATE TABLE IF NOT EXISTS connection_profile_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = self-hosted single-workspace owner with no active org (a valid live
  -- state written by the LLM-tier enrich path when there's no orgId). SaaS always
  -- supplies a workspace.
  org_id TEXT,
  -- The datasource connection's `workspace_plugins.install_id` — the per-
  -- connection identity the creation seam + the lazy backfill both key on.
  install_id TEXT NOT NULL,
  -- Connection-group scope (NULL = flat default group), so group-keyed consumers
  -- (briefing, coverage view) can find a connection's profile by its group.
  connection_group_id TEXT,
  -- Resolved dbType at profile time — readable metadata, NULL until first baseline.
  db_type TEXT,
  -- ── Baseline tier (deterministic profiler facts) ────────────────────
  -- The `TableProfile[]` payload; NULL until the first baseline succeeds.
  baseline_profiles JSONB,
  -- Denormalised `profiles.length` for cheap "N tables profiled" reads.
  baseline_table_count INTEGER,
  -- Freshness marker ("profiled N days ago"); NULL = never baseline-profiled.
  baseline_profiled_at TIMESTAMPTZ,
  -- Last auto/backfill failure reason (DSN-scrubbed at the profiler boundary),
  -- so a failed baseline is VISIBLE, never silent. Cleared on a clean re-profile.
  baseline_error TEXT,
  -- ── LLM tier (enrichment run tracking) ──────────────────────────────
  -- Last enrichment run; NULL = never LLM-profiled.
  llm_profiled_at TIMESTAMPTZ,
  -- What the last run covered, e.g. { "tables": ["orders"] }.
  llm_profile_scope JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Natural key: one state row per (org, install_id). The COALESCE sentinel keeps
-- the NULL-owner (legacy self-hosted) row a single bucket, mirroring migration
-- 0138. Drizzle can't represent an expression index, so this is managed here in
-- raw SQL and mirrored by a NON-unique placeholder index (same name) in
-- `db/schema.ts` so `drizzle-kit generate` doesn't emit a spurious DROP/CREATE
-- INDEX. The `ON CONFLICT` targets in `connection-profile.ts` match this
-- expression exactly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_connection_profile_state_org_install
  ON connection_profile_state (COALESCE(org_id, '__self_hosted__'), install_id);

-- Group-scoped consumers (briefing, coverage view) list a group's connection
-- profiles; a plain index keeps that scan tight.
CREATE INDEX IF NOT EXISTS idx_connection_profile_state_org_group
  ON connection_profile_state (org_id, connection_group_id);

COMMENT ON TABLE connection_profile_state IS
  'Per-connection profile-tier state (#4509): one row per (org, connection install_id) tracking the baseline profile (deterministic schema/types/counts/samples payload + freshness) and the LLM-profile (enrichment) run (timestamp + scope). Feeds the briefing staleness marker and the coverage view. Diagnostic metadata — NOT content-mode-managed.';
