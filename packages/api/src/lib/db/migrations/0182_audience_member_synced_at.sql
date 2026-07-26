-- 0182 — a staleness bound on audience membership (#4808).
--
-- 0180 gave `fact_audience_member` a `created_at` ("since when has this person
-- been able to see this?") but nothing that answers "and when did we last CHECK
-- that they still should?". Those are different questions, and only the second
-- one bounds a failure.
--
-- The sync (#4801, `lib/brain/audience/`) is correctly fail-safe: a roster read
-- it cannot complete aborts that audience and leaves membership untouched,
-- because a truncated read would otherwise REVOKE the members it failed to
-- fetch. But "leaves it untouched" has no time bound. If the bot is removed
-- from a private channel, the channel is archived, or the token is revoked,
-- `loadRoster` fails on every cycle forever and the audience keeps granting
-- access indefinitely — and nothing in the schema could tell that apart from an
-- audience reconciled thirty seconds ago.
--
-- `synced_at` means LAST VERIFIED, never "last touched". It is stamped on every
-- SUCCESSFUL reconcile including the no-op case (an unchanged roster is still a
-- verified one) and left alone on every abort path. Backwards, the column would
-- read healthiest for exactly the workspaces that are broken.
--
-- Read-time enforcement lives in `lib/brain/acl.ts`'s `AUDIENCE_MEMBERSHIP_SQL`,
-- NOT here and not in the sync: a guard inside the component that is failing
-- cannot fire. Past `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS` (default 168 =
-- 7 days, `0` disables) the grant is suppressed — and COUNTED and warned, not
-- silently dropped, which is what keeps it consistent with that module's stated
-- refusal to downgrade a reader without saying so.
--
-- `DEFAULT now()` backfills existing rows as freshly verified. Deliberate: the
-- alternative (NULL, or an epoch default) would expire every audience in every
-- workspace the moment this deploys, which is the mass revocation the whole
-- subsystem is built to avoid — and it would do it on no evidence, since a row
-- written before this migration was in fact verified when it was written.
ALTER TABLE fact_audience_member
  ADD COLUMN IF NOT EXISTS synced_at timestamptz NOT NULL DEFAULT now();

-- "Which audiences in this workspace have not been verified lately?" — the
-- per-cycle staleness sweep that puts the oldest verification on the
-- `brain_audience_sync` span, so an operator sees a stuck roster read before it
-- ages past the threshold and starts denying reads.
CREATE INDEX IF NOT EXISTS idx_fact_audience_member_stale
  ON fact_audience_member (workspace_id, synced_at);
