-- 0034 — Enforce that share_mode='org' requires org_id IS NOT NULL
--
-- Closes #1737. F-01 (#1727, fixed at the route layer by PR #1738 / #1742)
-- showed that a conversation or dashboard row with share_mode='org' and
-- org_id=NULL would silently pass a truthy org-membership check and leak
-- cross-tenant. Route layers now fail-closed, but the schema still
-- allowed the invalid combination — any future caller that reintroduces
-- the truthy pattern would reopen the same class of bug.
--
-- This migration adds a DB-level CHECK so the invariant is impossible to
-- violate: share_mode='org' requires org_id IS NOT NULL.
--
-- Ordering is load-bearing: the remediation UPDATEs must run before the
-- ADD CONSTRAINT, otherwise any pre-drifted row would block the
-- migration from applying. Matches the pattern used in 0031 / 0032.
--
-- Remediation policy: flip offending rows back to share_mode='public'
-- (the column default). The share was already broken-by-construction —
-- the route layer was rejecting it — so reverting to 'public' is
-- strictly less dangerous than trying to derive org_id from user_id,
-- which would risk assigning the share to the wrong org.
--
-- The RAISE NOTICE gives operators a post-mortem breadcrumb (same pattern
-- as 0032). On a clean dev DB these UPDATEs touch 0 rows and emit no
-- notice.

-- ── 1. Remediate bad conversation rows ──────────────────────────────
DO $$
DECLARE
  coerced_count INTEGER;
BEGIN
  UPDATE conversations
  SET share_mode = 'public'
  WHERE share_mode = 'org' AND org_id IS NULL;
  GET DIAGNOSTICS coerced_count = ROW_COUNT;
  IF coerced_count > 0 THEN
    RAISE NOTICE 'conversations.share_mode drift: coerced % row(s) from ''org'' back to ''public'' (org_id was NULL)', coerced_count;
  END IF;
END $$;

-- ── 2. Remediate bad dashboard rows ─────────────────────────────────
DO $$
DECLARE
  coerced_count INTEGER;
BEGIN
  UPDATE dashboards
  SET share_mode = 'public'
  WHERE share_mode = 'org' AND org_id IS NULL;
  GET DIAGNOSTICS coerced_count = ROW_COUNT;
  IF coerced_count > 0 THEN
    RAISE NOTICE 'dashboards.share_mode drift: coerced % row(s) from ''org'' back to ''public'' (org_id was NULL)', coerced_count;
  END IF;
END $$;

-- ── 3. Add CHECK constraints (idempotent) ───────────────────────────
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT chk_org_scoped_share
    CHECK (share_mode <> 'org' OR org_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE dashboards ADD CONSTRAINT chk_org_scoped_share
    CHECK (share_mode <> 'org' OR org_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
