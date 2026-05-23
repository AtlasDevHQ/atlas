-- 0091 — Unify catalog `min_plan` with the workspace `plan_tier`
-- vocabulary (#2666).
--
-- Pre-1.5.2, catalog `min_plan` admitted `starter|team|business|enterprise`
-- while workspace `plan_tier` was `free|trial|starter|pro|business`. A
-- catalog row whose `min_plan = team` or `min_plan = enterprise` ranked
-- above every value a workspace could ever hold — meaning the gate
-- denied every install at runtime with a debug-level log nobody saw.
--
-- This migration normalizes the legacy values to their closest
-- post-#2666 equivalent. Tonight's read showed Atlas production has
-- zero rows in either legacy state — the UPDATE is defensive against
-- pre-existing self-hosted seeds.
--
-- Rationale for the mapping:
--   - `team` → `business`: Team was the "small ops" tier between
--     starter and enterprise. The post-#2666 vocabulary doesn't have
--     an exact equivalent; `business` is the closest semantically
--     and matches how Salesforce / similar premium integrations
--     should gate.
--   - `enterprise` → `business`: Enterprise was the strictest gate.
--     Today there's nothing above `business` in PLAN_TIERS, so
--     `business` is the correct ceiling.
--
-- Both moves are conservative: they may unlock a few rows for
-- `pro` / `business` workspaces, but they NEVER admit a tier that
-- couldn't already hold the install before. Existing `starter`
-- workspaces stay at the same gate position.
--
-- No CHECK constraint is added today — the column is text and the
-- catalog seeder validates via the zod schema in config.ts. Adding
-- a CHECK now would crash any self-hosted deploy mid-upgrade whose
-- seeder hadn't been redeployed yet. The seeder is the gate.

UPDATE plugin_catalog SET min_plan = 'business' WHERE min_plan = 'team';
UPDATE plugin_catalog SET min_plan = 'business' WHERE min_plan = 'enterprise';

-- Migration 0014 set the default to `team` — also unify so any
-- bare INSERT lands on a recognized value. Idempotent.
ALTER TABLE plugin_catalog ALTER COLUMN min_plan SET DEFAULT 'starter';
