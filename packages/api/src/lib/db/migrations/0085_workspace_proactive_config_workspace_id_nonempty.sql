-- 0085 — workspace_proactive_config: CHECK (workspace_id <> '') (#2623 item 5).
--
-- Defense-in-depth on multi-tenant attribution. The proactive listener's
-- enabled-gate already short-circuits empty workspaceId at the application
-- layer (the #2620 follow-up — `packages/api/src/lib/proactive/enabled-gate.ts`
-- treats `""` as the registration probe and skips the SELECT entirely). A
-- CHECK on the column locks the same invariant at the schema layer so a
-- buggy upsert that drifts past the gate can never create a row that would
-- mis-attribute proactive behaviour to "no tenant".
--
-- Pre-existing empty rows: dropped before adding the constraint. An empty
-- workspace_id row is structurally orphaned — no consumer of this table
-- (admin/proactive routes, enabled-gate, AnswerMeter, AnnouncementCoordinator)
-- ever queries with `workspace_id = ''`, so dropping the row reclaims nothing
-- that was being read. (The non-empty invariant on call-site `workspaceId`
-- is enforced upstream: admin routes derive it from `AuthContext.orgId`
-- which Better Auth never sets to `""`, and the listener path resolves it
-- via the host's `resolveWorkspaceId` and short-circuits on null. Only
-- `enabled-gate.ts` has an explicit `''` short-circuit because it's the
-- one path that *intentionally* probes with the empty sentinel.) The
-- `RAISE NOTICE` makes the drop visible in migration logs so an operator
-- who sees a non-zero count can investigate whatever wrote the row.
--
-- Scope: just `workspace_proactive_config`. Other proactive tables
-- (`channel_proactive_config`, `proactive_pauses`, `proactive_meter_events`,
-- `proactive_public_dataset`, `proactive_classification_review`) carry
-- `workspace_id` columns too and would benefit from the same guard, but
-- defense-in-depth on the *master toggle* row is the leverage point — every
-- other proactive write path checks the master row's `enabled=true` first,
-- so a constraint here closes the only persistence surface where a
-- tenant-less write could begin a proactive session.

DO $$
DECLARE
  empty_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO empty_count
    FROM workspace_proactive_config
   WHERE workspace_id = '';
  IF empty_count > 0 THEN
    RAISE NOTICE 'Dropping % workspace_proactive_config row(s) with empty workspace_id before adding CHECK', empty_count;
    DELETE FROM workspace_proactive_config WHERE workspace_id = '';
  END IF;
END $$;

ALTER TABLE workspace_proactive_config
  ADD CONSTRAINT chk_workspace_proactive_workspace_id_nonempty
  CHECK (workspace_id <> '');
