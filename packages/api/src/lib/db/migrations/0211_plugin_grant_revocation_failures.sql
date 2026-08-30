-- 0211 — durable record of failed `onUninstall` revocations (#3777).
--
-- The per-workspace `onUninstall` hook is best-effort by contract
-- (`lib/plugins/uninstall-hook.ts`): a throw, a 15s timeout, or an expired
-- OAuth token leaves the external webhook subscription / OAuth grant LIVE,
-- and until now the only trace was a log line and a count in the
-- catalog-delete audit metadata. An un-revoked external subscription keeps
-- delivering events to a workspace that no longer has the plugin installed,
-- and nothing durable pointed an operator at it.
--
-- ## The decided shape: a record and an alert, NEVER an auto-retry
--
-- Decided 2026-08-30 on #3777. A reconcile fiber that re-attempts revocation
-- needs credentials that the uninstall just tore down, so auto-retry means
-- deliberately retaining a revocation-capable credential past uninstall — a
-- security liability traded for convenience, and the wrong trade. So this
-- table captures NO credential material and no re-auth state: it is the
-- operator's worklist (which workspace, which plugin, what failed, when),
-- surfaced via the platform admin route and the
-- `atlas.plugins.grant_revocation_failures` counter. Clearing a row
-- (`resolved_at`/`resolved_by`) is part of the manual revoke flow, not
-- evidence the grant is gone — the operator asserts that by resolving.
--
-- `plugin_id` is the resolved candidate whose hook failed (a global registry
-- id or the catalog id itself for builder failures), which can differ from
-- `catalog_id` — one uninstall can fail several candidates, one row each.
--
-- ## Deploy-overlap note (expand only, no drops)
--
-- Purely additive — one new table + partial index. The N-1 container never
-- writes it and never sees a missing object.

CREATE TABLE IF NOT EXISTS plugin_grant_revocation_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  catalog_id text NOT NULL,
  plugin_id text NOT NULL,
  error text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text
);

-- The pair travels together (0210's posture): a resolution with no actor is
-- unattributable on a surface whose whole point is an operator standing
-- behind "I revoked this by hand", and an actor with no timestamp is not a
-- resolution. '' is refused for `error` — an empty error wears the shape of
-- a real one.
--
-- Schema-scoped probe (`connamespace`) — `pg_constraint.conname` is unique
-- per NAMESPACE and the `-pg` suites run migrations under per-test schemas
-- in one shared database (0133's and 0207's recorded trap).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_plugin_grant_revocation_resolution_pair'
      AND connamespace = current_schema()::regnamespace
  ) THEN
    ALTER TABLE plugin_grant_revocation_failures
      ADD CONSTRAINT chk_plugin_grant_revocation_resolution_pair
      CHECK (
        num_nonnulls(resolved_at, resolved_by) <> 1
        AND error <> ''
      );
  END IF;
END $$;

-- The operator's worklist read: unresolved failures, oldest first. PARTIAL on
-- the unresolved set — resolving removes the row from the index, so it holds
-- only the population an operator can still act on, and on a deployment
-- where every hook succeeds it holds nothing at all.
CREATE INDEX IF NOT EXISTS idx_plugin_grant_revocation_unresolved
  ON plugin_grant_revocation_failures (attempted_at)
  WHERE resolved_at IS NULL;
