-- 0041 — Dashboard card grid layout: per-card position in a 24-col freeform grid.
-- Replaces the single-column `position` index for the new tile-grid surface (#1867).
-- `position` is preserved for ordering on share/list views and for cards that have
-- not yet been laid out (layout IS NULL → fall back to auto-place by position).
ALTER TABLE dashboard_cards ADD COLUMN IF NOT EXISTS layout JSONB;

-- Layout shape: { x: int, y: int, w: int, h: int }
--   x: 0..23 grid columns
--   y: row index (ROW_H = 40px on the client)
--   w: 3..24 columns, h: 4+ rows
-- A NULL layout signals "not yet positioned" and gets auto-placed client-side.
