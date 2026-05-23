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
-- without naming the new columns. Two BEFORE INSERT triggers + the
-- temporarily-retained (workspace_id, catalog_id) unique constraint
-- keep those callers green; slice 4 (WorkspaceInstaller, #2742) pivots
-- them onto the composite PK and slice 5/6 (#2743 / #2744) drops the
-- old unique + triggers.
--
-- Why the old (workspace_id, catalog_id) unique constraint lingers:
--   * Existing handler INSERTs ON CONFLICT (workspace_id, catalog_id)
--     target it explicitly. The new partial unique
--     `workspace_plugins_singleton` only covers chat + action pillars;
--     a bare ON CONFLICT (workspace_id, catalog_id) wouldn't bind to
--     a partial index without a matching WHERE clause. Keeping the
--     global unique avoids touching consumer SQL in this slice.
--   * Pre-cutover the new partial is a strict subset of the global
--     (every existing row is chat/action), so the two coexist
--     without conflict. Datasource multi-instance lands in #2743 /
--     #2744 which drops the global at the same time it pivots handlers.
--
-- A naming-drift note for slice 5/6: the 0014 baseline declared the
-- constraint as inline `UNIQUE(workspace_id, catalog_id)`, which
-- Postgres auto-names `workspace_plugins_workspace_id_catalog_id_key`.
-- The Drizzle mirror's logical name `idx_workspace_plugins_unique` does
-- NOT exist on disk in production PG — it's a pre-existing drift from
-- 0014. The slice 5/6 cleanup should `ALTER TABLE workspace_plugins
-- DROP CONSTRAINT workspace_plugins_workspace_id_catalog_id_key` (or
-- the migration-managed equivalent), NOT `DROP INDEX
-- idx_workspace_plugins_unique`. Aligning the Drizzle name with the
-- on-disk name is out of scope for this slice.
--
-- Migration-runner transaction guarantee: `runMigrations` wraps every
-- `.sql` file in a single `BEGIN` / `COMMIT` (see migrate.ts) under an
-- advisory lock, and the `ALTER TABLE` statements below take
-- `ACCESS EXCLUSIVE` — so the PK-swap window where neither the old `id`
-- PK nor the new composite PK is in force is invisible to concurrent
-- writers.

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
-- columns yet" — admin-marketplace.ts (admin catalog CRUD),
-- catalog-seeder.ts (boot-time catalog upsert from atlas.config.ts),
-- and migration 0088 all INSERT plugin_catalog rows without naming
-- pillar. The trigger derives pillar from `type` using the same
-- mapping as the backfill above so a stale call site stays valid.
-- Slice 3 (PillarCatalogQuery, #2741) and slice 5 (built-in Datasource
-- catalog rows, #2743) start naming pillar explicitly; this trigger
-- can be dropped when the seeder + admin route stop relying on it.
-- TODO(#2743): drop this trigger once all writers name pillar.
--
-- The `ELSE 'action'` branch is intentional but conservative: every
-- type value admitted by `chk_plugin_catalog_type` other than `chat`
-- and `datasource` (i.e. `context`, `interaction`, `sandbox`, the
-- pre-#2650 admin-UI grouping `integration`, and `action`) maps to
-- the `action` pillar. The first four shouldn't appear in any
-- production seed today; a `RAISE WARNING` surfaces the case in
-- Postgres logs so a stale self-host seed or a future typo is
-- visible without breaking the insert.
CREATE OR REPLACE FUNCTION plugin_catalog_default_pillar()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.pillar IS NULL THEN
    NEW.pillar := CASE NEW.type
      WHEN 'chat'        THEN 'chat'
      WHEN 'datasource'  THEN 'datasource'
      WHEN 'integration' THEN 'action'
      WHEN 'action'      THEN 'action'
      ELSE                    'action'
    END;
    IF NEW.type NOT IN ('chat', 'datasource', 'integration', 'action') THEN
      RAISE WARNING 'plugin_catalog: pillar defaulted to ''action'' for unexpected type % on row id=%', NEW.type, NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plugin_catalog_default_pillar ON plugin_catalog;
CREATE TRIGGER trg_plugin_catalog_default_pillar
BEFORE INSERT ON plugin_catalog
FOR EACH ROW EXECUTE FUNCTION plugin_catalog_default_pillar();

-- Companion BEFORE UPDATE trigger keeps pillar in sync when `type`
-- changes (the catalog-seeder upsert `SET type = EXCLUDED.type` and
-- the admin marketplace PATCH both UPDATE type on existing rows;
-- without this, pillar drifts and the workspace_plugins trigger
-- propagates the stale value into new install rows). The
-- `IS NOT DISTINCT FROM` guard preserves the no-clobber pattern:
-- a caller that updates both type AND pillar in the same statement
-- gets their explicit pillar; a caller that updates only type gets
-- a re-derivation. RAISE WARNING again surfaces unexpected type
-- values without aborting the update.
-- TODO(#2743): drop alongside the INSERT trigger once writers name
-- pillar explicitly.
CREATE OR REPLACE FUNCTION plugin_catalog_sync_pillar_on_type_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type
     AND NEW.pillar IS NOT DISTINCT FROM OLD.pillar THEN
    NEW.pillar := CASE NEW.type
      WHEN 'chat'        THEN 'chat'
      WHEN 'datasource'  THEN 'datasource'
      WHEN 'integration' THEN 'action'
      WHEN 'action'      THEN 'action'
      ELSE                    'action'
    END;
    IF NEW.type NOT IN ('chat', 'datasource', 'integration', 'action') THEN
      RAISE WARNING 'plugin_catalog: pillar re-derived to ''action'' for unexpected type % on row id=%', NEW.type, NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plugin_catalog_sync_pillar_on_type_change ON plugin_catalog;
CREATE TRIGGER trg_plugin_catalog_sync_pillar_on_type_change
BEFORE UPDATE ON plugin_catalog
FOR EACH ROW EXECUTE FUNCTION plugin_catalog_sync_pillar_on_type_change();

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
-- pillar from the joined catalog row (FK guarantees the row exists
-- at end-of-statement; the BEFORE trigger fires earlier than the FK
-- check, so we must surface a clear error here if the lookup misses)
-- and defaults install_id to catalog_id (singleton sentinel). Slice 4
-- (WorkspaceInstaller, #2742) pivots callers to name the columns
-- explicitly; slice 5/6 (#2743 / #2744) can then drop this trigger
-- along with the global unique index it pairs with.
-- TODO(#2743): drop this trigger once all writers name install_id +
-- pillar.
CREATE OR REPLACE FUNCTION workspace_plugins_default_pillar_install_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.install_id IS NULL THEN
    NEW.install_id := NEW.catalog_id;
  END IF;
  IF NEW.pillar IS NULL THEN
    SELECT pc.pillar INTO NEW.pillar FROM plugin_catalog pc WHERE pc.id = NEW.catalog_id;
    -- Postgres BEFORE INSERT triggers fire before FK enforcement, so
    -- an orphan catalog_id surfaces here as an empty SELECT, not as
    -- the more familiar FK-violation error. Raise an explicit 23503
    -- (foreign_key_violation) so the message names the actual root
    -- cause rather than the downstream "NULL value in column 'pillar'"
    -- the NOT NULL constraint would otherwise produce.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'workspace_plugins: catalog_id % not present in plugin_catalog', NEW.catalog_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
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
