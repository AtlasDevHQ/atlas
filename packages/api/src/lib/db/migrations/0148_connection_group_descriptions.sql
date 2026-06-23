-- 0148: connection_group_descriptions — per-Connection-group routing descriptions
-- for the Source catalog (#3894, ADR-0022 §4).
--
-- The agent reads a compact Source catalog to decide which datasource holds an
-- answer before drilling in with `explore` (cross-group reach, slice (b)). Each
-- SQL Connection group gets a short description that feeds that catalog. A group
-- is an abstraction over one-or-more `workspace_plugins` installs sharing a
-- `config->>'group_id'` (post-0096 there is no `connection_groups` table) — so a
-- group-level description has no single install row to live on, and gets its own
-- table keyed on the canonical group id. A group-of-one (#3855) keys under its
-- own install_id, exactly as `resolveGroupIdForConnection` resolves it.
--
-- `source` distinguishes an AUTO description (generated from the group's entities
-- at the semantic-generation seam, `/wizard/save`) from a MANUAL one (refined by
-- a customer admin). Auto-generation upserts only when no manual override exists,
-- so re-profiling never clobbers an operator's edit (the profile-then-refine
-- pattern). An admin edit stamps `source = 'manual'`.
--
-- CONTENT-MODE EXEMPT: this is operator/admin-authored routing metadata — the
-- group-level analogue of `workspace_plugins.config->>'description'` (the
-- per-connection description, which carries no draft/published status) — not
-- user-surfaced content that flows through the draft→publish pipeline. No
-- `status` column / ContentModeRegistry filtering. See docs/development/content-mode.md.
--
-- Drizzle-managed (mirrored in db/schema.ts as `connectionGroupDescriptions`,
-- same commit). Additive CREATE only — no DROP, so no two-phase-drop discipline
-- applies; the mirror lands in the same commit so a later `drizzle-kit generate`
-- cannot emit a DROP. `org_id` is the Better-Auth organization id (TEXT, no FK —
-- `organization` is not a Drizzle table, matching conversations / agent_runs /
-- the other org-scoped tables). `group_id` is the free-form JSONB group key, also
-- not FK-able.

CREATE TABLE IF NOT EXISTS connection_group_descriptions (
  org_id      TEXT NOT NULL,
  group_id    TEXT NOT NULL,
  description TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, group_id)
);

COMMENT ON TABLE connection_group_descriptions IS
  'Per-Connection-group routing descriptions for the agent Source catalog (ADR-0022, #3894). One row per (org_id, group_id). source=auto generated from the group entities; source=manual refined by an admin. Content-mode-exempt operator metadata.';
