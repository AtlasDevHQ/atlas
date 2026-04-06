-- 0022 — Add domain verification columns to sso_providers
--
-- SSO providers must verify ownership of their claimed domain via DNS
-- TXT record before they can be enabled. This migration adds the
-- verification token, status tracking, and verified timestamp.

ALTER TABLE sso_providers ADD COLUMN IF NOT EXISTS verification_token TEXT;
ALTER TABLE sso_providers ADD COLUMN IF NOT EXISTS domain_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sso_providers ADD COLUMN IF NOT EXISTS domain_verified_at TIMESTAMPTZ;
ALTER TABLE sso_providers ADD COLUMN IF NOT EXISTS domain_verification_status TEXT NOT NULL DEFAULT 'pending';

-- Grandfather existing enabled providers as verified — they were created
-- before domain verification existed, so their domain ownership was
-- implicitly trusted via the admin API.
UPDATE sso_providers
SET domain_verified = true,
    domain_verified_at = now(),
    domain_verification_status = 'verified'
WHERE enabled = true;

DO $$ BEGIN
  ALTER TABLE sso_providers ADD CONSTRAINT chk_domain_verification_status
    CHECK (domain_verification_status IN ('pending', 'verified', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Prevent enabling a provider with an unverified domain (TOCTOU race guard)
DO $$ BEGIN
  ALTER TABLE sso_providers ADD CONSTRAINT chk_enabled_requires_verified
    CHECK (NOT enabled OR domain_verified);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
