-- 0058 — workspace_model_catalog: DB-backed BYOT discovery cache (#2274)
--
-- The per-provider catalog modules (anthropic/openai/bedrock) keep an
-- in-memory cache scoped per pod. That's fine for L1 (request-burst
-- dedup), but in a multi-pod region each pod cold-starts independently
-- and hammers upstream on first request — and a pod restart wipes the
-- cache entirely. This table is the L2: cross-pod, survival-across-
-- restart catalog cache. Read-through pattern: per-provider module
-- checks in-mem → DB → upstream → write both back.
--
-- One row per (org_id, provider, region) so bedrock entries don't
-- collide when a workspace migrates between regions. `region` is the
-- empty string for non-bedrock providers (anthropic / openai catalogs
-- are not region-scoped).
--
-- `payload` is the wire shape of the catalog response (`GatewayCatalogResponse`-
-- compatible JSON). We store it as JSONB so the scheduler refresh job
-- can introspect entries cheaply when it implements deprecation
-- detection (#2275).
--
-- This is an OPERATIONAL cache — not user-surfaced content — so it
-- intentionally bypasses the content-mode system. No status column, no
-- mode-overlay reads, no participation in the admin Publish flow.

CREATE TABLE IF NOT EXISTS workspace_model_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- Empty string for non-region-scoped providers so the unique constraint
  -- stays simple. Bedrock writes the actual region (us-east-1, etc.).
  region TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identity constraint: one entry per (org, provider, region) tuple.
DO $$ BEGIN
  ALTER TABLE workspace_model_catalog
    ADD CONSTRAINT uq_workspace_model_catalog_org_provider_region
    UNIQUE (org_id, provider, region);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Provider whitelist: stays in lockstep with chk_model_provider on
-- workspace_model_config. 'gateway' is excluded because the gateway
-- catalog is anonymous + globally cached — there's no per-workspace
-- entry to persist.
DO $$ BEGIN
  ALTER TABLE workspace_model_catalog
    ADD CONSTRAINT chk_workspace_model_catalog_provider
    CHECK (provider IN ('anthropic', 'openai', 'bedrock'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_model_catalog_org_provider
  ON workspace_model_catalog (org_id, provider);

-- For the periodic refresh job: find rows with the oldest fetched_at
-- and walk them in order. Partial index keeps the scan tight.
CREATE INDEX IF NOT EXISTS idx_workspace_model_catalog_fetched_at
  ON workspace_model_catalog (fetched_at);
