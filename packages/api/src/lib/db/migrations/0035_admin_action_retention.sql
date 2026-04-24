-- 0035 — Admin action audit retention + GDPR erasure columns
--
-- F-36 phase 1. Adds a retention-policy table for `admin_action_log` (parallel
-- to `audit_retention_config`) and the `anonymized_at` column that backs the
-- "right to erasure" contract.
--
-- Erasure semantics:
--   `anonymized_at IS NULL`     → row not erased (actor_id / actor_email
--                                 carry the originating user's identifiers)
--   `anonymized_at IS NOT NULL` → row was scrubbed at that instant. The
--                                 `actor_id` + `actor_email` columns on the
--                                 same row are NULL. Every other column
--                                 (timestamp, action_type, target, metadata,
--                                 ip_address, request_id) survives so the
--                                 sequence of actions is preserved without
--                                 the identifier.
--
-- `actor_id` and `actor_email` relax from NOT NULL to nullable so the
-- erasure writer can set them to NULL. Existing rows are unaffected; the
-- relaxation is the narrowest change that lets NULL through on scrubbed
-- rows while keeping the semantic constraint that live-write rows are
-- populated by the logAdminAction call path.
--
-- Design doc: .claude/research/design/admin-action-log-retention.md
-- Audit row: .claude/research/security-audit-1-2-3.md F-36
-- Issue: #1791

-- ── admin_action_log.anonymized_at ─────────────────────────────────────
ALTER TABLE admin_action_log
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

ALTER TABLE admin_action_log
  ALTER COLUMN actor_id DROP NOT NULL;

ALTER TABLE admin_action_log
  ALTER COLUMN actor_email DROP NOT NULL;

-- Forensic-query support: scrubbed vs live rows in one predicate.
CREATE INDEX IF NOT EXISTS idx_admin_action_log_anonymized_at
  ON admin_action_log (anonymized_at)
  WHERE anonymized_at IS NOT NULL;

-- ── admin_action_retention_config ──────────────────────────────────────
-- Parallel to `audit_retention_config`. Key is `org_id` with the reserved
-- literal 'platform' for the platform-scoped policy row. Per-workspace
-- admin-action retention keys on the workspace's own org_id.
CREATE TABLE IF NOT EXISTS admin_action_retention_config (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 TEXT        NOT NULL UNIQUE,
  retention_days         INTEGER,
  hard_delete_delay_days INTEGER     NOT NULL DEFAULT 30,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             TEXT,
  last_purge_at          TIMESTAMPTZ,
  last_purge_count       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_action_retention_config_org
  ON admin_action_retention_config(org_id);
