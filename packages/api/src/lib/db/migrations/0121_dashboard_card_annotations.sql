-- 0121 — Dashboard card event annotations (#3209, the last #2267-deferred slice).
--
-- Adds `dashboard_cards.annotations`, a JSONB array of dated event markers:
--   [{ "x": "2026-01-15", "label": "Product launch", "color": "#10b981" }, ...]
--
-- Each annotation renders as a VERTICAL Recharts `<ReferenceLine>` on a
-- line / area card — marking when a product launch, campaign start, or other
-- event happened on the time axis. `x` is matched against the chart's
-- category-axis value (the same string the axis renders); `label` captions the
-- line; `color` is an optional CSS colour (falls back to a theme stroke). The
-- shape is the read-side sibling of the goal-line `thresholds` (#3208), which
-- draw HORIZONTAL reference lines from `chart_config.thresholds` — annotations
-- are vertical and live in their OWN card-level column rather than inside
-- `chart_config`, so they survive a chart-type re-detection and apply to the
-- card's time context rather than a specific viz.
--
-- NOT NULL DEFAULT '[]': existing cards backfill to "no annotations", so the
-- read path (`rowToCard`) always sees an array and never null. The shape is
-- validated on read via `dashboardCardAnnotationsSchema` (@useatlas/schemas) —
-- a malformed row degrades to `[]` with a logged warning rather than throwing,
-- mirroring the `dashboards.parameters` handling from 0116.
--
-- Additive-only: a single column, no constraint changes — safe under the
-- two-phase-drop discipline (an ADD COLUMN can ship in a single release; only
-- DROP COLUMN / DROP TABLE need the N / N+1 split). The Drizzle mirror in
-- `db/schema.ts` lands in the SAME PR so `check-schema-drift` stays green.

ALTER TABLE dashboard_cards
  ADD COLUMN IF NOT EXISTS annotations JSONB NOT NULL DEFAULT '[]'::jsonb;
