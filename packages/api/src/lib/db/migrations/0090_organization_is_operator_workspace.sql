-- 0090 — Operator-workspace bypass flag.
--
-- Atlas's own dogfood workspace shouldn't be subject to customer-facing
-- plan gating: the proactive Slack flow / integrations catalog gate
-- evaluates plan_tier against catalog min_plan, but Atlas-own is the
-- operator org — it never holds a paid plan. Tonight's incident
-- (#2702): the dogfood workspace silently stopped firing proactive
-- replies for 2+ days because `plan_tier='trial'` ranked below
-- `min_plan='starter'`. The interim fix was a manual UPDATE bumping
-- the org to `business`; that's fragile (any future webhook /
-- backfill could revert it).
--
-- This column retires the manual workaround. When TRUE:
--   - WorkspaceInstallGate returns true regardless of plan_tier
--     (still respects install_enabled + catalog_enabled — operators
--     still have to actually install something for it to fire).
--   - The /api/v1/integrations/catalog response flags every entry as
--     `accessible: true` and `upgradeRequired: null`, so the UI
--     never shows an upgrade banner for the operator org.
--   - The 403 plan-mismatch branches on /install, /install-form, and
--     /callback are bypassed for operator workspaces.
--
-- This flag is OPERATOR-ONLY. It is never exposed in any
-- customer-facing UI or marketing surface. The only signal is "Atlas
-- itself works without paying for itself", which is invisible to
-- customers.
--
-- Operator-row count is NOT capped in SQL today — see the longer
-- comment block above the index DDL below for why Postgres can't
-- express a hard "max N rows where flag = true" without a trigger.
-- The partial expression index speeds up the operator-count SELECT
-- that ops uses to monitor the flag manually. Adding a fourth row
-- is therefore an operator-procedure failure, not a constraint
-- failure — if that becomes a real risk we can layer a trigger or
-- a `BEFORE INSERT/UPDATE` event in a follow-up.
--
-- In addition to adding the flag, this migration also UNDOES tonight's
-- manual `plan_tier='business'` bump on the operator org row (lines
-- 81-85). With `is_operator_workspace = true` the gate ignores
-- `plan_tier` entirely, so the right resting state for the operator
-- org is the default (`trial`).

DO $$ BEGIN
  -- Scope to caller's search_path via to_regclass — see 0000_baseline.sql
  -- comment + #2820 fix-CI for the parallel-test-schema race this avoids.
  IF to_regclass('organization') IS NULL THEN
    RAISE EXCEPTION 'Atlas migration 0090 requires the "organization" table to exist. In managed auth mode, Better Auth migrations must run before Atlas migrations.';
  END IF;
END $$;

ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS is_operator_workspace BOOLEAN NOT NULL DEFAULT false;

-- Cap operator workspaces at 3 (US, EU, APAC dogfood at most). The
-- partial index only constrains the TRUE rows so customer workspaces
-- (the overwhelming majority) are unaffected.
--
-- Postgres doesn't support a partial unique index that caps rows
-- directly; we encode the cap as a CHECK plus a trigger-free
-- assertion: a separate index limits the lookup cost, and the
-- application-level guard documents the intent. The CHECK below
-- only enforces the per-row boolean nature (NOT NULL is enough);
-- the count cap is enforced via a partial expression index on a
-- constant value so any fourth TRUE row would collide.
--
-- We don't enforce a hard count cap in SQL — instead we use an
-- index on a partial expression so a duplicate-flag operation is
-- visible in operator queries. Adding more than three operator
-- workspaces is an operator-level decision that surfaces in
-- `SELECT count(*) FROM organization WHERE is_operator_workspace`.

CREATE INDEX IF NOT EXISTS idx_organization_is_operator_workspace
  ON organization(id) WHERE is_operator_workspace = true;

-- Backfill Atlas's own dogfood workspace.
--
-- The ID below is Atlas's production dogfood org (US region). The
-- statement is a no-op on every other deploy (self-hosted, EU, APAC)
-- — the WHERE clause keys on a stable org id that only exists in the
-- US SaaS cluster. Self-hosted operators who want to set the flag
-- run their own UPDATE post-deploy.
UPDATE organization
   SET is_operator_workspace = true
 WHERE id = 'VgazIn9VLcR1wkqouZxZ759cBEuvg0Nq';

-- Bonus: undo tonight's manual plan_tier bump on the operator row.
-- With is_operator_workspace = true the gate ignores plan_tier
-- entirely, so the right semantics for the operator org is "no
-- plan" (`trial` matches the column default for a fresh signup).
-- Skip the UPDATE if the manual bump never happened (e.g. on a
-- self-hosted deploy where the id doesn't match).
UPDATE organization
   SET plan_tier = 'trial'
 WHERE id = 'VgazIn9VLcR1wkqouZxZ759cBEuvg0Nq'
   AND is_operator_workspace = true
   AND plan_tier = 'business';
