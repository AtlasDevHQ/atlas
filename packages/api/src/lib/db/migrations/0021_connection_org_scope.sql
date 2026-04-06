-- 0021 — Make connections org-scoped (composite primary key)
--
-- Previously `id` was a single-column PK, making connection IDs globally
-- unique across all organizations.  In SaaS mode every org needs its own
-- "default" connection, so two orgs onboarding back-to-back would 409.
--
-- Fix: backfill NULL org_ids, enforce NOT NULL, replace the single-column
-- PK with a composite PK on (id, org_id).

-- 1. Backfill legacy rows that have no org_id
UPDATE connections SET org_id = '__global__' WHERE org_id IS NULL;

-- 2. Make org_id NOT NULL with a safe default for future rows
ALTER TABLE connections ALTER COLUMN org_id SET DEFAULT '__global__';
ALTER TABLE connections ALTER COLUMN org_id SET NOT NULL;

-- 3. Replace PK: single column → composite
ALTER TABLE connections DROP CONSTRAINT connections_pkey;
ALTER TABLE connections ADD PRIMARY KEY (id, org_id);
