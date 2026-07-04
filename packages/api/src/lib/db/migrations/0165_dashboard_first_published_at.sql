-- 0165 — Dashboard first-publish visibility gate (#4320).
--
-- A newly-created dashboard is private to its creator until its FIRST publish,
-- then joins the org's dashboard list permanently. This is a one-way "has ever
-- been published" marker on the list/read scope — NOT a content-mode
-- draft/published/archived status enum (per ADR-0029). `first_published_at` is
-- set on the first publish and NEVER unset; a never-published dashboard
-- (first_published_at IS NULL) is visible only to `owner_id`.
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS first_published_at TIMESTAMPTZ;

-- Existing dashboards predate the gate — they are already live to their org, so
-- treat them as already-published to avoid retroactively hiding live boards.
-- Backfill from created_at so the marker is non-null and ordering-stable.
UPDATE dashboards SET first_published_at = created_at WHERE first_published_at IS NULL;

-- Supports BOTH the creator-visibility filter (never-published rows scanned by
-- owner within an org) and the abandoned-shell cleanup sweep (never-published,
-- empty, stale rows). Partial on the never-published, live subset — the hot,
-- selective slice.
CREATE INDEX IF NOT EXISTS idx_dashboards_unpublished
  ON dashboards (org_id, owner_id)
  WHERE first_published_at IS NULL AND deleted_at IS NULL;
