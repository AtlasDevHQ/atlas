-- 0199 — The enrollment surface (#5196, ADR-0039).
--
-- A human names the `(entity, dimension)` pairs the tier-1 warehouse producer
-- (#5042) may emit claims about. The producer emits for those and only those.
-- An unenrolled dimension is not hidden, not filtered, and not pending — it is
-- OUTSIDE THE PRODUCER'S REACH, and the coverage surface (ADR-0041) reports it
-- as such.
--
-- ## Why a table exists at all instead of a sweep
--
-- Every fact lands as a `draft` needing a human publish — migration 0180's
-- `status` default IS the review gate (`reconcile.ts:777`, #4769). A producer
-- that emitted one fact per row per dimension at machine cadence would put an
-- unreviewable queue behind the one gate the product is differentiated by: ten
-- thousand accounts across eight dimensions is eighty thousand drafts before
-- anyone has reviewed one. Enrollment is the volume answer, and ADR-0040 states
-- the general form: the contract automates AVAILABILITY and never automates
-- AUTHORITY. Live tier-1 through the semantic layer already works on connect;
-- materializing claims from it is the authority arm, and the authority arm is
-- always a person.
--
-- ## What this table is NOT
--
--   - **Not content.** It is not registered in `CONTENT_MODE_TABLES` and has no
--     `status` column. An enrollment is not a claim awaiting review; it is the
--     SCOPE within which claims may later be produced and then reviewed. Giving
--     it a draft/published axis would put a review gate in front of the act that
--     decides what reaches the review gate.
--   - **Not an invalidation authority.** Un-enrolling deletes the row here and
--     touches nothing in `brain_facts`. Already-published facts stay published,
--     stay visible, and keep their validity windows. A machine invalidating a
--     fact is forbidden (#4759 §2, ADR-0036 §T4) and un-enrolling is not a
--     human arbitration of any particular claim — it is a statement about
--     FUTURE emission. The only invalidation authority is the human at the
--     review gate.
--   - **Not a producer input cache.** Nothing derives rows here. See below.
--
-- ## Un-enrolment is a hard DELETE, and that is deliberate
--
-- `brain_vocabulary_proposal` keeps permanent rejection memory because a
-- PRODUCER re-proposes what a human removed (#4507). There is no such producer
-- here and there never may be: ADR-0039's rejected-alternative test says a bulk
-- affordance a person invokes over a set they can see is enrollment, and one
-- that runs on connect, on profile, or on a schedule is a sweep. So absence is
-- unambiguous — it can only have been produced by a person — and a tombstone
-- would record a decision nothing could ever contradict.
--
-- The corollary is enforced in code rather than here, because SQL cannot state
-- it: `lib/brain/__tests__/enrollment-writers.test.ts` pins the set of files
-- that write this table, so a scheduled or on-connect writer has to delete a
-- test before it can exist.
--
-- ## Attribution is NOT NULL and non-empty
--
-- `brain_predicate_cardinality`'s rule and `brain_slack_channel`'s, for the same
-- reason: "who decided the Atlas should hold claims about this?" is an audit
-- question, and `''` is an unattributed decision wearing the shape of an
-- attributed one. NOT NULL alone would admit it.

CREATE TABLE IF NOT EXISTS brain_enrollment (
  -- Better-Auth organization id. Workspace-global, TEXT/no-FK like every other
  -- org-scoped Atlas table.
  workspace_id text NOT NULL,

  -- The semantic-layer entity the pair names — `semantic_entities.name`, the
  -- same string the admin sees in the entity list. Stored as the name rather
  -- than the row id because an entity is re-published (new row, same name) on
  -- every semantic-layer sync, and an id reference would silently un-enroll a
  -- workspace on its next `atlas init`.
  entity text NOT NULL,

  -- The BARE dimension, measure, or metric name — `status`, not `plans.status`
  -- and not `analytics.plans.status`. This matches ADR-0037 §4's emission
  -- contract exactly, and the match is load-bearing rather than cosmetic: the
  -- producer emits the bare name so a warehouse predicate can lexically collide
  -- with what an extractor emits, and an enrollment key qualified differently
  -- from the emitted name would name a pair the producer can never satisfy.
  -- Entity qualification lives in the `entity` column beside it, where it scopes
  -- the enrollment without entering the emitted surface.
  dimension text NOT NULL,

  enrolled_at timestamptz NOT NULL DEFAULT now(),
  -- The person. See the header — an enrollment with no author is not one.
  enrolled_by text NOT NULL,
  -- Free-text, optional. Why this pair is worth holding claims about.
  note text,

  -- The pair IS the identity. Enrolling twice is a no-op rather than a second
  -- row, which is what makes the import merge (`admin-migrate.ts`) a plain
  -- ON CONFLICT DO NOTHING union rather than a reconciliation.
  PRIMARY KEY (workspace_id, entity, dimension),

  -- `''` for either half is a pair that can never match anything the producer
  -- emits, so it would sit in the list looking enrolled and reach nothing.
  CONSTRAINT ck_brain_enrollment_names_present
    CHECK (entity <> '' AND dimension <> ''),
  CONSTRAINT ck_brain_enrollment_attributed
    CHECK (enrolled_by <> '')
);

-- NO SECONDARY INDEX, deliberately.
--
-- The producer's read is one workspace's whole enrolled set ordered by
-- `(entity, dimension)`, and the PRIMARY KEY is already exactly that btree on
-- exactly those columns in exactly that order. An earlier cut added
-- `idx_brain_enrollment_workspace (workspace_id, entity, dimension)` beside it,
-- which is the PK duplicated verbatim: no read it could serve that the PK does
-- not, and a second tree to maintain on every write.
