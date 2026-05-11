-- 0059 — workspace_model_config: graceful unknown-model handling (#2275)
--
-- After a BYOT discovery refresh (#2274), the saved `model` may no
-- longer be in the upstream catalog (provider deprecation, regional
-- retirement, rename). Without these columns the workspace appears
-- healthy in the admin UI right up until the next chat fails with an
-- opaque upstream 404.
--
--   - `model_status` carries the per-row deprecation state. Default
--     `healthy` so existing rows don't need a backfill — the next
--     catalog refresh flips them appropriately.
--   - `model_suggested_replacement` is Atlas's best-effort closest
--     match (normalized edit distance, biased toward same-provider).
--     NULL when status is `healthy` or no acceptable match was found.
--
-- `setWorkspaceModelConfig` resets these to `('healthy', NULL)` on
-- every save so an admin who picks the suggestion (or any other model)
-- doesn't keep seeing the warning forever.

ALTER TABLE workspace_model_config
  ADD COLUMN IF NOT EXISTS model_status TEXT NOT NULL DEFAULT 'healthy';

ALTER TABLE workspace_model_config
  ADD COLUMN IF NOT EXISTS model_suggested_replacement TEXT;

DO $$ BEGIN
  ALTER TABLE workspace_model_config
    ADD CONSTRAINT chk_model_status
    CHECK (model_status IN ('healthy', 'deprecated'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
