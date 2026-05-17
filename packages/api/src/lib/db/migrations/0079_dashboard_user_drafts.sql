-- 0079 — Per-user dashboard drafts (#2364, PRD #2362).
--
-- The chat-as-dashboard-editor feature (PRD #2362) lets each editor
-- iterate on a dashboard in a private draft before publishing. The
-- foundation slice (#2364) lays down the table + the versioning
-- module's storage; the user-facing Publish surface ships in
-- the sibling slice (#2521) behind the same feature flag.
--
-- Shape:
--   * (user_id, dashboard_id) composite PK — every editor has at most
--     ONE in-flight draft per dashboard. Re-opening the drawer in a
--     new tab UPSERTs onto the same row (acceptance criteria:
--     "concurrent edits in two browser tabs by the same user stay on
--     the same draft").
--   * `draft` JSONB stores the full DashboardSnapshot — the title,
--     description, and the array of cards (with sql/chart_config/layout).
--     We keep a snapshot rather than mutating the live dashboard_cards
--     rows so the published view is undisturbed until the user explicitly
--     publishes. Pre-publish reads of /dashboards/[id] (viewer mode)
--     keep returning the published `dashboard_cards` rows verbatim.
--   * `published_baseline_at` is the moment the draft was forked from
--     published. When publish moves underneath, the rebase route compares
--     this to the latest dashboard's `updated_at` and surfaces a conflict
--     when published has drifted (user story 13).
--
-- ON DELETE CASCADE on dashboard_id: dropping a dashboard drops every
-- editor's draft. This matches the existing `dashboard_cards` cascade
-- (a deleted dashboard cannot have orphan cards or drafts). User_id is
-- intentionally a plain `text` (mirrors `dashboards.owner_id`) so the
-- table works in every auth mode without an FK to Better Auth's
-- managed `user` table — that FK doesn't exist outside `managed`.
--
-- No `org_id` column on this table: org scope is enforced via
-- `dashboards.org_id` at the route layer (the route loads the
-- dashboard scoped to the caller's orgId before touching drafts).
-- Adding `org_id` here would duplicate the source of truth and force
-- a backfill on every dashboard org move.
--
-- This table is INTENTIONALLY out of the global content-mode publish
-- system. Per-user drafts are by definition not workspace-shared
-- content; `/api/v1/admin/publish` operates on workspace-wide drafts
-- of admin-configured content (semantic entities, prompts, etc.).
-- A user's dashboard draft is private to that user until THEY click
-- publish on THIS dashboard.

CREATE TABLE IF NOT EXISTS dashboard_user_drafts (
  user_id text NOT NULL,
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  -- Snapshot the user is editing. Mutates on every safe-op tool call.
  draft jsonb NOT NULL,
  -- Snapshot of published AT FORK TIME. Frozen for the lifetime of the
  -- draft (refreshed by `rebase`). Without this column we can't do a
  -- true three-way merge — we'd have to either pessimistically conflict
  -- on every drift OR risk silently overwriting a teammate's edit.
  -- Storing the baseline alongside the draft keeps `publishDraftMerge`
  -- + `rebaseDraftSnapshot` strictly pure: snapshot in, snapshot out.
  baseline jsonb NOT NULL,
  published_baseline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dashboard_id)
);

-- "List all drafts for THIS dashboard" — powers the Publish-side
-- "who has open drafts?" surface in #2521. Cheap because dashboards
-- typically have a handful of editors at most.
CREATE INDEX IF NOT EXISTS idx_dashboard_user_drafts_dashboard
  ON dashboard_user_drafts (dashboard_id);
