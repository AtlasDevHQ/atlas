-- 0033 — Add DNS TXT ownership verification columns to custom_domains
--
-- `ee/src/platform/domains.ts` (registerDomain + verifyDomainDnsTxt +
-- rowToDomain + hasVerifiedCustomDomain) has been reading and writing these
-- four columns via raw SQL, but `packages/api/src/lib/db/schema.ts` didn't
-- declare them. Drizzle-generated migrations therefore didn't create them
-- on fresh DBs. Surfaced during #1661 audit; tracked as #1707.
--
-- Mirrors the pattern from 0022_sso_domain_verification.sql so the two
-- domain-verified surfaces stay parallel.

ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS verification_token TEXT;
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS domain_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS domain_verified_at TIMESTAMPTZ;
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS domain_verification_status TEXT NOT NULL DEFAULT 'pending';

-- Grandfather existing domains whose outer status is already 'verified' —
-- they were created before DNS TXT verification existed so their ownership
-- was implicitly trusted via the Railway-domain-id path. Matches 0022's
-- `WHERE enabled = true` grandfathering.
UPDATE custom_domains
SET domain_verified = true,
    domain_verified_at = COALESCE(verified_at, now()),
    domain_verification_status = 'verified'
WHERE status = 'verified';

DO $$ BEGIN
  ALTER TABLE custom_domains ADD CONSTRAINT chk_custom_domain_verification_status
    CHECK (domain_verification_status IN ('pending', 'verified', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
