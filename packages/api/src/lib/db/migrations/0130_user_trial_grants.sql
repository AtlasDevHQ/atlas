-- 0130: Durable + atomic one-trial-per-user marker (#3469, #3470).
--
-- The #3426/#3460 eligibility check keyed "has this user consumed a
-- trial?" on CURRENT owner membership of an org with trial_ends_at set.
-- Two holes:
--   • durability (#3470): owner demotion (a supported admin flow) erases
--     the match — a demoted user could create a new workspace and
--     receive a fresh trial. Same for org deletion.
--   • atomicity (#3469): two concurrent create-workspace requests by the
--     same user could both pass the read-side check before either
--     stamped trial_ends_at, minting two trials.
-- One row per user, stamped at grant time, fixes both: the PRIMARY KEY
-- makes `INSERT ... ON CONFLICT (user_id) DO NOTHING` an atomic claim
-- (exactly one concurrent creation wins), and the row survives
-- membership/role changes and org deletion (org_id is deliberately NOT
-- an FK — the marker must outlive the org).
--
-- The FK to "user" is ON DELETE CASCADE: when the user row itself is
-- erased (GDPR purge of their last workspace), the marker goes with it —
-- a purged identity holds no billing history to key on.
CREATE TABLE IF NOT EXISTS user_trial_grants (
  user_id    TEXT        PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  -- The org the trial was granted to (informational + idempotent-retry
  -- detection in claimTrialGrant). Not an FK by design — see above.
  org_id     TEXT        NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed from the owner-membership heuristic the read-side check used
-- (#3460): every current owner of a trial-stamped org has consumed a
-- trial. Oldest trialed org per user wins as the recorded grant target.
INSERT INTO user_trial_grants (user_id, org_id)
SELECT DISTINCT ON (m."userId") m."userId", o.id
  FROM member m
  JOIN organization o ON o.id = m."organizationId"
 WHERE m.role = 'owner'
   AND o.trial_ends_at IS NOT NULL
 ORDER BY m."userId", o."createdAt" ASC
ON CONFLICT (user_id) DO NOTHING;
