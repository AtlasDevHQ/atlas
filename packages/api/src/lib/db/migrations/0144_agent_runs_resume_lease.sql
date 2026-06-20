-- 0144: agent_runs resume lease — single-resumer guard for crash-resume (#3747, ADR-0020).
--
-- Phase 2 of the durable-agent-sessions epic (#3742) adds crash-resume: a turn
-- interrupted mid-flight (deploy, crash, serverless timeout) re-enters the agent
-- loop from its last `running` checkpoint instead of restarting from the user's
-- message. The single-resumer invariant from ADR-0020 — "one run resumes to one
-- live stream at a time; a second concurrent resume of the same run_id is
-- rejected" — is enforced by a TIME-BOUNDED lease on the run row.
--
-- The lease has two columns:
--   - `resuming_lease`       TIMESTAMPTZ — already defined in 0143 (the schema is
--      the contract; defined-not-written until now). Holds the lease EXPIRY
--      instant. A resume claims the lease by stamping a future expiry; the claim
--      only succeeds when the column is NULL or already in the past (a stale
--      lease from a resumer that itself died mid-resume). Time-bounding is what
--      keeps a crashed resumer from wedging the run forever — the lease self-heals
--      once it expires.
--   - `resuming_lease_owner` TEXT — added HERE. A per-resume token identifying the
--      current lease holder, so RELEASE is safe under TTL expiry: resumer A only
--      clears the lease when it still owns it. Without the owner token, A's
--      delayed release (fired after A's lease already expired and B re-claimed)
--      would wipe B's live lease and let a third resumer fork the turn — exactly
--      the double-attach the lease exists to prevent.
--
-- Additive ALTER only — no DROP, no two-phase-drop discipline. The new column is
-- nullable with no default (NULL = no lease held), so existing `running`/`parked`
-- rows backfill to "unleased" and the next resume claims cleanly. The mirror
-- lands in db/schema.ts in the same commit (check-schema-drift.sh).
--
-- Plain DDL on the Atlas-internal `agent_runs` table (NOT Better-Auth-managed) —
-- it runs in every auth mode and is NOT added to MANAGED_AUTH_MIGRATIONS.

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS resuming_lease_owner TEXT;

COMMENT ON COLUMN agent_runs.resuming_lease_owner IS
  'Per-resume token identifying the current lease holder (#3747). Paired with resuming_lease (expiry): a resume releases the lease only while it still owns it, so a TTL-expired stale resumer cannot clear a freshly re-claimed live lease.';

-- The resume working set is non-terminal runs whose lease is free or expired —
-- the rows a fresh resume scans for. The existing idx_agent_runs_active partial
-- index already narrows to status IN ('running','parked'); this adds the lease
-- column to keep the "claimable run for this conversation" lookup index-only as
-- the active slice grows. Partial on the same non-terminal predicate so it stays
-- a small hot index, not a full-table one.
CREATE INDEX IF NOT EXISTS idx_agent_runs_resume_lease
  ON agent_runs (conversation_id, resuming_lease)
  WHERE status IN ('running', 'parked');
