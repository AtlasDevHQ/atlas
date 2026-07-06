-- 0168: knowledge sync connector spine — incremental-sync bookkeeping columns
-- on knowledge_sync_state (#4376, ADR-0030).
--
-- Knowledge Sync Connectors (Confluence/Notion follow-ups, PRD #4375) sync on
-- two cadences: cheap INCREMENTAL cycles off a persisted per-collection
-- high-water mark (with an engine-applied overlap window), and periodic FULL
-- RECONCILIATION crawls — the correctness anchor where subtractive archiving
-- of vanished paths and full-set cap validation happen. Three additive columns
-- carry that state:
--
--   high_water_mark    — the newest vendor change timestamp a successful sync
--                        has ingested through; the next incremental cycle
--                        fetches changes since (mark − overlap window). NULL
--                        until the first successful connector sync.
--   sync_cursor        — opaque vendor continuation token (e.g. a paging
--                        cursor), persisted verbatim for vendors whose change
--                        feeds aren't timestamp-shaped. NULL when unused.
--   last_reconciled_at — when the last successful full reconciliation crawl
--                        finished; the engine compares it against the
--                        ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS settings
--                        knob to decide each collection's mode per cycle. NULL
--                        forces reconciliation (a new install's first sync is a
--                        full crawl).
--
-- All three are NULLable and meaningless for `bundle-sync` collections (their
-- endpoint pull is always a full-set fetch, so every sync reconciles by
-- construction) — bundle-sync rows simply never set them.
--
-- Additive ALTER only (no DROP / RENAME — no two-phase discipline applies).
-- Drizzle mirror: `knowledgeSyncState` in db/schema.ts, same commit.

ALTER TABLE knowledge_sync_state
  ADD COLUMN IF NOT EXISTS high_water_mark TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_cursor TEXT,
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;

COMMENT ON COLUMN knowledge_sync_state.high_water_mark IS
  'Newest vendor change timestamp a successful connector sync ingested through (#4376). Incremental cycles fetch since (mark - overlap window). NULL for bundle-sync collections and before the first successful connector sync.';
COMMENT ON COLUMN knowledge_sync_state.sync_cursor IS
  'Opaque vendor continuation token persisted verbatim for non-timestamp change feeds (#4376). NULL when the connector does not use one.';
COMMENT ON COLUMN knowledge_sync_state.last_reconciled_at IS
  'When the last successful full reconciliation crawl finished (#4376). NULL forces reconciliation on the next cycle; cadence via ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS.';
