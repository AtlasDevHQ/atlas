-- 0170 — learned_patterns.last_apply_error (#4506).
--
-- The decide seam (`lib/semantic/expert/decide.ts`) owns the semantic
-- Amendment `pending → approved | rejected` transition with claim-then-apply
-- ordering: a claim (conditional update on `pending` → transient `applying`)
-- wins the row, the YAML apply + version snapshot run, and only a successful
-- apply stamps `approved`. When the apply fails, the seam compensates by
-- returning the row to `pending` — and this column carries the failure reason
-- so the admin review queue can show WHY the amendment bounced instead of
-- silently re-listing it. Cleared on the next claim and on a successful stamp.
--
-- Additive-only: a single nullable column, no constraint changes — safe in a
-- single release under the two-phase-drop discipline (only DROP/RENAME COLUMN
-- and DROP TABLE need the N / N+1 split). The Drizzle mirror in `db/schema.ts`
-- (`learnedPatterns.lastApplyError`) lands in the SAME PR so
-- `check-schema-drift` stays green. Not Better-Auth-dependent, so it does NOT
-- join `MANAGED_AUTH_MIGRATIONS`.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE learned_patterns
  ADD COLUMN IF NOT EXISTS last_apply_error text;

COMMENT ON COLUMN learned_patterns.last_apply_error IS
  'Reason the last approve-apply failed, set when the decide seam compensates the row back to pending (claim-then-apply, #4506). NULL once a claim or successful apply clears it.';
