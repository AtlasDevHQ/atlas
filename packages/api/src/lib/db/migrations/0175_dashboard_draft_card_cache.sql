-- 0175 — Draft cache: a draft card's own cached data (#4554, ADR-0034 Decision 1).
--
-- ADR-0029 gave every dashboard edit a private per-user draft, but a draft
-- card had NO data home of its own: the draft view borrowed the PUBLISHED
-- card's cached rows (`materializeDraftView`'s fallback), a draft refresh
-- returned rows in-memory only (lost on reload), and a never-published
-- (draft-only) card 404'd on the published-card gate — an agent-built board
-- was a grid of "Never run" tiles until publish. ADR-0034 Decision 1 closes
-- the gap: the draft carries its own cached rows + capture instant (the
-- "draft cache", CONTEXT.md § Dashboard editing) — never the published card's
-- cached data, never the shared in-process Query Cache. This migration lays
-- the store + the reachable exec path; the seeding that fills an agent-built
-- board (tool-side execution #4558, canvas-mount render #4557) ships in the
-- sibling slices.
--
-- Shape:
--   * One row per (user_id, dashboard_id, card_id) — the card's cached data
--     PRIVATE to that user's draft. A row exists iff the card has data (from
--     a draft refresh, or seeded at fork — see below); "never run" is the
--     absence of a row, mirroring `dashboard_cards.cached_at IS NULL`.
--   * A SIDE TABLE keyed by card id, NOT fields inside the draft snapshot
--     JSONB: `saveDraft` rewrites the whole snapshot on every drag/rename, so
--     embedding rows there would amplify every edit write by the board's full
--     data volume — and the publish/rebase three-way merge (`cardEquals`)
--     must never see data rows.
--   * Composite FK → dashboard_user_drafts ON DELETE CASCADE: publish,
--     discard, and the abandoned-draft sweep all clear the draft cache for
--     free by deleting the draft row. (Dashboard delete is a SOFT delete —
--     `deleted_at` — so it fires no cascade; a deleted dashboard's drafts +
--     cache linger until the sweep, or org teardown's hard DELETE.)
--   * card_id has NO FK to dashboard_cards — a draft-only card exists ONLY in
--     the draft snapshot (that's the point). A cache row whose card was since
--     removed from the draft is simply never materialized and dies with the
--     draft row.
--   * user_id is plain text (mirrors dashboard_user_drafts.user_id) so the
--     table works in every auth mode. No org_id: org scope is enforced via
--     the parent dashboard at the route layer, same as the drafts table.
CREATE TABLE IF NOT EXISTS dashboard_draft_card_cache (
  user_id text NOT NULL,
  dashboard_id uuid NOT NULL,
  card_id uuid NOT NULL,
  cached_columns jsonb,
  cached_rows jsonb,
  -- Capture instant — when the rows were produced (drives the tile age
  -- caption / staleness tone for a draft-holding caller).
  cached_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dashboard_id, card_id),
  FOREIGN KEY (user_id, dashboard_id)
    REFERENCES dashboard_user_drafts (user_id, dashboard_id)
    ON DELETE CASCADE
);

-- "Clear/inspect every user's draft cache for THIS dashboard" — mirrors
-- idx_dashboard_user_drafts_dashboard.
CREATE INDEX IF NOT EXISTS idx_dashboard_draft_card_cache_dashboard
  ON dashboard_draft_card_cache (dashboard_id);

-- Backfill: drafts forked BEFORE this migration were reading the published
-- card's cache through the materialize fallback this change retires. Seed
-- each existing draft's cache with a copy of the published data so those
-- drafts keep rendering the same rows they showed yesterday (fork-time
-- seeding does the same for new drafts, in `forkOrLoadDraft`). From here on
-- the copies diverge by design: draft refreshes write ONLY here.
INSERT INTO dashboard_draft_card_cache
  (user_id, dashboard_id, card_id, cached_columns, cached_rows, cached_at)
SELECT u.user_id, u.dashboard_id, c.id, c.cached_columns, c.cached_rows,
       COALESCE(c.cached_at, now())
  FROM dashboard_user_drafts u
  JOIN dashboard_cards c ON c.dashboard_id = u.dashboard_id
 WHERE c.cached_rows IS NOT NULL
ON CONFLICT (user_id, dashboard_id, card_id) DO NOTHING;
