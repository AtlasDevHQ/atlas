-- 0057 — workspace_model_config: bedrock provider variant (#2273)
--
-- Extends workspace_model_config to support AWS Bedrock as a BYOT
-- provider. New shape:
--   - provider='bedrock', api_key_encrypted = JSON blob shaped as
--     `{ accessKeyId, secretAccessKey, sessionToken? }` (encrypted via
--     encryptUrl, which round-trips a string — callers stringify before
--     encrypt and parse after decrypt).
--   - bedrock_region = AWS region (us-east-1, us-west-2, ap-northeast-1, …).
--     Region is part of the catalog identity: Bedrock surfaces a different
--     model set per region.
--
-- A bedrock row MUST have a region; every other provider MUST leave it NULL.
-- The chk_model_provider_region constraint below enforces that.

-- Drop old provider CHECK and replace with one that includes 'bedrock'.
DO $$ BEGIN
  ALTER TABLE workspace_model_config DROP CONSTRAINT chk_model_provider;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE workspace_model_config
    ADD CONSTRAINT chk_model_provider
    CHECK (provider IN ('anthropic', 'openai', 'azure-openai', 'custom', 'gateway', 'bedrock'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Region column. Nullable at the column level so non-bedrock rows can
-- leave it NULL; the CHECK below enforces NOT NULL when provider='bedrock'.
ALTER TABLE workspace_model_config
  ADD COLUMN IF NOT EXISTS bedrock_region TEXT;

DO $$ BEGIN
  ALTER TABLE workspace_model_config
    ADD CONSTRAINT chk_model_provider_region
    CHECK (provider != 'bedrock' OR bedrock_region IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
