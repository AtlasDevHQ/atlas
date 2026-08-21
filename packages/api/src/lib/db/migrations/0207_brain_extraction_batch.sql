-- 0207 — the in-flight ledger for batched extraction (#5352, ADR-0036
-- §Ingestion & connectors, bounded by #5334).
--
-- Anthropic's Batch API is 50% of standard pricing with an asynchronous
-- turnaround, and `lib/brain/extract.ts` is already built for exactly that: a
-- separate fiber so *"episode freshness never blocks on LLM latency / 429s"*,
-- facts second-order fresh BY DESIGN, and a backlog that is visible in
-- `idx_brain_episodes_extraction_queue` rather than inferred. The latency budget
-- was already hours. We were paying double for a synchronous guarantee the
-- architecture explicitly does not want.
--
-- ## What the cycle could not previously say
--
-- Batch turns the tick from `drain → extract → reconcile → stamp` into
-- `drain → submit → (later) collect → reconcile → stamp`. That splits one
-- question out that the synchronous path never had to ask:
--
--   **Which episodes are already out with a batch?**
--
-- They are `extracted_at IS NULL` and they must stay that way — 0180 states the
-- posture outright (*"NULL forever is a visible backlog, not a silent drop"*),
-- and work-then-stamp is what makes a crash cost one repeated model call instead
-- of a silently-dropped claim. So the queue marker cannot double as the
-- in-flight marker: an episode out with a batch is BOTH un-extracted and
-- not-to-be-re-drafted, and one nullable timestamp cannot hold two states.
--
-- Hence a pointer (`brain_episodes.extraction_batch_id`) and a ledger row it
-- points at. The drain excludes an episode whose batch is STILL IN FLIGHT —
-- reading this table's `status`, not merely testing the pointer for NULL — so
-- the moment a batch settles in either direction, every episode of it that was
-- not stamped is back on the queue at its original `ingested_at` position, with
-- no backfill, no sweep and no repair verb. `DRAIN_EPISODES_SQL` carries why
-- the cheaper predicate is a permanent-stranding bug rather than a style
-- choice; abandoning a batch ALSO clears the pointers, which keeps the partial
-- index small and the re-queue legible, but correctness does not rest on it.
--
-- ## Why a table rather than a column on `brain_episodes`
--
-- A bare `extraction_batch_id text` with no ledger would record the association
-- and nothing else. Three things then have no home, and each of them is a
-- decision the collect phase has to make:
--
--   * **When does an unreturned batch stop being in flight?** Anthropic expires
--     a batch at 24h; a submission whose response we never saw has no id at all.
--     `expires_at` is what turns "we are still waiting" into "re-queue these"
--     WITHOUT a human, and it must be readable from the row rather than inferred
--     from `submitted_at` plus a constant that may change.
--   * **What did we submit it as?** `model_id` and `provider` — a batch
--     submitted on Haiku before an operator changed the tier is collected after,
--     and provenance records what actually produced the claim (`detail.model`).
--     Reading the CURRENT setting at collect time would stamp the wrong model id
--     onto claims a different one produced.
--   * **Why did it fail?** `abandon_reason` on the abandon arm, so an operator
--     asking "why is nothing draining" gets the vendor's answer and not just a
--     count.
--
-- ## Retention: rows are kept, not swept
--
-- One row per ~25 episodes, four small columns and no customer content — a
-- workspace draining a 2M-message backfill accrues ~80k rows once, ever. There
-- is deliberately NO retention sweep: the pointer FK means a sweep would have to
-- coordinate with the drain to avoid deleting a row an episode still names, and
-- that is a second deleter of the record the collect phase depends on. The
-- purge scope (`lib/db/purge-scope.ts`) removes them with the workspace, which
-- is the only deletion this table needs.

CREATE TABLE IF NOT EXISTS brain_extraction_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Better-Auth organization id. Workspace-global, TEXT/no-FK like every other
  -- org-scoped Atlas table.
  workspace_id text NOT NULL,

  -- The RESOLVED provider that minted this batch — `anthropic` today, and the
  -- only one, because a batch endpoint is a per-vendor capability rather than an
  -- assumption of the cycle. Recorded rather than derived: `getDefaultProvider()`
  -- reads env that can change under a deploy, and a batch submitted against one
  -- vendor must not be collected against another's API shape.
  provider text NOT NULL,

  -- The vendor's own batch handle (`msgbatch_…`). The poll and the results read
  -- key on it.
  provider_batch_id text NOT NULL,

  -- The model id the requests were submitted WITH. See the header: this is what
  -- reaches `provenance.model` when the results land, so that a tier change
  -- between submit and collect does not retroactively re-attribute the claims.
  model_id text NOT NULL,

  -- How many episodes went out in it. Kept so the collect phase can say
  -- "expected 25, matched 24" — a result set short by one is a `custom_id` bug,
  -- and without this it is indistinguishable from a batch that was simply small.
  request_count integer NOT NULL,

  status text NOT NULL,

  submitted_at timestamptz NOT NULL DEFAULT now(),

  -- The vendor's own expiry, stored rather than computed. Past it the batch is
  -- abandoned and its episodes re-queued; work-then-stamp means that costs a
  -- repeated model call and nothing else.
  expires_at timestamptz NOT NULL,

  -- When the row left `in_flight`, in either direction. NULL exactly while in
  -- flight — enforced below rather than left to convention, because the collect
  -- scan's predicate is `status`, and a row that is settled by one field and
  -- in-flight by the other is a batch that gets collected forever.
  settled_at timestamptz,

  -- The vendor's message on the abandon arm. NULL on the collected arm and on
  -- every in-flight row. Scrubbed through `errorMessage` at the writer.
  abandon_reason text,

  CONSTRAINT ck_brain_extraction_batch_status
    CHECK (status IN ('in_flight', 'collected', 'abandoned')),

  -- The two fields that describe the same fact must agree. Stated as a CHECK
  -- because the failure is silent in both directions: a settled row still
  -- selected by the collect scan re-reads a batch forever, and an in-flight row
  -- carrying `settled_at` is a batch nothing will ever collect while its
  -- episodes stay pointed at it.
  CONSTRAINT ck_brain_extraction_batch_settled
    CHECK ((status = 'in_flight') = (settled_at IS NULL)),

  -- `abandon_reason` belongs to the abandon arm alone. Without this a collected
  -- batch could carry vendor error text an operator would read as a failure.
  CONSTRAINT ck_brain_extraction_batch_reason_only_when_abandoned
    CHECK (abandon_reason IS NULL OR status = 'abandoned'),

  -- A vendor batch id is unique to the account, not the workspace — but the
  -- workspace is what scopes every other read here, and two workspaces on the
  -- SAME platform key can legitimately see the same id space. Scoped per
  -- workspace so a BYO workspace and the platform cannot collide, which is the
  -- `uq_brain_episodes_source_id` rule exactly.
  CONSTRAINT uq_brain_extraction_batch_provider_id UNIQUE (workspace_id, provider_batch_id),

  -- Referent for the composite FK from `brain_episodes` below. Adds no new
  -- uniqueness (`id` is the PK) — it exists so `(workspace_id, id)` has a unique
  -- index to point at, which is what lets that FK PROVE an episode and the batch
  -- it is out with share a workspace. Same construction as
  -- `uq_brain_episodes_workspace_id`.
  CONSTRAINT uq_brain_extraction_batch_workspace_id UNIQUE (workspace_id, id)
);

-- The collect scan. PARTIAL on `in_flight` so what is scanned is proportional to
-- work outstanding rather than to history — the same shape, and the same reason,
-- as `idx_brain_episodes_extraction_queue`. Ordered by `submitted_at` so the
-- oldest batch is polled first and an expiry is noticed at the front of the
-- queue rather than behind a hundred fresh submissions.
CREATE INDEX IF NOT EXISTS idx_brain_extraction_batch_in_flight
  ON brain_extraction_batch (submitted_at)
  WHERE status = 'in_flight';

-- The pointer. NULL for every episode not currently out with a batch, which is
-- every episode on the synchronous path and every episode ever drained before
-- this migration.
--
-- ⚠️ A ROLLING-DEPLOY NOTE, stated because it is the one window where this is
-- not inert: an N-1 pod's `DRAIN_EPISODES_SQL` does not carry the
-- `extraction_batch_id IS NULL` predicate, so during the overlap it can select
-- an episode that is out with a batch and extract it synchronously. The cost is
-- a duplicate model call and, at worst, a second draft for one claim collapsed
-- by reconcile's slot-key dedupe — the paraphrase case `extract.ts`'s header
-- already prices. It is bounded to the overlap because batch is OFF by default
-- (`ATLAS_BRAIN_EXTRACTION_BATCH_ENABLED`), so no in-flight row exists until an
-- operator turns it on, which is after the deploy.
ALTER TABLE brain_episodes
  ADD COLUMN IF NOT EXISTS extraction_batch_id uuid;

-- Composite, so the FK proves same-workspace rather than merely same-batch. NO
-- ACTION on delete (the default) rather than SET NULL: a column-list SET NULL
-- cannot null one half of a composite whose other half is NOT NULL, and the
-- abandon path clears the pointers itself before anything would delete a row —
-- which is the order the purge scope also takes (`brain_episodes` before
-- `brain_extraction_batch`).
--
-- ⚠️ The probe is SCHEMA-SCOPED (`connamespace`), and an unscoped one is a
-- silent skip rather than a loud failure. `pg_constraint.conname` is unique per
-- namespace, NOT per database: an unscoped `WHERE conname = …` sees another
-- schema's constraint, concludes this one already exists, and leaves the table
-- with no FK at all — so a cross-workspace pointer becomes representable in a
-- deployment that reads green. It bites two ways, and both are real here: the
-- `-pg` suites run migrations under per-test schemas in one shared database, and
-- `ATLAS_SCHEMA` is a supported production setting. 0133 records the same trap
-- for the same reason; it was rediscovered here by the `-pg` test below, which
-- passed on every constraint except this one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_brain_episodes_extraction_batch'
      AND connamespace = current_schema()::regnamespace
  ) THEN
    -- ⚠️ A PLAIN, VALIDATING `ADD CONSTRAINT` — and the `NOT VALID` +
    -- `VALIDATE CONSTRAINT` split an earlier draft used here is recorded as
    -- REJECTED, because it buys nothing under this repo's migration runner and
    -- its rationale reads convincing enough to be re-added by the next person.
    --
    -- The concern behind it is real: this takes SHARE ROW EXCLUSIVE on
    -- `brain_episodes` — blocking every connector's inserts — while it scans
    -- the table, and that is the table this file's own header describes holding
    -- a multi-million-row Slack backfill.
    --
    -- What makes the split useless is `lib/db/migrate.ts`, which wraps EACH
    -- MIGRATION FILE in one `BEGIN`/`COMMIT` (its own comment: *"PostgreSQL DDL
    -- is transactional"*). So:
    --
    --   * The lock the `ADD` takes is held until that COMMIT regardless. Doing
    --     the scan under a lighter lock afterwards does not shorten the window
    --     writers are blocked for; it is the same transaction.
    --   * "A deploy that added the constraint but died before validating
    --     converges on the next run" is unreachable for the same reason — a
    --     death rolls both statements back together, so there is no half-state
    --     to converge from.
    --
    -- The split only pays off across SEPARATE transactions, which would mean
    -- teaching the runner to mark a migration as non-transactional. That is a
    -- runner change, deliberately not smuggled in under a brain feature.
    --
    -- Affordable as it stands because the scan finds nothing to check: the
    -- column was added moments ago in this same file, so every existing row has
    -- a NULL pointer and the FK's validation scan is a straight pass.
    ALTER TABLE brain_episodes
      ADD CONSTRAINT fk_brain_episodes_extraction_batch
      FOREIGN KEY (workspace_id, extraction_batch_id)
      REFERENCES brain_extraction_batch (workspace_id, id);
  END IF;
END $$;

-- Serves the abandon path's `WHERE extraction_batch_id = $1` re-queue and the
-- collect phase's per-batch episode load. PARTIAL, so it holds only the episodes
-- currently in flight — on the synchronous path it is empty.
CREATE INDEX IF NOT EXISTS idx_brain_episodes_extraction_batch
  ON brain_episodes (extraction_batch_id)
  WHERE extraction_batch_id IS NOT NULL;
