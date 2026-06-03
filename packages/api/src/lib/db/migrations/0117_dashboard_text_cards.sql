-- 0117 — Dashboard text / section cards (#3138, the third #2267 primitive).
--
-- Adds `dashboard_cards.content`, the markdown body of a `text` / section-block
-- card — a header or explainer (e.g. "## Top of funnel") with no SQL and no
-- chart, used to group a wall of charts under section headers.
--
-- Additive-only: a single nullable column, no constraint changes. The card
-- KIND is DERIVED, not stored — `rowToCard` (lib/dashboards.ts) reports
-- `kind = 'text'` exactly when `content IS NOT NULL` and `kind = 'chart'`
-- otherwise. This keeps the migration to one ADD COLUMN (no `kind` column to
-- backfill) and leans on the table's existing nullable `chart_config`:
--
--   - chart card: content NULL, sql = the query, chart_config = the viz
--   - text  card: content = markdown, sql = '' (no query), chart_config NULL
--
-- `sql` stays NOT NULL — a text card persists the empty string there rather
-- than relaxing the constraint, since every SQL-executing path (refresh,
-- render, validation) already short-circuits on `kind === 'text'` and never
-- reads it. Existing rows are all chart cards (content NULL), so the read path
-- always resolves a kind and never sees ambiguity.
--
-- SECURITY: `content` is rendered SANITIZED on the client (react-markdown, no
-- rehype-raw) — raw HTML is never evaluated. A text card never reaches the SQL
-- validation/execution pipeline.

ALTER TABLE dashboard_cards
  ADD COLUMN IF NOT EXISTS content TEXT;
