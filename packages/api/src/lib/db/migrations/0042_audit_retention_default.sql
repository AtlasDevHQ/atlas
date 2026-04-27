-- 0042 — Audit log retention: 365-day default for new and existing orgs (#1927).
--
-- Pre-#1927: `audit_retention_config.retention_days INTEGER` had no DEFAULT,
-- and orgs without an explicit policy row were treated as "unlimited" by the
-- EE retention library (`getRetentionPolicy` returned null → no purging).
-- That left /privacy §8 making the weaker "retained indefinitely until the
-- Customer admin configures a retention policy" claim.
--
-- This migration:
--   1. Sets the column DEFAULT to 365 so any future INSERT that omits
--      `retention_days` (e.g. a new-org provisioning path that only sets
--      `org_id`) lands on the 365-day window.
--   2. Backfills a 365-day config row for every existing org that has never
--      had a policy row written. Orgs with an explicit row — including those
--      that explicitly chose `retention_days = NULL` (unlimited) — are not
--      touched. The `WHERE NOT EXISTS` guard makes the backfill idempotent.
--
-- 365 is well above the EE library's `MIN_RETENTION_DAYS = 7` floor
-- (ee/src/audit/retention.ts:152) so the validator on `setRetentionPolicy`
-- continues to accept the new default if a future admin reads-then-writes it.
-- `hard_delete_delay_days` defaults to 30 in the table definition; the
-- backfill states it explicitly so a reader doesn't have to cross-reference.
--
-- The backfill row is keyed on `organization.id` — Better Auth's organization
-- table. On non-EE deploys without the org table, the INSERT is a no-op
-- (no rows to scan); the ALTER COLUMN succeeds either way.
--
-- Issue: #1927

-- New orgs: omit retention_days on INSERT and the default lands.
ALTER TABLE audit_retention_config
  ALTER COLUMN retention_days SET DEFAULT 365;

-- Existing orgs without a policy row: backfill 365-day config.
-- Idempotent via WHERE NOT EXISTS — re-running the migration after a
-- subsequent org provisioning is a no-op for already-seeded rows.
INSERT INTO audit_retention_config (org_id, retention_days, hard_delete_delay_days)
SELECT id, 365, 30
FROM organization
WHERE NOT EXISTS (
  SELECT 1 FROM audit_retention_config arc WHERE arc.org_id = organization.id
);
