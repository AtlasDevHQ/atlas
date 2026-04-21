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
-- (the column default) AND null share_token + share_expires_at on the
-- same pass. Pre-migration, the F-01 route-layer fix returned 403 on
-- reads of these rows (org scope with no org → fail-closed). If we only
-- changed share_mode, the still-live share_token would start resolving
-- as a public link — anyone holding the URL would suddenly see the
-- content. Revoking the token forces a deliberate re-share.
--
-- Deriving org_id from user_id was considered and rejected: assigning
-- the share to a guessed org could leak content into the wrong tenant.
--
-- The RAISE NOTICE gives operators a post-mortem breadcrumb (same pattern
-- as 0032) and explicitly mentions token revocation so the behavior
-- change is visible in migration logs. On a clean dev DB these UPDATEs
-- touch 0 rows and emit no notice.

-- ── 1. Remediate bad conversation rows ──────────────────────────────
DO $$
DECLARE
  coerced_count INTEGER;
BEGIN
  UPDATE conversations
  SET share_mode = 'public',
      share_token = NULL,
      share_expires_at = NULL
  WHERE share_mode = 'org' AND org_id IS NULL;
  GET DIAGNOSTICS coerced_count = ROW_COUNT;
  IF coerced_count > 0 THEN
    RAISE NOTICE 'conversations.share_mode drift: coerced % row(s) from ''org'' back to ''public'' and revoked their share_token (org_id was NULL)', coerced_count;
  END IF;
END $$;

-- ── 2. Remediate bad dashboard rows ─────────────────────────────────
DO $$
DECLARE
  coerced_count INTEGER;
BEGIN
  UPDATE dashboards
  SET share_mode = 'public',
      share_token = NULL,
      share_expires_at = NULL
  WHERE share_mode = 'org' AND org_id IS NULL;
  GET DIAGNOSTICS coerced_count = ROW_COUNT;
  IF coerced_count > 0 THEN
    RAISE NOTICE 'dashboards.share_mode drift: coerced % row(s) from ''org'' back to ''public'' and revoked their share_token (org_id was NULL)', coerced_count;
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
