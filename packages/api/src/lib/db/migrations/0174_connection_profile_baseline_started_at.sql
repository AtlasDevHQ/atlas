-- 0174 — in-flight claim marker for baseline profiling (coverage re-storm fix).
--
-- The coverage view (#4521) lazily backfills a connection's baseline profile and
-- the client polls every 4s while any connection is still profiling. The lazy
-- backfill (`ensureConnectionBaseline`) only short-circuited on a SUCCESSFUL
-- baseline — a connection with neither a success nor a recorded error was
-- re-profiled on EVERY poll, with no in-flight guard. A group with N members
-- (e.g. a 3-region `g_prod`) therefore launched N overlapping full-schema
-- profiles every 4 seconds; the overlapping runs opened live connections to the
-- target database until it hit `max_connections` ("sorry, too many clients
-- already"). See the coverage re-storm investigation.
--
-- `baseline_started_at` is the atomic claim marker: a caller stamps it before
-- profiling and clears it (→ NULL) on either terminal outcome (success upsert or
-- recorded error). A single guarded UPSERT (`claimBaselineSlot` in
-- `connection-profile.ts`) claims the slot ONLY when there's no successful
-- baseline and no fresh claim within a staleness TTL, so repeated poll-driven
-- backfill calls collapse to one running profile per connection ACROSS replicas
-- (the DB row is the shared lock, not an in-process mutex). A claim older than
-- the TTL is treated as abandoned (a crashed run) and re-claimable, so a stuck
-- claim can never wedge a connection permanently.
--
-- Additive-only: a single nullable column on an existing table, no constraint
-- changes — safe in one release (the two-phase-drop discipline governs only
-- DROP COLUMN / DROP TABLE). The Drizzle mirror in `db/schema.ts`
-- (`connectionProfileState.baselineStartedAt`) lands in the SAME PR so
-- `check-schema-drift` stays green. NULL default = no claim in flight; every
-- existing row reads as "not claiming", which is correct.
--
-- Not Better-Auth-managed, so this file does NOT join MANAGED_AUTH_MIGRATIONS
-- (db/internal.ts). Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE connection_profile_state
  ADD COLUMN IF NOT EXISTS baseline_started_at TIMESTAMPTZ;

COMMENT ON COLUMN connection_profile_state.baseline_started_at IS
  'In-flight baseline-profile claim (coverage re-storm fix): stamped before a profile run, cleared to NULL on success or recorded error. A single guarded UPSERT claims the slot only when no baseline exists and no fresh claim is within the staleness TTL, collapsing poll-driven backfill calls to one running profile per connection across replicas. A claim older than the TTL is re-claimable (abandoned/crashed run).';
