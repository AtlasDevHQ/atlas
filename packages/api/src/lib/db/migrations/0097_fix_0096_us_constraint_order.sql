-- 0097_fix_0096_us_constraint_order.sql
--
-- Forward-fix for #2744 cutover. Migration 0096 failed at apply time on
-- the us-int-postgres region with:
--
--   ERROR: duplicate key value violates unique constraint
--          "workspace_plugins_workspace_id_catalog_id_key"
--   DETAIL: Key (workspace_id, catalog_id)=(<orgId>, catalog:postgres)
--          already exists.
--
-- Root cause: 0096 step 2 INSERTs backfilled `connections` rows into
-- `workspace_plugins` BEFORE step 6 dropped the pre-cutover unique
-- constraint on `(workspace_id, catalog_id)` (auto-named from 0014's
-- inline UNIQUE). Any workspace that owned two datasource installs of
-- the same dbType (e.g. two postgres connections in the same workspace)
-- hit the constraint before step 6 got a chance to drop it. The us-int-
-- postgres region had real production data with that shape; apac/eu had
-- no connections rows to backfill so step 2 was a no-op there and 0096
-- succeeded.
--
-- Because 0096 wraps everything in BEGIN/COMMIT under the migration
-- runner's advisory lock, the failure rolled back ALL of 0096 on us —
-- the region is at pre-0096 schema (workspace_plugins missing status
-- + updated_at columns, connections + connection_groups tables still
-- present). apac + eu are at full post-0096 state.
--
-- This migration is conditional on `connections` table existence so it
-- runs the full cutover on us-int-postgres and is a no-op on apac/eu.
-- The ordering is fixed: drop the legacy unique FIRST, then backfill,
-- then drop the source tables. Otherwise mirrors 0096's logic.

DO $$
DECLARE
  orphan_count INTEGER;
  mismatch_count INTEGER;
  demo_url_count INTEGER;
  conflicting_demo_count INTEGER;
  missing_demo_count INTEGER;
  excess_demo_count INTEGER;
  fixed_count INTEGER;
BEGIN
  -- ---------------------------------------------------------------------------
  -- Region detection: only run if `connections` table still exists. On
  -- apac/eu (where 0096 succeeded) the table is gone and this whole
  -- migration becomes a no-op.
  -- ---------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'connections'
  ) THEN
    RAISE NOTICE '0097: connections table absent — 0096 already succeeded on this region, skipping';
    RETURN;
  END IF;

  RAISE NOTICE '0097: connections table present — replaying 0096 with the constraint-order fix';

  -- ---------------------------------------------------------------------------
  -- Step 0 (NEW): Drop the legacy unique constraint FIRST so the
  -- backfill INSERT doesn't trip on the pre-cutover invariant.
  -- ---------------------------------------------------------------------------
  ALTER TABLE workspace_plugins DROP CONSTRAINT IF EXISTS workspace_plugins_workspace_id_catalog_id_key;
  DROP INDEX IF EXISTS idx_workspace_plugins_unique;

  -- ---------------------------------------------------------------------------
  -- Step 1: workspace_plugins.status + updated_at columns
  -- ---------------------------------------------------------------------------
  ALTER TABLE workspace_plugins
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

  ALTER TABLE workspace_plugins
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

  UPDATE workspace_plugins
     SET updated_at = installed_at
   WHERE updated_at IS NULL OR updated_at < installed_at;

  ALTER TABLE workspace_plugins
    DROP CONSTRAINT IF EXISTS chk_workspace_plugins_status;
  ALTER TABLE workspace_plugins
    ADD CONSTRAINT chk_workspace_plugins_status
    CHECK (status IN ('published', 'draft', 'archived'));

  CREATE INDEX IF NOT EXISTS idx_workspace_plugins_status
    ON workspace_plugins (workspace_id, status);

  -- ---------------------------------------------------------------------------
  -- Step 1b: Fix demo-postgres catalog config_schema (same as 0096)
  -- ---------------------------------------------------------------------------
  UPDATE plugin_catalog
     SET config_schema = '[
           {"key": "url", "type": "string", "label": "Connection URL", "required": true, "secret": true, "description": "postgresql://user:pass@host:5432/database"},
           {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
         ]'::jsonb,
         updated_at = NOW()
   WHERE slug = 'demo-postgres' AND pillar = 'datasource';

  SELECT COUNT(*) INTO fixed_count
    FROM plugin_catalog
   WHERE slug = 'demo-postgres'
     AND pillar = 'datasource'
     AND config_schema @> '[{"key": "url", "secret": true}]'::jsonb;
  IF fixed_count != 1 THEN
    RAISE EXCEPTION
      'demo-postgres catalog config_schema fix expected exactly 1 row with secret-url field, got %', fixed_count;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Step 2: Backfill workspace_plugins from connections — now safe
  -- because the legacy unique is gone.
  -- ---------------------------------------------------------------------------
  INSERT INTO workspace_plugins
    (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, status)
  SELECT
    CASE
      WHEN c.org_id = '__global__' THEN 'cn_global_' || c.id
      ELSE 'cn_' || left(c.org_id, 16) || '_' || c.id
    END                                                      AS id,
    c.org_id                                                 AS workspace_id,
    pc.id                                                    AS catalog_id,
    c.id                                                     AS install_id,
    'datasource'                                             AS pillar,
    jsonb_strip_nulls(
      jsonb_build_object(
        'url',         c.url,
        'schema',      c.schema_name,
        'description', c.description,
        'db_type',     c.type,
        'group_id',    c.group_id
      )
    )                                                        AS config,
    (c.status != 'archived')                                 AS enabled,
    COALESCE(c.created_at, NOW())                            AS installed_at,
    c.status                                                 AS status
  FROM connections c
  JOIN plugin_catalog pc
    ON pc.pillar = 'datasource'
   AND pc.slug = CASE
     WHEN c.id = '__demo__' THEN 'demo-postgres'
     ELSE c.type
   END
  WHERE NOT (c.org_id = '__global__' AND c.id = '__demo__')
  ON CONFLICT (workspace_id, catalog_id, install_id) DO NOTHING;

  SELECT COUNT(*) INTO orphan_count
    FROM connections c
   WHERE NOT (c.org_id = '__global__' AND c.id = '__demo__')
     AND NOT EXISTS (
       SELECT 1 FROM workspace_plugins wp
        WHERE wp.workspace_id = c.org_id
          AND wp.install_id = c.id
          AND wp.pillar = 'datasource'
     );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'connections-to-workspace_plugins backfill incomplete: % rows did not migrate',
      orphan_count;
  END IF;

  SELECT COUNT(*) INTO mismatch_count
    FROM connections c
    JOIN workspace_plugins wp ON wp.workspace_id = c.org_id AND wp.install_id = c.id AND wp.pillar = 'datasource'
    JOIN plugin_catalog pc ON pc.id = wp.catalog_id
   WHERE NOT (c.org_id = '__global__' AND c.id = '__demo__')
     AND pc.slug != CASE WHEN c.id = '__demo__' THEN 'demo-postgres' ELSE c.type END;
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION
      'connections-to-workspace_plugins catalog mismatch: % rows landed on the wrong catalog row',
      mismatch_count;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Step 3: Per-workspace demo install backfill. Inline copy of the 0096
  -- step 3 with the same `IF EXISTS organization` guard.
  -- ---------------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'organization'
  ) THEN
    SELECT COUNT(*) INTO demo_url_count
      FROM connections WHERE id = '__demo__' AND org_id = '__global__';
    IF demo_url_count = 0 THEN
      RAISE NOTICE '0097 step 3: no `__demo__` connection row to backfill from — skipping per-workspace demo backfill';
    ELSIF demo_url_count > 1 THEN
      RAISE EXCEPTION
        'connections (__demo__, __global__) returned % rows — expected exactly 1',
        demo_url_count;
    ELSE
      SELECT COUNT(*) INTO conflicting_demo_count
        FROM workspace_plugins wp
        JOIN plugin_catalog pc ON pc.id = wp.catalog_id
       WHERE wp.pillar = 'datasource'
         AND pc.slug = 'demo-postgres'
         AND wp.install_id != '__demo__';
      IF conflicting_demo_count > 0 THEN
        RAISE EXCEPTION
          'Found % workspace_plugins row(s) of catalog demo-postgres with install_id != ''__demo__''',
          conflicting_demo_count;
      END IF;

      INSERT INTO workspace_plugins
        (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, status)
      SELECT
        'cn_demo_' || o.id                                       AS id,
        o.id                                                     AS workspace_id,
        (SELECT id FROM plugin_catalog WHERE slug = 'demo-postgres' LIMIT 1) AS catalog_id,
        '__demo__'                                               AS install_id,
        'datasource'                                             AS pillar,
        jsonb_strip_nulls(
          jsonb_build_object(
            'url',         (SELECT url FROM connections WHERE id = '__demo__' AND org_id = '__global__' LIMIT 1),
            'description', 'Atlas-managed demo Postgres dataset',
            'db_type',     'postgres'
          )
        )                                                        AS config,
        true                                                     AS enabled,
        NOW()                                                    AS installed_at,
        'published'                                              AS status
      FROM organization o
      WHERE NOT EXISTS (
        SELECT 1 FROM workspace_plugins wp
         WHERE wp.workspace_id = o.id
           AND wp.install_id = '__demo__'
           AND wp.pillar = 'datasource'
      )
      ON CONFLICT (workspace_id, catalog_id, install_id) DO NOTHING;

      SELECT COUNT(*) INTO missing_demo_count
        FROM organization o
       WHERE NOT EXISTS (
         SELECT 1 FROM workspace_plugins wp
          JOIN plugin_catalog pc ON pc.id = wp.catalog_id
         WHERE wp.workspace_id = o.id
           AND wp.pillar = 'datasource'
           AND pc.slug = 'demo-postgres'
       );
      IF missing_demo_count > 0 THEN
        RAISE EXCEPTION
          'Demo backfill incomplete: % organization(s) have no demo-postgres install',
          missing_demo_count;
      END IF;

      SELECT COUNT(*) INTO excess_demo_count
        FROM (
          SELECT wp.workspace_id, COUNT(*) AS n
            FROM workspace_plugins wp
            JOIN plugin_catalog pc ON pc.id = wp.catalog_id
           WHERE wp.pillar = 'datasource' AND pc.slug = 'demo-postgres'
           GROUP BY wp.workspace_id
          HAVING COUNT(*) > 1
        ) dup;
      IF excess_demo_count > 0 THEN
        RAISE EXCEPTION
          'Found % organization(s) with more than one demo-postgres install',
          excess_demo_count;
      END IF;
    END IF;
  ELSE
    RAISE NOTICE '0097 step 3: organization table absent — skipping per-workspace demo backfill';
  END IF;

  -- ---------------------------------------------------------------------------
  -- Step 4: Drop FK constraints
  -- ---------------------------------------------------------------------------
  ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS fk_scheduled_tasks_group;
  ALTER TABLE approval_queue DROP CONSTRAINT IF EXISTS fk_approval_queue_group;

  -- ---------------------------------------------------------------------------
  -- Step 5: Drop the legacy tables
  -- ---------------------------------------------------------------------------
  DROP TABLE IF EXISTS connections CASCADE;
  DROP TABLE IF EXISTS connection_groups CASCADE;

  -- ---------------------------------------------------------------------------
  -- Step 7: Drop the 0092 back-compat triggers
  -- ---------------------------------------------------------------------------
  DROP TRIGGER IF EXISTS trg_workspace_plugins_default_pillar_install_id
    ON workspace_plugins;
  DROP FUNCTION IF EXISTS workspace_plugins_default_pillar_install_id() CASCADE;

  DROP TRIGGER IF EXISTS trg_plugin_catalog_default_pillar
    ON plugin_catalog;
  DROP FUNCTION IF EXISTS plugin_catalog_default_pillar() CASCADE;

  DROP TRIGGER IF EXISTS trg_plugin_catalog_sync_pillar_on_type_change
    ON plugin_catalog;
  DROP FUNCTION IF EXISTS plugin_catalog_sync_pillar_on_type_change() CASCADE;

  RAISE NOTICE '0097: cutover replay complete';
END $$;
