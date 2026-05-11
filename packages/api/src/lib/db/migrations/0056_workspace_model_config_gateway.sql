-- 0056 — workspace_model_config: gateway provider variant (#2173)
--
-- Extends workspace_model_config to support Vercel AI Gateway as a
-- workspace-level model provider. Two new shapes:
--   1. Platform-credit gateway: provider='gateway', api_key_encrypted IS NULL
--      → AI Layer uses the platform AI_GATEWAY_API_KEY env to instantiate
--      the gateway() model. Workspace picks any gateway-supported model.
--   2. BYOT gateway: provider='gateway', api_key_encrypted IS NOT NULL
--      → workspace brings its own gateway key; same picker.
--
-- Other providers (anthropic/openai/azure-openai/custom) keep BYOT-only
-- semantics — api_key_encrypted remains required for them via the new
-- chk_model_provider_key constraint below.
--
-- api_key_key_version stays NOT NULL DEFAULT 1; when api_key_encrypted
-- is NULL the version is a phantom default (decryptSecret is never
-- called for that row).

-- Drop old provider CHECK and replace with one that includes 'gateway'.
DO $$ BEGIN
  ALTER TABLE workspace_model_config DROP CONSTRAINT chk_model_provider;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE workspace_model_config
    ADD CONSTRAINT chk_model_provider
    CHECK (provider IN ('anthropic', 'openai', 'azure-openai', 'custom', 'gateway'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- api_key_encrypted becomes nullable to allow platform-credit gateway.
ALTER TABLE workspace_model_config
  ALTER COLUMN api_key_encrypted DROP NOT NULL;

-- Non-gateway providers must have a key (BYOT contract); gateway may not.
DO $$ BEGIN
  ALTER TABLE workspace_model_config
    ADD CONSTRAINT chk_model_provider_key
    CHECK (provider = 'gateway' OR api_key_encrypted IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
