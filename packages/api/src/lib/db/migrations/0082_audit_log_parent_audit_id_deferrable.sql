-- Make `audit_log.parent_audit_id` FK DEFERRABLE INITIALLY DEFERRED so the
-- cross-env fanout's fire-and-forget parent + child INSERTs can land in any
-- order within a transaction without `23503 foreign_key_violation`. Migration
-- 0074 declared the FK as immediate; under load the child INSERTs can reach
-- PG before the parent commits and get silently dropped by
-- `internalExecute`'s fire-and-forget error path.
--
-- Postgres allows altering a constraint's deferrability without rewriting the
-- table when the constraint is already in the `not valid` or `validated`
-- state. The ALTER takes an ACCESS EXCLUSIVE briefly but does not scan rows.
ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_parent_audit_id_fkey;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_parent_audit_id_fkey
  FOREIGN KEY (parent_audit_id)
  REFERENCES audit_log(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;
