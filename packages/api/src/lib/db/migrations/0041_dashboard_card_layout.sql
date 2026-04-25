-- 0041 — Dashboard tile grid layout (#1867).
-- Bounds + shape live in CardLayoutSchema (lib/dashboards.ts). NULL = not yet
-- placed; the client auto-lays out from `position`.
ALTER TABLE dashboard_cards ADD COLUMN IF NOT EXISTS layout JSONB;
