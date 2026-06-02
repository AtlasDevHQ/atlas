-- Migration 0114: token_usage prompt-cache split (#3099).
--
-- AI Gateway → Anthropic now sends explicit `cacheControl` markers
-- (applyCacheControl / buildSystemParam treat a gateway route to an
-- Anthropic-family model like the direct Anthropic provider), so the agent
-- loop re-reads its long system+tools prefix from cache instead of re-billing
-- it at full input price on every step. The AI SDK surfaces the split on
-- `usage.inputTokenDetails.{cacheReadTokens,cacheWriteTokens}`; agent.ts
-- already logged it and now persists it here so the usage surface can compute
-- cache hit rate. (The usage-page gross-vs-billed labeling lands separately
-- in #3098 — this migration only owns the WRITE path.)
--
-- Nullable DEFAULT 0: existing rows backfill to 0 (no cache data was recorded
-- before this), and the INSERT path always supplies a value (`?? 0`), so the
-- columns never actually read NULL for rows written after this migration.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS cache_read_tokens integer DEFAULT 0;

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS cache_write_tokens integer DEFAULT 0;

COMMENT ON COLUMN token_usage.cache_read_tokens IS
  'Prompt-cache tokens served from cache this turn, summed across agent steps (~90% cheaper than fresh input). From usage.inputTokenDetails.cacheReadTokens. #3099.';
COMMENT ON COLUMN token_usage.cache_write_tokens IS
  'Prompt-cache tokens written to cache this turn, summed across agent steps (~25% premium over fresh input). From usage.inputTokenDetails.cacheWriteTokens. #3099.';
