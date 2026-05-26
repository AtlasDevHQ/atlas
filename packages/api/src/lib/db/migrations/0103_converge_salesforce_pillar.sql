-- 0103_converge_salesforce_pillar.sql
--
-- One-shot converge for the Salesforce catalog row.
--
-- Backstory: Salesforce was double-seeded — `seed-builtin-datasource-catalog.ts`
-- wrote it as (`type='datasource'`, `pillar='datasource'`) with `ON CONFLICT DO
-- NOTHING`, but `deploy/api/atlas.config.ts` also declared it as
-- `type='integration'` and the catalog seeder's `ON CONFLICT (slug) DO UPDATE`
-- flipped `type` to `'integration'` on every boot. Pre-migration-0097 the
-- `trg_plugin_catalog_sync_pillar_on_type_change` trigger then flipped `pillar`
-- to `'action'`. Steady state in production was therefore (`type='integration'`,
-- `pillar='action'`), but ADR-0006 puts Salesforce exclusively on the
-- Datasource pillar.
--
-- 0097 dropped that sync trigger. Between 0097 deploying and PR #2858 landing,
-- the catalog seeder's UPDATE flipped `type` to `'integration'` but the trigger
-- was gone, leaving the row in a drifted state (`type='integration'`,
-- `pillar='datasource'`). PR #2858 commit 1 made the seeder name `pillar`
-- explicitly; commit 2 removed the stub `salesforce` declaration from
-- `atlas.config.ts` so the catalog seeder no longer touches this slug. But
-- the existing prod row stays drifted because:
--   - the datasource seeder's `ON CONFLICT DO NOTHING` won't overwrite it
--   - the catalog seeder skips the slug entirely now
--
-- This migration converges the row to its ADR-0006 canonical shape. Idempotent
-- (the WHERE clause no-ops on already-converged rows), so re-running across
-- regional clusters is safe.
UPDATE plugin_catalog
   SET type = 'datasource',
       pillar = 'datasource',
       updated_at = NOW()
 WHERE slug = 'salesforce'
   AND (type IS DISTINCT FROM 'datasource' OR pillar IS DISTINCT FROM 'datasource');
