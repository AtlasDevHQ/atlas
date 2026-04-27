-- 0042 — Audit log retention: 365-day default for new and existing orgs (#1927).
--
-- Pre-#1927: `audit_retention_config.retention_days INTEGER` had no DEFAULT,
-- and orgs without an explicit policy row were treated as "unlimited" by the
-- EE retention library (`getRetentionPolicy` returned null → no purging).
-- That left the Retention section of /privacy making the weaker "retained
-- indefinitely until the Customer admin configures a retention policy" claim.
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
-- 365 is well above the EE library's `MIN_RETENTION_DAYS` floor (see
-- `ee/src/audit/retention.ts`) so the validator on `setRetentionPolicy`
-- continues to accept the new default if a future admin reads-then-writes it.
-- `hard_delete_delay_days` defaults to 30 in the table definition; the
-- backfill states it explicitly so a reader doesn't have to cross-reference.
--
-- Drizzle parity: `auditRetentionConfig.retentionDays` in
-- `packages/api/src/lib/db/schema.ts` carries the matching `.default(365)`.
-- The two literals must agree — `migrate.test.ts` pins both.
--
-- ──────────────────────────────────────────────────────────────────
-- Non-managed-auth deploy guard (#1472)
-- ──────────────────────────────────────────────────────────────────
-- The backfill references `organization` — Better Auth's table — without an
-- IF EXISTS guard. Postgres resolves the table at parse time, so on a deploy
-- without Better Auth's organization plugin the file would fail to parse and
-- abort boot. That is the wrong behavior for self-hosted single-user mode,
-- where `audit_retention_config` is unused but the runner would still
-- attempt to apply this file.
--
-- Resolution: this file is registered in `ORG_DEPENDENT_MIGRATIONS` in
-- `packages/api/src/lib/db/internal.ts` and skipped on
-- `detectAuthMode() !== "managed"` boots. It is then applied automatically
-- on a future boot if the deploy switches to managed auth. This mirrors the
-- 0027 pattern — see `migrate.test.ts` for the assertion that pins this.
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
