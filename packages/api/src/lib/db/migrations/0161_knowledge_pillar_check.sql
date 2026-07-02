-- Migration 0161: admit 'knowledge' to the pillar taxonomy (#4206, ADR-0028).
--
-- The Knowledge Base is Atlas's fourth pillar (ADR-0028): catalog rows of type
-- `context`, pillar `knowledge`, hosting review-gated OKF collections as
-- descriptive agent context. This migration widens the two pillar CHECKs that
-- ADR-0006's three-pillar taxonomy pinned in migration 0092 so
-- `plugin_catalog` and `workspace_plugins` rows may carry `pillar = 'knowledge'`.
--
-- Widening a CHECK with one more allowed value is expand-only —
-- backward-compatible and single-release safe (old code never writes
-- `knowledge`; new code does; a reader sees a plain string either way). Same
-- idempotent DROP-IF-EXISTS-then-re-ADD shape as 0092 (which created these
-- constraints) and 0160 (the most recent CHECK widen).
--
-- Deliberately NOT touched: the `workspace_plugins_singleton` partial unique
-- from 0092 is `WHERE pillar IN ('chat', 'action')`, so it already excludes
-- `knowledge` — exactly like `datasource`. That exclusion is what makes
-- collections possible: multiple knowledge installs per (workspace, catalog),
-- one per corpus (ADR-0028 §2). Adding `knowledge` to the singleton would break
-- the multi-instance invariant, so it stays out.
--
-- Mirrored in db/schema.ts (`chk_plugin_catalog_pillar` /
-- `chk_workspace_plugins_pillar`) in the same commit.

ALTER TABLE plugin_catalog
  DROP CONSTRAINT IF EXISTS chk_plugin_catalog_pillar;
ALTER TABLE plugin_catalog
  ADD CONSTRAINT chk_plugin_catalog_pillar
  CHECK (pillar IN ('datasource', 'chat', 'action', 'knowledge'));

ALTER TABLE workspace_plugins
  DROP CONSTRAINT IF EXISTS chk_workspace_plugins_pillar;
ALTER TABLE workspace_plugins
  ADD CONSTRAINT chk_workspace_plugins_pillar
  CHECK (pillar IN ('datasource', 'chat', 'action', 'knowledge'));
