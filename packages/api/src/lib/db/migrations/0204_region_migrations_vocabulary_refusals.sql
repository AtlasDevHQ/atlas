-- 0204_region_migrations_vocabulary_refusals.sql
-- #5112 — a refused alias edge, durable at the SOURCE region.
--
-- #5036 made a region import refuse an arriving alias edge that would close a
-- cycle or take a second parent, and log every refusal with enough of the source
-- row to re-author it by hand. That log line lives in the TARGET region's
-- process. Meanwhile the SOURCE region is the one that cuts over and schedules
-- the cleanup which DELETEs its own `brain_vocabulary_edge` rows after
-- CLEANUP_GRACE_PERIOD_DAYS (7). So the party that owns the irreversible act
-- held a COUNT, and the record that would let anyone undo it lived in another
-- region's log retention — outliving the data it describes by only as long as
-- that retention happens to be.
--
-- These two columns are that record, on the source's own migration row.
--
-- ## Why `region_migrations` is the right home
--
-- It is classified `platform` in `lib/residency/bundle-scope.ts` — "the
-- migration bookkeeping itself — must survive the migration it describes" — so
-- `runSourceCleanupSweep` never touches it. The refusal payloads therefore
-- outlive the very deletion that makes them the last copy, which is the whole
-- requirement. `cleanup.ts` also already re-reads this row under `FOR UPDATE` at
-- the moment of deletion, so the count is readable at the instant it becomes
-- irreversible without adding a query.
--
-- ## Two columns rather than one
--
-- `vocabulary_edges_refused` is the COUNT, and it is what the audit events, the
-- API and the CLI surface. `vocabulary_refusals` is the recovery PAYLOAD, capped
-- at VOCABULARY_REFUSAL_DETAIL_CAP entries by the writer.
--
-- They are not redundant, and the count is not derivable from the array's
-- length: the array is capped and an older target answers with a count and no
-- payloads at all, so `jsonb_array_length(vocabulary_refusals) <
-- vocabulary_edges_refused` is exactly the "some of this is unrecoverable"
-- signal. Collapsing them would make a truncated record indistinguishable from a
-- complete one.
--
-- Both NULL is the state of every row written before this migration, and of
-- every migration that never reached the transfer phase. NULL means UNKNOWN, not
-- zero: a source build that did not ask, or a migration that failed before the
-- target answered. `0` means the target answered and refused nothing.
ALTER TABLE region_migrations
  ADD COLUMN IF NOT EXISTS vocabulary_edges_refused INTEGER;

ALTER TABLE region_migrations
  ADD COLUMN IF NOT EXISTS vocabulary_refusals JSONB;
