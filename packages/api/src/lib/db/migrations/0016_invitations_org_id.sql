-- Add org_id to invitations for multi-tenant scoping.
-- Existing rows get NULL (pre-org invitations). New invitations will include org_id.

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(org_id);

-- Update unique constraint: one pending invite per (email, org), not per email globally.
DROP INDEX IF EXISTS idx_invitations_pending_email;
CREATE UNIQUE INDEX idx_invitations_pending_email ON invitations(email, org_id) WHERE status = 'pending';
