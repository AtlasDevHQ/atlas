-- 0106_crm_outbox_workspace_id.sql
--
-- Lift per-tenant attribution out of "wherever this happens to dispatch"
-- and onto a first-class column (#2849). Today every `crm_outbox` row
-- belongs to Atlas's own operator workspace — the SaaS lead-capture
-- pipeline at `crm.useatlas.dev`. Tomorrow, a customer workspace plugin
-- install (`@useatlas/twenty` per-tenant) needs to route its own rows
-- to its own Twenty. Without `workspace_id`, the dispatcher would have
-- to guess from payload shape; with it, routing is a deterministic
-- per-row lookup.
--
-- ─────────────────────────────────────────────────────────────────────
-- DEFAULT '<atlas-operator>' rationale
-- ─────────────────────────────────────────────────────────────────────
-- The column ships with NOT NULL + DEFAULT in one ALTER so existing
-- rows backfill atomically to the operator-pipeline sentinel — no
-- two-phase ADD-NULLABLE-then-SET-NOT-NULL migration, no risk of an
-- intermediate state where the column exists but the constraint
-- doesn't. The sentinel string matches `ATLAS_OPERATOR_WORKSPACE_SENTINEL`
-- in `ee/src/saas-crm/index.ts`; the runtime dispatcher treats it as
-- the env-creds branch (Atlas's own pipeline) so any rows that land
-- with the sentinel route correctly even when no `is_operator_workspace`
-- row exists (EU/APAC SaaS regions, self-hosted dev).
--
-- The DEFAULT also covers raw `INSERT INTO crm_outbox` paths in test
-- fixtures and one-shot operator scripts that haven't been threaded
-- through the application's `enqueue()` (which throws on empty
-- workspaceId). New PRs adding code that enqueues outside `enqueue()`
-- should still set workspace_id explicitly — the DEFAULT is a safety
-- net, not a license to skip attribution.
--
-- ─────────────────────────────────────────────────────────────────────
-- Operator-id fidelity bump
-- ─────────────────────────────────────────────────────────────────────
-- After the ADD COLUMN settles, an OPTIONAL UPDATE rewrites
-- sentinel-stamped rows to the real `organization.is_operator_workspace
-- = true` id when one exists. Both forms route identically at dispatch
-- time — env creds — so this is purely a metadata-fidelity / observability
-- bump (a future platform-admin view can attribute the row to the
-- specific operator org, e.g. when reporting per-region volumes). The
-- `to_regclass` guard mirrors 0090 / 0085 — `organization` doesn't
-- exist in non-managed-auth mode and the migration runs cleanly there.
--
-- ─────────────────────────────────────────────────────────────────────
-- Index
-- ─────────────────────────────────────────────────────────────────────
-- Partial index on `(workspace_id, status, created_at) WHERE status IN
-- ('pending', 'in_flight')` mirrors the shape of the existing
-- pending-created index but adds the workspace dimension so a future
-- per-workspace admin view scans only its slice. The active-statuses
-- filter keeps the index small as done/dead rows accumulate (same
-- pattern as 0102 and 0104).

ALTER TABLE crm_outbox
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '<atlas-operator>';

DO $$
DECLARE
  op_id TEXT;
BEGIN
  IF to_regclass('organization') IS NOT NULL THEN
    SELECT id INTO op_id
      FROM organization
     WHERE is_operator_workspace = true
     LIMIT 1;
    IF op_id IS NOT NULL THEN
      UPDATE crm_outbox
         SET workspace_id = op_id
       WHERE workspace_id = '<atlas-operator>';
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_outbox_workspace_status_created
  ON crm_outbox (workspace_id, status, created_at)
  WHERE status IN ('pending', 'in_flight');

COMMENT ON COLUMN crm_outbox.workspace_id IS
  'Tenant attribution for per-row dispatch routing (#2849). The SaaS lead-capture pipeline at crm.useatlas.dev resolves the Atlas operator workspace id (organization.is_operator_workspace=true) at boot; rows enqueued via SaasCrm.upsertLead/stampConversion carry that id. A future per-tenant plugin enqueue path lands a customer workspace id and the dispatcher resolves the workspace''s credentials via twenty_integrations. The sentinel ''<atlas-operator>'' (also the column DEFAULT) covers regions/deploys without a flagged operator row — the runtime treats it as the env-creds branch. No FK to organization (same rationale as the rest of crm_outbox: durability over referential integrity for an outbox that survives org deletion pending triage).';
