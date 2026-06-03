-- 0116 — Dashboard parameters (#2267, parameters slice).
--
-- Adds `dashboards.parameters`, a JSONB array of parameter DEFINITIONS:
--   [{ "key": "date_from", "type": "date", "default": "now - 30 days", "label": "From" }, ...]
--
-- Every card's SQL can reference a parameter by `:<key>` (e.g. `:date_from`,
-- `:date_to`, `:region`). At view time the value is substituted server-side
-- through a PARAMETERIZED query — the named placeholder is rewritten to the
-- driver's positional form (`$N` on PostgreSQL, `?` on MySQL) and the value is
-- BOUND, never interpolated into the SQL text (lib/dashboard-parameters.ts).
-- This keeps the injection surface exactly as closed as the rest of the SQL
-- pipeline (SELECT-only, AST-validated, table-whitelisted — see CLAUDE.md).
--
-- NOT NULL DEFAULT '[]': existing dashboards backfill to "no parameters", so
-- the read path (`rowToDashboard`) always sees an array and never null. The
-- shape is validated on read via `dashboardParametersSchema` (@useatlas/schemas)
-- — a malformed row degrades to `[]` with a logged warning rather than throwing.
--
-- KPI cards and text blocks (the other two #2267 primitives) are explicit
-- follow-ups and add no columns here.

ALTER TABLE dashboards
  ADD COLUMN IF NOT EXISTS parameters JSONB NOT NULL DEFAULT '[]'::jsonb;
