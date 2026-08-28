-- 0210 — stage-0 pre-extraction triage marks (#5336).
--
-- The extraction fiber drains `extracted_at IS NULL` and spends one model call
-- per episode, and most episodes contain no promotable claim ("on it", "+1",
-- a thumbs-up). Stage 0 routes that obvious majority out DETERMINISTICALLY,
-- ahead of the model call, with rules enumerated in one place
-- (`lib/brain/triage.ts`).
--
-- ## Why this is two columns and not a stamp
--
-- The failure a triage filter introduces is a NEW way to be quietly wrong: a
-- rule that silently drops a real claim. 0180 legislates the opposite posture
-- for episodes outright — "NULL forever is a visible backlog, not a silent
-- drop" — and stamping `extracted_at` on a filter decision would assert that an
-- extraction pass ran when none did, permanently, with nothing left to notice.
--
-- So a triaged-out episode is MARKED AND COUNTABLE instead:
--
--   * `triaged_out_at`  — when stage 0 routed it out. The drain
--     (`DRAIN_EPISODES_SQL`) excludes `triaged_out_at IS NOT NULL`, so the row
--     stops holding a queue slot without ever being stamped extracted.
--   * `triage_reason`   — WHICH rule fired (`below_min_length`,
--     `pure_reaction`, `known_ack`; stage 1's classifier will mint its own ids
--     later). Open text rather than a CHECK enum, deliberately: stage 1's ids
--     do not exist yet, and an enum here would make every future rule a
--     migration. Neither column rides the region-export projection —
--     `export.ts` enumerates `brain_episodes` columns explicitly, on the
--     `extraction_batch_id` precedent — so an imported episode arrives
--     unmarked, re-drains, and is simply re-triaged in the destination: the
--     verdict is deterministic and cheaper to re-derive than to carry.
--
-- The mark is REVERSIBLE by construction: clearing both columns
-- (`REQUEUE_TRIAGED_SQL` in `lib/brain/extract.ts`) puts the episode back on
-- the drain at its original `ingested_at` position, with no backfill and no
-- repair sweep. That is what "re-queueable" means in #5336's acceptance
-- criteria, and it is why neither column defaults to anything.
--
-- ## Deploy-overlap note (expand only, no drops)
--
-- Purely additive — two nullable columns, a CHECK, an index — so the N-1
-- container never sees a missing object. An N-1 drain running during the
-- overlap simply does not know the exclusion predicate yet; the gate
-- (`ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED`) is OFF by default, so no mark
-- exists until an operator turns it on, which is after the deploy.

ALTER TABLE brain_episodes
  ADD COLUMN IF NOT EXISTS triaged_out_at timestamptz;
ALTER TABLE brain_episodes
  ADD COLUMN IF NOT EXISTS triage_reason text;

-- The pair travels together: a mark with no reason is unexplainable on the one
-- surface whose whole point is explainability, and a reason with no mark is a
-- verdict that does not exclude the row from the drain — each half-state reads
-- as a bug, so both are unrepresentable. '' is refused for `body`/`locator`'s
-- reason on this same table: an empty reason wears the shape of a real one.
--
-- Schema-scoped probe (`connamespace`), because `pg_constraint.conname` is
-- unique per NAMESPACE and the `-pg` suites run migrations under per-test
-- schemas in one shared database — an unscoped probe sees another schema's
-- constraint and silently skips its own (0133's and 0207's recorded trap).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_brain_episodes_triage_pair'
      AND connamespace = current_schema()::regnamespace
  ) THEN
    ALTER TABLE brain_episodes
      ADD CONSTRAINT chk_brain_episodes_triage_pair
      CHECK (
        num_nonnulls(triaged_out_at, triage_reason) <> 1
        AND coalesce(triage_reason, 'x') <> ''
      );
  END IF;
END $$;

-- The triaged-out backlog, countable per workspace and per reason — the
-- oversight read ("how many episodes did stage 0 route out, and why") and the
-- operator's re-queue scan both walk it. PARTIAL on the un-extracted triaged
-- set: a later re-queue-then-extract removes the row, so the index holds only
-- the population an operator can still act on, and on a deployment with triage
-- off it holds nothing at all.
CREATE INDEX IF NOT EXISTS idx_brain_episodes_triaged_out
  ON brain_episodes (workspace_id, triage_reason)
  WHERE triaged_out_at IS NOT NULL AND extracted_at IS NULL;

-- ⚠️ `idx_brain_episodes_extraction_queue` is deliberately NOT rebuilt with the
-- new predicate. Its `WHERE extracted_at IS NULL` is a superset of the drain's
-- new WHERE, so the plan stays correct; rebuilding a partial index on the
-- table this repo's own 0207 header describes holding multi-million-row
-- backfills would hold a lock for the whole scan inside the migration
-- transaction. The cost of not rebuilding is that triaged-out rows stay in the
-- queue index — which is the visible-backlog posture stated above, and bounded
-- by the re-queue verb rather than by growth without recourse. Revisit with a
-- CONCURRENTLY rebuild outside the runner if it ever measures as a problem.
