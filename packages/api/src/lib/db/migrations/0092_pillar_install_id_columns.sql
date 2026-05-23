-- 0092_pillar_install_id_columns.sql
--
-- 1.5.3 slice 1 (#2739 / PRD #2738 / ADR-0006 + ADR-0007) — schema
-- foundation for the three-pillar taxonomy (Datasource / Chat / Action)
-- and the unified install pipeline.
--
-- Adds the columns + constraints + indexes that subsequent 1.5.3 slices
-- (PillarCatalogQuery #2741, WorkspaceInstaller #2742,
-- DatasourcePoolResolver #2743, the connections-table cutover #2744)
-- will consume. NO production code reads or writes the new columns
-- yet — existing INSERT call sites under
-- packages/api/src/lib/integrations/install/*-handler.ts continue to
-- INSERT (id, workspace_id, catalog_id, config, enabled, installed_at)
-- without naming the new columns. A BEFORE INSERT trigger + the
-- temporarily-retained `idx_workspace_plugins_unique` index keep
-- those callers green; slice 4 (WorkspaceInstaller) pivots them onto
-- the composite PK and slice 5/6 drops the old unique + trigger.
--
-- Why the old (workspace_id, catalog_id) unique index lingers:
--   * Existing handler INSERTs ON CONFLICT (workspace_id, catalog_id)
--     target it explicitly. The new partial unique
--     `workspace_plugins_singleton` only covers chat + action pillars;
--     a bare ON CONFLICT (workspace_id, catalog_id) wouldn't bind to
--     a partial index without a matching WHERE clause. Keeping the
--     global unique avoids touching consumer SQL in this slice.
--   * Pre-cutover the new partial is a strict subset of the global
--     (every existing row is chat/action), so the two coexist
--     without conflict. Datasource multi-instance lands in slice 5/6
--     which drops the global at the same time it pivots handlers.

-- ---------------------------------------------------------------------------
-- plugin_catalog: pillar, implementation_status, auto_install
-- ---------------------------------------------------------------------------

ALTER TABLE plugin_catalog
  ADD COLUMN IF NOT EXISTS pillar TEXT;

ALTER TABLE plugin_catalog
  ADD COLUMN IF NOT EXISTS implementation_status TEXT NOT NULL DEFAULT 'available';

ALTER TABLE plugin_catalog
  ADD COLUMN IF NOT EXISTS auto_install BOOLEAN NOT NULL DEFAULT false;

-- Backfill pillar from existing `type` per ADR-0006:
--   chat        → chat
--   integration → action  (current admin-UI grouping for everything
--                 customer-installable that isn't chat)
--   datasource  → datasource  (no rows today, future-proof)
--   action      → action  (pre-#2650 type with semantically-matching
--                 pillar)
--   context | interaction | sandbox → action  (degenerate fallback;
--                 production catalogs don't hold these today but
--                 0087's CHECK admits them; defaulting to `action`
--                 keeps the upcoming NOT NULL gate green if a stale
--                 self-host seed has one)
UPDATE plugin_catalog SET pillar = 'chat'       WHERE pillar IS NULL AND type = 'chat';
UPDATE plugin_catalog SET pillar = 'datasource' WHERE pillar IS NULL AND type = 'datasource';
UPDATE plugin_catalog SET pillar = 'action'     WHERE pillar IS NULL;

ALTER TABLE plugin_catalog ALTER COLUMN pillar SET NOT NULL;

ALTER TABLE plugin_catalog
  DROP CONSTRAINT IF EXISTS chk_plugin_catalog_pillar;
ALTER TABLE plugin_catalog
  ADD CONSTRAINT chk_plugin_catalog_pillar
  CHECK (pillar IN ('datasource', 'chat', 'action'));

ALTER TABLE plugin_catalog
  DROP CONSTRAINT IF EXISTS chk_plugin_catalog_implementation_status;
ALTER TABLE plugin_catalog
  ADD CONSTRAINT chk_plugin_catalog_implementation_status
  CHECK (implementation_status IN ('available', 'coming_soon'));

-- BEFORE INSERT trigger fills pillar when callers omit it. Slice 1's
-- acceptance criterion is "no production code reads or writes the new
-- columns yet" — admin-marketplace.ts:325 (admin catalog CRUD),
-- catalog-seeder.ts:513 (boot-time catalog upsert from atlas.config.ts),
-- and migration 0088 all INSERT plugin_catalog rows without naming
-- pillar. The trigger derives pillar from `type` using the same
-- mapping as the backfill above so a stale call site stays valid.
-- Slice 3 (PillarCatalogQuery) and slice 5 (built-in Datasource
-- catalog rows) start naming pillar explicitly; this trigger can be
-- dropped when the seeder + admin route stop relying on it.
CREATE OR REPLACE FUNCTION plugin_catalog_default_pillar()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.pillar IS NULL THEN
    NEW.pillar := CASE NEW.type
      WHEN 'chat'       THEN 'chat'
      WHEN 'datasource' THEN 'datasource'
      ELSE                   'action'
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plugin_catalog_default_pillar ON plugin_catalog;
CREATE TRIGGER trg_plugin_catalog_default_pillar
BEFORE INSERT ON plugin_catalog
FOR EACH ROW EXECUTE FUNCTION plugin_catalog_default_pillar();

-- ---------------------------------------------------------------------------
-- workspace_plugins: install_id, pillar, composite PK
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_plugins
  ADD COLUMN IF NOT EXISTS install_id TEXT;

ALTER TABLE workspace_plugins
  ADD COLUMN IF NOT EXISTS pillar TEXT;

-- Backfill install_id = catalog_id (singleton sentinel — pre-1.5.3
-- every (workspace, catalog) is unique under the old global unique,
-- so catalog_id can't collide with itself within a workspace).
UPDATE workspace_plugins
SET install_id = catalog_id
WHERE install_id IS NULL;

-- Backfill pillar from the joined catalog row (populated above).
UPDATE workspace_plugins wp
SET pillar = pc.pillar
FROM plugin_catalog pc
WHERE pc.id = wp.catalog_id AND wp.pillar IS NULL;

-- Fail loud if any row still NULL — would indicate an orphan
-- workspace_plugins row whose catalog_id doesn't resolve. The FK
-- normally prevents this, but a self-host that bypassed Drizzle
-- could have one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspace_plugins WHERE install_id IS NULL OR pillar IS NULL) THEN
    RAISE EXCEPTION 'workspace_plugins backfill incomplete — orphan rows without resolvable catalog?';
  END IF;
END $$;

ALTER TABLE workspace_plugins ALTER COLUMN install_id SET NOT NULL;
ALTER TABLE workspace_plugins ALTER COLUMN pillar SET NOT NULL;

ALTER TABLE workspace_plugins
  DROP CONSTRAINT IF EXISTS chk_workspace_plugins_pillar;
ALTER TABLE workspace_plugins
  ADD CONSTRAINT chk_workspace_plugins_pillar
  CHECK (pillar IN ('datasource', 'chat', 'action'));

-- BEFORE INSERT trigger fills install_id + pillar when callers omit
-- them. Slice 1's acceptance criterion is "no production code reads
-- or writes the new columns yet" — the existing handler INSERTs
-- under packages/api/src/lib/integrations/install/*-handler.ts
-- continue to INSERT (id, workspace_id, catalog_id, config, enabled,
-- installed_at) without naming the new columns. The trigger looks up
-- pillar from the joined catalog row (FK guarantees the row exists)
-- and defaults install_id to catalog_id (singleton sentinel). Slice 4
-- (WorkspaceInstaller) pivots callers to name the columns explicitly;
-- slice 5/6 can then drop this trigger along with the global unique
-- index it pairs with.
CREATE OR REPLACE FUNCTION workspace_plugins_default_pillar_install_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.install_id IS NULL THEN
    NEW.install_id := NEW.catalog_id;
  END IF;
  IF NEW.pillar IS NULL THEN
    SELECT pc.pillar INTO NEW.pillar FROM plugin_catalog pc WHERE pc.id = NEW.catalog_id;
    -- If catalog lookup fails (shouldn't happen — FK enforces
    -- existence at constraint-check time), NEW.pillar stays NULL
    -- and the NOT NULL constraint rejects the row with a clear
    -- error rather than silently defaulting to an arbitrary pillar.
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workspace_plugins_default_pillar_install_id ON workspace_plugins;
CREATE TRIGGER trg_workspace_plugins_default_pillar_install_id
BEFORE INSERT ON workspace_plugins
FOR EACH ROW EXECUTE FUNCTION workspace_plugins_default_pillar_install_id();

-- Swap PK: single `id` → composite (workspace_id, catalog_id, install_id).
-- Retain `id` as a unique-indexed column so existing handler INSERTs
-- that RETURNING id (email/obsidian/webhook/salesforce/jira/slack)
-- keep working until slice 4 pivots them onto the composite PK.
ALTER TABLE workspace_plugins DROP CONSTRAINT IF EXISTS workspace_plugins_pkey;
ALTER TABLE workspace_plugins ADD PRIMARY KEY (workspace_id, catalog_id, install_id);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_plugins_id_unique
  ON workspace_plugins (id);

-- New partial unique index — singleton enforcement for chat + action
-- pillars. Datasource pillar admits multiple installs per (workspace,
-- catalog) once slice 5/6 lands. Until then this index is a strict
-- subset of `idx_workspace_plugins_unique` (every existing row is
-- chat or action), so the two coexist without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_plugins_singleton
  ON workspace_plugins (workspace_id, catalog_id)
  WHERE pillar IN ('chat', 'action');
