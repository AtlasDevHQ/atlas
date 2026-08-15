-- 0202 — Denominator snapshots: dated survey-unit rosters (#5213, ADR-0041).
--
-- The Coverage Surface's denominators come from SCHEDULED CYCLES writing dated
-- snapshots, never from live vendor calls on page view (ADR-0041 § The surface).
-- Two tables, because a roster and the cycle that wrote it answer different
-- questions and only one of them survives a failure:
--
--   - `brain_coverage_snapshot` — one row per (workspace, class, survey unit),
--     carrying the unit's state, the disclosure facts a label decision needs,
--     and the two timestamps a measured lag is computed from.
--   - `brain_coverage_cycle` — one row per (workspace, class), carrying when the
--     enumeration last ATTEMPTED and when it last SUCCEEDED. A failed cycle
--     leaves the roster exactly as it was and moves only `last_attempt_at` +
--     `last_error`, which is what lets the page say "enumeration unavailable
--     since <date>" instead of rendering a zeroed roster.
--
-- ## Why the failure state needs its own table rather than a column
--
-- ADR-0041: "a failed snapshot load is 'enumeration unavailable since <date>',
-- never zero". A per-row `stale` flag cannot express that, because the failure
-- is a statement about the ENUMERATION and not about any unit — the units are
-- exactly the ones nobody could re-observe, so there is no row to write it on.
-- Worse, the zero case is the one that matters: a workspace whose Slack token
-- was revoked has a roster whose every row is untouchable, and a design that
-- records failure per unit records it nowhere at all for a class whose
-- enumeration returned nothing.
--
-- ## `state` is DERIVED, and the CHECK is what stops it drifting
--
-- ADR-0041's state 1 is "inside the perimeter, evidence actually observed", and
-- ADR-0040 rule 3 says green is evidence, never configuration. So `surveyed`
-- means BOTH halves: the unit is in the perimeter AND at least one episode has
-- been observed for it. `in_perimeter` and `newest_evidence_at` are the halves
-- and `state` is their conjunction, pinned by
-- `ck_brain_coverage_snapshot_state_is_evidence`.
--
-- Storing all three rather than deriving `state` at read time is deliberate: the
-- page reads `state` directly and a derivation repeated at every read site is a
-- second place the green-is-evidence rule could be decided. The CHECK is what
-- makes the redundancy safe — a writer that sets `surveyed` on a unit with no
-- evidence is refused by the database rather than believed.
--
-- The third state, **unenumerable**, has NO ROW HERE and never will. It is the
-- map edge, "shown as a mark, never a number: any denominator that includes it
-- is fabricated". Its marks live in `brain_coverage_cycle.degraded_arms`.
--
-- ## `in_perimeter AND newest_evidence_at IS NULL` is a real, important state
--
-- A channel the bot was invited to that has produced no episode yet. It is NOT
-- surveyed — calling it surveyed is exactly the configuration-as-green failure
-- M1 shipped (Slack live in three regions, extraction on, zero facts for four
-- days, every surface green). It reads `enumerated` with `in_perimeter = true`,
-- which is a sentence an admin can act on.
--
-- ## `human` cannot appear, and the CHECK says so rather than a comment
--
-- `CLASS_CONTRACTS.human` declares `{ surveyable: false }` — no credential
-- enumerates "the set of humans who might state something", and a unit of that
-- class would be a PERSON, which ADR-0041 refuses by name. The class CHECK
-- admits the four surveyable classes and refuses `human` at the database, so a
-- writer that grew a `human` arm fails loudly instead of counting people.
--
-- Adding a class to `EPISODE_SOURCE_CLASSES` therefore requires a migration if
-- and only if the class is surveyable. That friction is the point:
-- `coverage-enumeration.test.ts` pins this list against `CLASS_CONTRACTS`, so a
-- surveyable class added without a migration reddens rather than silently
-- failing its first write.

CREATE TABLE IF NOT EXISTS brain_coverage_snapshot (
  -- Better-Auth organization id. Workspace-global, TEXT/no-FK like every other
  -- org-scoped Atlas table.
  workspace_id text NOT NULL,

  -- `EpisodeSourceClass`, minus `human`. See the header.
  source_class text NOT NULL,

  -- The survey unit's vendor-side identity: a Slack channel id, a
  -- length-prefixed `<entity>`/`<dimension>` pair for the warehouse, a mailbox
  -- id for email.
  --
  -- An ID, deliberately, and never a surface. ADR-0041 admits "mailboxes/persons
  -- stored as ids for counting" while refusing to NAME them, and this column is
  -- the counting key. The nameable surface lives in `unit_label` beside it,
  -- which is NULL unless a label clause admitted it.
  unit_id text NOT NULL,

  -- `surveyed` | `enumerated`. Derived — see the header and the CHECK below.
  state text NOT NULL,

  -- Did a deliberate act put this unit inside the perimeter? Membership for
  -- chat (minus exclusions), enrollment for the warehouse.
  in_perimeter boolean NOT NULL,

  -- The unit's human-readable name, or NULL when no label clause admits it.
  --
  -- ⚠️ Written through `coverageLabelPolicy` at ENUMERATION time, not merely
  -- read through it at page time. #5214 owns the read-time policy and will apply
  -- it again; this column exists so the write path cannot make over-disclosure
  -- the path of least resistance. A mailbox's address is never stored, so a
  -- future reader that forgot the policy has nothing to leak.
  unit_label text,

  -- The two disclosure facts the label policy consumes, stored so a later read
  -- can re-derive the decision rather than trust this row's `unit_label`.
  -- `vendor_reports_public` is the VENDOR's answer about this unit (a public
  -- Slack channel); the class-level admissibility gate lives in
  -- `CLASS_CONTRACTS`, and `coverageLabelPolicy` ANDs the two.
  deliberate_act boolean NOT NULL,
  vendor_reports_public boolean NOT NULL,

  -- OUR side of the lag: the newest evidence Atlas has observed for this unit.
  -- NULL means none — which, combined with `in_perimeter`, is the M1 state
  -- described in the header.
  newest_evidence_at timestamptz,

  -- THE VENDOR'S side of the lag, and it is read from the vendor rather than
  -- from our own store. Reading it from our episodes would make the lag
  -- structurally zero and the whole measurement decorative: "stale" means the
  -- SOURCE has moved since we last looked, so the source is what has to be
  -- asked. NULL for a class whose contract declares `activityMetadata: "absent"`
  -- (warehouse), and NULL for a unit the probe rotation has not reached yet.
  vendor_activity_at timestamptz,
  -- When that probe last ran, which is also the probe rotation's ORDER BY.
  -- Separate from the value because "we asked and the channel is empty" and "we
  -- have not asked" are different facts and only the second one is a gap.
  vendor_activity_checked_at timestamptz,

  -- The cycle that wrote this row. "As of <date>" is part of the statement
  -- (ADR-0041), and it is also the sweep key: a successful cycle deletes the
  -- rows it did not re-observe by comparing this against its own instant.
  cycle_at timestamptz NOT NULL,

  PRIMARY KEY (workspace_id, source_class, unit_id),

  -- `human` is refused here. See the header.
  CONSTRAINT ck_brain_coverage_snapshot_class
    CHECK (source_class IN ('chat', 'transcript', 'email', 'warehouse')),
  CONSTRAINT ck_brain_coverage_snapshot_state
    CHECK (state IN ('surveyed', 'enumerated')),
  -- A unit with no id counts toward a denominator and can never be found again.
  CONSTRAINT ck_brain_coverage_snapshot_unit_present
    CHECK (unit_id <> ''),
  -- `''` is a label that renders as an unnamed row while reading as named.
  CONSTRAINT ck_brain_coverage_snapshot_label_present
    CHECK (unit_label IS NULL OR unit_label <> ''),
  -- GREEN IS EVIDENCE. The whole of ADR-0040 rule 3, as one constraint.
  CONSTRAINT ck_brain_coverage_snapshot_state_is_evidence
    CHECK ((state = 'surveyed') = (in_perimeter AND newest_evidence_at IS NOT NULL)),
  -- An activity reading with no reading time is an unattributed measurement:
  -- the lag is computed against it, and a value whose age is unknown cannot be
  -- compared to a cadence. `brain_slack_channel`'s health-error rule, one seam
  -- over.
  CONSTRAINT ck_brain_coverage_snapshot_activity_attributed
    CHECK (vendor_activity_at IS NULL OR vendor_activity_checked_at IS NOT NULL)
);

-- NO SECONDARY INDEX, deliberately — `brain_enrollment`'s argument.
--
-- Every read is prefixed by `(workspace_id, source_class)`, which the PRIMARY
-- KEY already is: the page's per-class counts, the sweep's delete, and the
-- activity probe's rotation all scan that prefix. The rotation additionally
-- sorts on `vendor_activity_checked_at`, over one class of one workspace — a
-- set bounded by what a bot was invited to, not by workspace size. A second
-- tree for that sort would be maintained on every row of every cycle to save a
-- sort over tens of rows.

-- ---------------------------------------------------------------------------
-- The per-(workspace, class) cycle record
-- ---------------------------------------------------------------------------
-- Separate from the roster because it survives the failure the roster cannot
-- express. See the header.
CREATE TABLE IF NOT EXISTS brain_coverage_cycle (
  workspace_id text NOT NULL,
  source_class text NOT NULL,

  -- Always moved, success or failure. The pair `(last_attempt_at,
  -- last_success_at)` is what distinguishes "nobody has looked lately" from
  -- "something has been failing since <date>".
  last_attempt_at timestamptz NOT NULL,
  -- NULL until the first successful enumeration. A workspace that has never
  -- succeeded has no roster either, and the page must not read that as "zero
  -- channels" — it is "enumeration unavailable", which needs this NULL to be
  -- distinguishable from an old date.
  last_success_at timestamptz,
  -- Cleared on success. Retained verbatim on failure so the surface can say
  -- WHY, in the words the enumerator chose for an admin.
  last_error text,

  -- ADR-0041's MAP EDGE, as marks rather than numbers.
  --
  -- Each entry names an arm of this class's enumeration that could not be
  -- performed on the LAST SUCCESSFUL cycle — a Slack token without the scope to
  -- list public channels, a roster that hit its page bound. The page renders
  -- them as marks ("there are channels beyond what these credentials can see")
  -- and never as a count, because "any denominator that includes it is
  -- fabricated".
  --
  -- Empty is the ordinary case and is NOT the same as a failed cycle: a
  -- complete enumeration with no edges is a full map of what the credentials
  -- can see.
  degraded_arms text[] NOT NULL DEFAULT '{}',

  PRIMARY KEY (workspace_id, source_class),

  CONSTRAINT ck_brain_coverage_cycle_class
    CHECK (source_class IN ('chat', 'transcript', 'email', 'warehouse')),
  -- An error with no message is a red dot an admin cannot act on —
  -- `brain_slack_channel`'s rule.
  CONSTRAINT ck_brain_coverage_cycle_error_present
    CHECK (last_error IS NULL OR last_error <> ''),
  -- A NULL element reads as an arm matching nothing, silently dropping one map
  -- edge from the mark set — `brain_slack_ingest_scope`'s rule.
  CONSTRAINT ck_brain_coverage_cycle_arms_no_null
    CHECK (array_position(degraded_arms, NULL) IS NULL),
  CONSTRAINT ck_brain_coverage_cycle_arms_present
    CHECK (array_position(degraded_arms, '') IS NULL)
);
