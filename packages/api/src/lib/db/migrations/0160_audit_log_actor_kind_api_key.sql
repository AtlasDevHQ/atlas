-- Migration 0160: Add `api_key` to the audit_log.actor_kind CHECK enum
-- (#4046 / ADR-0027 §6).
--
-- A workspace-scoped Better Auth API key (the unattended-CI credential) resolves
-- to its real owning member but stamps a DISTINCT actor_kind so the audit trail
-- can tell unattended-CI from a human `atlas login` device flow. The transport
-- (`origin`) stays `cli`; only the `actor_kind` discriminator gains a value.
--
-- Widening a CHECK with one more allowed value is expand-only —
-- backward-compatible and single-release safe (old code never writes `api_key`;
-- new code does; a reader sees a plain string either way). Mirrors the
-- chk_audit_log_actor_kind shape from migration 0049 and the idempotent
-- DROP-IF-EXISTS-then-re-ADD pattern of the auth_mode constraint in 0055 (0055
-- CREATED chk_audit_log_auth_mode on a previously-unconstrained column; this is a
-- true widen of an existing constraint). Idempotent: DROP IF EXISTS then re-ADD.

DO $$ BEGIN
  ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS chk_audit_log_actor_kind;
  ALTER TABLE audit_log
    ADD CONSTRAINT chk_audit_log_actor_kind
    CHECK (actor_kind IS NULL OR actor_kind IN ('human', 'agent', 'mcp', 'scheduler', 'api_key'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
