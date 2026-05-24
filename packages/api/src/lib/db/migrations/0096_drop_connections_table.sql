-- 0096_drop_connections_table.sql
--
-- 1.5.3 slice 6 (#2744 / PRD #2738 / ADR-0007) — THE CUTOVER.
--
-- Atomic, irreversible. Drops the `connections` and `connection_groups`
-- tables in favour of the unified install pipeline through
-- `workspace_plugins` (`pillar = 'datasource'`). The deployment posture
-- (two internal Workspaces, no external customers) licenses dropping
-- both tables in one shot, per ADR-0007's clean-break clause; if an
-- external customer onboards after this lands, the recovery is a
-- restore-from-backup not a forward-fix.
--
-- ## What this migration does, in order:
--   1. Adds `workspace_plugins.status` (text, default 'published') with
--      a CHECK constraint mirroring `connections.status`. Drafts and
--      archived status survived previously as `enabled=false`; the
--      explicit column lets the content-mode middleware filter without
--      a separate Drizzle mapping.
--   2. Backfills `workspace_plugins` rows from every row of `connections`,
--      copying the URL ciphertext verbatim into `config->>'url'`. **The
--      two encryption modules in this repo produce identical AES-256-GCM
--      `enc:v<N>:iv:authTag:ciphertext`**, so re-encryption is a no-op —
--      `decryptSecretFields` reads what `db/internal.ts::encryptSecret`
--      wrote. The companion sanity-check in
--      `migrations/scripts/0096_connections_to_workspace_plugins.ts`
--      verifies round-trip decryption on every migrated row.
--   3. Backfills a `demo-postgres` install for every organization that
--      doesn't already own one (the `auto_install: true` catalog row's
--      runtime equivalent — every workspace now owns its own demo
--      install row, archived per-workspace to hide).
--   4. Drops the four hard FK constraints that pointed at `connections`
--      or `connection_groups`. The composite FKs on
--      `scheduled_tasks.connection_group_id` and
--      `approval_queue.connection_group_id` become free-form text
--      identifiers — they still match `workspace_plugins.config->>'group_id'`
--      because we copy the existing `connections.group_id` verbatim
--      into the new JSONB config. `conversations.connection_group_id`,
--      `semantic_entities.connection_group_id`, and
--      `dashboard_cards.connection_group_id` already had no DB FK
--      (per the org-scoping notes in 0063 / 0066 / 0067) — they keep
--      their semantics unchanged.
--   5. Drops `connections` table. Drops `connection_groups` table.
--   6. Drops `workspace_plugins.idx_workspace_plugins_unique` (the
--      pre-1.5.3 global unique that 0092 retained as a temporary
--      backstop) and the on-disk auto-named
--      `workspace_plugins_workspace_id_catalog_id_key` constraint that
--      mirrors it. The `workspace_plugins_singleton` partial unique
--      (chat/action only) from 0092 is now the sole singleton gate;
--      datasource installs become legitimately multi-instance per
--      (workspace, catalog).
--   7. Drops the three BEFORE INSERT/UPDATE triggers added by 0092
--      (`trg_workspace_plugins_default_pillar_install_id`,
--      `trg_plugin_catalog_default_pillar`,
--      `trg_plugin_catalog_sync_pillar_on_type_change`) — every writer
--      now names `pillar` + `install_id` explicitly per slice 4 + slice 5
--      changes.
--
-- ## Re-encryption: why this is SQL-only
--
-- Per ADR-0007 § "Credential storage" the URL ciphertext format is
-- identical between `db/internal.ts::encryptSecret` (URL-aware) and
-- `db/secret-encryption.ts::encryptSecret` (versioned-prefix-only):
--   `enc:v${version}:${base64-iv}:${base64-authTag}:${base64-ciphertext}`
-- Both helpers run AES-256-GCM with the same IV length (12) and auth-tag
-- length (16), keyed off `getEncryptionKeyset()` which is module-shared.
-- The only divergence is the plaintext-detection branch on read, which
-- decides whether a non-prefixed string is plaintext or an error —
-- irrelevant on the write side. So copying `connections.url` (already
-- in `enc:v<N>:...` form post-F-47 backfill) byte-for-byte into
-- `workspace_plugins.config->>'url'` is correct: `decryptSecretFields`
-- recognises the prefix, parses the body, decrypts successfully.
--
-- The previous design (per the issue body) called for a TS migrator
-- that decrypts via `db/internal.ts` then re-encrypts via
-- `encryptSecretFields`. That round-trip is a strict no-op because
-- `encryptSecretFields` is idempotent against already-`enc:v1:`
-- ciphertext (see `secret-encryption.ts::isEncryptedSecret`). The SQL
-- backfill is the right shape; the TS companion is a sanity-check
-- harness — not a required-for-correctness migration step.
--
-- ## connection_groups disposition
--
-- Per ADR-0007 § "connection_groups disposition" (pure-collapse option):
-- the table goes entirely. The named-group abstraction (with
-- active/archived lifecycle, primary pin, per-org unique name index)
-- collapses into denormalised JSONB inside each `workspace_plugins.config`.
-- A "group" becomes implicit: any N rows sharing `config->>'group_id'`
-- belong to the same group. Existing per-org unique-name enforcement
-- moves out of the DB; app code MAY enforce it on the admin route, but
-- the DB no longer does.
--
-- This minimises call-site churn: every existing `connection_group_id`
-- column (`scheduled_tasks`, `approval_queue`, `conversations`,
-- `semantic_entities`, `dashboard_cards`) keeps its name and semantics
-- — the value still identifies a group, just one that no longer has a
-- backing row. FKs that pointed at `connection_groups(id, org_id)` are
-- dropped; the columns stay as free-form text identifiers, exactly as
-- `conversations.connection_group_id` already worked.
--
-- ## Migration-runner transaction guarantee
--
-- `runMigrations` wraps this entire file in a single `BEGIN` / `COMMIT`
-- under an advisory lock (see migrate.ts). If any statement below
-- fails, the whole migration aborts — no partial state where some
-- `workspace_plugins` rows exist but `connections` is dropped. The
-- DROP TABLEs are the last DDL on purpose so a backfill failure leaves
-- the source data intact.

-- ---------------------------------------------------------------------------
-- 1. workspace_plugins.status + updated_at — content-mode columns
-- ---------------------------------------------------------------------------
--
-- `status` is the content-mode column (draft / published / archived). The
-- existing `enabled` boolean stays for back-compat; admin-connections.ts
-- post-cutover treats `enabled = (status != 'archived')` (the legacy
-- writer of `enabled` is the chat/action handler chain, which always
-- writes `enabled = true`).
--
-- `updated_at` is required by the content-mode registry's `simplePromoteSql`
-- (`UPDATE … SET status='published', updated_at = now()`). The other
-- content-mode tables (`connections`, `prompt_collections`,
-- `query_suggestions`, `semantic_entities`) all carry one; workspace_plugins
-- is the outlier and inherits the column now that it participates in the
-- mode system as the post-cutover `connections` substitute. Default
-- `installed_at` so backfilled rows have a sensible value before any
-- write happens.

ALTER TABLE workspace_plugins
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

ALTER TABLE workspace_plugins
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill `updated_at` from `installed_at` for any row created before
-- this migration (the DEFAULT clause only applies to future inserts).
-- Idempotent: if the column already existed (theoretical re-run), the
-- WHERE clause matches no rows because the seed paths now write both
-- columns explicitly.
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
-- 1b. Fix demo-postgres catalog config_schema (#2744 review finding)
-- ---------------------------------------------------------------------------
--
-- 0093 seeded `demo-postgres` with `config_schema = '[]'`. Empty schemas
-- cause `encryptSecretFields` / `decryptSecretFields` to short-circuit
-- (see `db/secret-encryption.ts`) — meaning step 3 below would copy demo
-- URL ciphertext into `workspace_plugins.config.url`, and `loadSavedConnections`
-- on boot would try to register that ciphertext as a Postgres URL. Every
-- demo install would be unreachable, and a future admin PUT through
-- `updateDatasourceConfig` would write the new URL as plaintext.
--
-- Patch the catalog row to declare `url` as a secret field, matching the
-- `postgres` row's shape. Reads after this point round-trip ciphertext
-- through `decryptSecret` correctly; future writes encrypt.
UPDATE plugin_catalog
   SET config_schema = '[
         {"key": "url", "type": "string", "label": "Connection URL", "required": true, "secret": true, "description": "postgresql://user:pass@host:5432/database"},
         {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
       ]'::jsonb,
       updated_at = NOW()
 WHERE slug = 'demo-postgres' AND pillar = 'datasource';

-- Post-flight: the UPDATE must have flipped exactly one row. Zero means
-- 0093 never ran (impossible in the migration runner's linear order);
-- more than one means a duplicate snuck in.
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO fixed_count
    FROM plugin_catalog
   WHERE slug = 'demo-postgres'
     AND pillar = 'datasource'
     AND config_schema @> '[{"key": "url", "secret": true}]'::jsonb;
  IF fixed_count != 1 THEN
    RAISE EXCEPTION
      'demo-postgres catalog config_schema fix expected exactly 1 row with secret-url field, got %', fixed_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Backfill workspace_plugins from connections
-- ---------------------------------------------------------------------------
--
-- For every `connections` row, insert a corresponding
-- `workspace_plugins` row of the appropriate built-in Datasource
-- catalog. `connections.type` → catalog slug 1:1 (`postgres`, `mysql`,
-- `snowflake`, etc.); the `__demo__` connection always lands as
-- `demo-postgres` regardless of its `type`. The `__global__`-owned
-- `__demo__` row is skipped here — step 3 backfills per-workspace
-- demo installs that replace it.
--
-- The URL ciphertext is copied verbatim into `config->>'url'`. The
-- `config->>'group_id'` JSONB key preserves the existing
-- `connections.group_id` so the no-FK `connection_group_id` columns
-- in conversations/semantic_entities/dashboard_cards keep matching.

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
-- Skip the `__global__` demo row — step 3 replaces it per-workspace.
WHERE NOT (c.org_id = '__global__' AND c.id = '__demo__')
ON CONFLICT (workspace_id, catalog_id, install_id) DO NOTHING;

-- Fail-loud guard: every non-special connection row must have produced
-- a `workspace_plugins` row AND landed on the catalog matching its
-- `type` (`__demo__` → `demo-postgres`). The slug-match assertion
-- catches a future drift where two catalogs claim the same slug or
-- the JOIN matches the wrong row.
DO $$
DECLARE
  orphan_count INTEGER;
  mismatch_count INTEGER;
BEGIN
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
      'connections-to-workspace_plugins backfill incomplete: % rows did not migrate (unknown connections.type / missing catalog slug)',
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
END $$;

-- ---------------------------------------------------------------------------
-- 3. Demo auto_install backfill — per-workspace demo install
-- ---------------------------------------------------------------------------
--
-- Every existing organization gets a `demo-postgres` install row. This
-- replaces the legacy `connections (id='__demo__', org_id='__global__')`
-- + per-org tombstone overlay model: archiving the per-workspace row
-- now hides the demo from that workspace only, with no shared state.
--
-- The pre-existing `__global__` demo row's URL ciphertext flows into
-- the auto-install rows so existing dogfood + atlas-prod deployments
-- keep pointing at the same operator-shared demo dataset. Workspaces
-- that already migrated their own `__demo__` row in step 2 (because a
-- per-org override existed) keep that override; this step's NOT EXISTS
-- + ON CONFLICT keeps the operation idempotent.

-- The per-workspace demo backfill reads Better Auth's `organization`
-- table. In non-managed-auth deployments (self-hosted single-org, CI
-- smoke) that table doesn't exist — and per-workspace demos make no
-- sense without multi-tenancy. Wrap the entire step in an
-- `IF EXISTS organization` guard so the cutover itself (steps 1, 2,
-- 4, 5, 6, 7) runs in every environment, and the demo backfill
-- self-defers when there's nothing to backfill against. This is what
-- lets 0096 stay OUT of MANAGED_AUTH_MIGRATIONS — CI smoke tests can
-- verify the cutover end-to-end.
--
-- Pre-flight guards (run inside the same conditional):
--   • Demo URL must be present and unique. NULL would drop the `url`
--     key via jsonb_strip_nulls and silently produce config-less
--     demo installs; duplicates would mean LIMIT 1 picks arbitrarily.
--   • No workspace already owns a `demo-postgres` install under a
--     different install_id. Step 3 inserts with install_id='__demo__';
--     a workspace that already has demo-postgres elsewhere would end
--     up with two demo installs differing only by install_id.
DO $$
DECLARE
  demo_url_count INTEGER;
  conflicting_demo_count INTEGER;
  missing_demo_count INTEGER;
  excess_demo_count INTEGER;
BEGIN
  -- Self-defer when Better Auth's `organization` table isn't present
  -- (non-managed-auth deploys + CI smoke). No multi-tenancy → no
  -- per-workspace backfill needed.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'organization'
  ) THEN
    RAISE NOTICE '0096 step 3: organization table absent — skipping per-workspace demo backfill';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO demo_url_count
    FROM connections WHERE id = '__demo__' AND org_id = '__global__';
  IF demo_url_count = 0 THEN
    -- No `__demo__` row to copy from. Two legitimate paths reach this:
    --   • Fresh CI / managed-auth bootstrap where the global demo is
    --     seeded by `runSeeds()` AFTER migrations apply (migration
    --     order: 0000-0096 first, then seeds; the `__demo__` row only
    --     exists post-seed).
    --   • A self-hosted operator who never ran `bun run atlas -- init`
    --     and is migrating directly into the new schema.
    -- In both cases, existing organizations get demo installs via the
    -- runtime `loadSavedConnections` auto_install path on first boot;
    -- no migration backfill is required. Skip step 3 silently.
    RAISE NOTICE '0096 step 3: no `__demo__` connection row to backfill from — skipping per-workspace demo backfill (runtime auto_install handles new orgs)';
    RETURN;
  END IF;
  IF demo_url_count > 1 THEN
    RAISE EXCEPTION
      'connections (__demo__, __global__) returned % rows — expected exactly 1. Resolve the duplicate before running this migration.',
      demo_url_count;
  END IF;

  SELECT COUNT(*) INTO conflicting_demo_count
    FROM workspace_plugins wp
    JOIN plugin_catalog pc ON pc.id = wp.catalog_id
   WHERE wp.pillar = 'datasource'
     AND pc.slug = 'demo-postgres'
     AND wp.install_id != '__demo__';
  IF conflicting_demo_count > 0 THEN
    RAISE EXCEPTION
      'Found % workspace_plugins row(s) of catalog demo-postgres with install_id != ''__demo__''. Step 3 would create duplicate demo installs — resolve manually before running.',
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

  -- Post-flight: every organization must now own exactly one
  -- demo-postgres install. Catches the case where the `WHERE NOT EXISTS`
  -- + `ON CONFLICT` combination silently dropped a row.
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
      'Found % organization(s) with more than one demo-postgres install — resolve manually',
      excess_demo_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Drop FK constraints
-- ---------------------------------------------------------------------------
--
-- The composite FKs on scheduled_tasks + approval_queue point at
-- connection_groups (id, org_id). Drop them — the columns stay as
-- free-form text identifiers, matching `conversations.connection_group_id`
-- which already had no DB FK per the 0067 design note.
--
-- The FKs on `connections.group_id` and (added by 0066)
-- `connection_groups.primary_connection_id` disappear with their parent
-- tables in step 5 (Postgres drops dependent FKs alongside DROP TABLE).
-- Listed here explicitly for clarity.

ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS fk_scheduled_tasks_group;
ALTER TABLE approval_queue DROP CONSTRAINT IF EXISTS fk_approval_queue_group;

-- ---------------------------------------------------------------------------
-- 5. Drop the tables
-- ---------------------------------------------------------------------------
--
-- CASCADE here is intentional: any index, trigger, or remaining
-- constraint that depended on these tables goes with them. Per ADR-0007
-- this is the clean-break moment.

DROP TABLE IF EXISTS connections CASCADE;
DROP TABLE IF EXISTS connection_groups CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Drop the legacy workspace_plugins global unique
-- ---------------------------------------------------------------------------
--
-- 0014 created the constraint as inline `UNIQUE(workspace_id, catalog_id)`,
-- which Postgres auto-named `workspace_plugins_workspace_id_catalog_id_key`.
-- Drizzle later re-declared it as `idx_workspace_plugins_unique`. Both
-- names need IF-EXISTS guards because dev databases that were
-- re-bootstrapped post-Drizzle-rename have ONLY one of the two.
--
-- The partial unique `workspace_plugins_singleton` (chat + action only,
-- from 0092) is now the sole uniqueness gate; datasource installs
-- become multi-instance per (workspace, catalog).

ALTER TABLE workspace_plugins DROP CONSTRAINT IF EXISTS workspace_plugins_workspace_id_catalog_id_key;
DROP INDEX IF EXISTS idx_workspace_plugins_unique;

-- ---------------------------------------------------------------------------
-- 7. Drop the BEFORE INSERT / UPDATE triggers from 0092
-- ---------------------------------------------------------------------------
--
-- Slice 1 (#2739) introduced these as a back-compat backstop while
-- existing handler INSERTs that omit pillar + install_id keep working.
-- Post-cutover every writer names both columns explicitly (the form/
-- OAuth/static-bot handlers via WorkspaceInstaller, datasource installs
-- via the new admin-connections route). The triggers can go.

DROP TRIGGER IF EXISTS trg_workspace_plugins_default_pillar_install_id
  ON workspace_plugins;
DROP FUNCTION IF EXISTS workspace_plugins_default_pillar_install_id() CASCADE;

DROP TRIGGER IF EXISTS trg_plugin_catalog_default_pillar
  ON plugin_catalog;
DROP FUNCTION IF EXISTS plugin_catalog_default_pillar() CASCADE;

DROP TRIGGER IF EXISTS trg_plugin_catalog_sync_pillar_on_type_change
  ON plugin_catalog;
DROP FUNCTION IF EXISTS plugin_catalog_sync_pillar_on_type_change() CASCADE;
