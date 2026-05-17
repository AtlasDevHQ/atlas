-- 0073_audit_log_parent_audit_id.sql
-- PRD #2515, slice 4 #2519 — link fanned-out per-member audit rows to a
-- single logical parent row, so cross-environment turns are one logical
-- step with N child executions in the audit dimension.
--
-- Single-environment executions leave `parent_audit_id` NULL, which
-- preserves the pre-#2519 shape for every existing query and for every
-- caller that doesn't fan out. Fanned-out turns insert one parent row
-- (parent_audit_id NULL, but with N child rows referencing its id) plus
-- N child rows whose parent_audit_id points back at the parent.
--
-- The FK is `ON DELETE SET NULL` so audit purge / retention purge
-- (`deleted_at` soft-delete or hard delete) of a parent does not
-- cascade-delete the children — operators retain the per-environment
-- attribution even after the parent's retention window expires.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS parent_audit_id UUID
    REFERENCES audit_log(id) ON DELETE SET NULL;

-- Lookup index: "give me every child row for this parent". Sparse —
-- only fanned-out parents pay the index cost.
CREATE INDEX IF NOT EXISTS idx_audit_log_parent_audit_id
  ON audit_log (parent_audit_id)
  WHERE parent_audit_id IS NOT NULL;
