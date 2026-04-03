-- Add org_id to invitations for multi-tenant scoping.
-- Existing rows get NULL (pre-org invitations). New invitations will include org_id.

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(org_id);
