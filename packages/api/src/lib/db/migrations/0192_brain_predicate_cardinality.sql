-- 0192 — Cardinality as a property of the canonical predicate (#5027,
-- ADR-0037 §3 "Cardinality is a property of the predicate").
--
-- ## What this replaces, and why it was worse than the empty column everyone
-- ## believed it was
--
-- `brain_facts.predicate_cardinality` (0180) was believed unpopulated. It was
-- not: `brain/extract.ts` wrote the MODEL's per-claim guess and
-- `brain/correction.ts` inherited it onto every replacement. The publish gate's
-- collision rule then required `'single'` on BOTH sides
-- (`content-mode/adapters/brain-facts.ts`), and the two sides come from two
-- INDEPENDENT model calls on two different messages, against a prompt that says
-- "When unsure answer 'multi'". So supersession fired at roughly
-- P(model says 'single')².
--
-- An unpopulated column fails predictably. That one failed STOCHASTICALLY, on
-- an irreversible operation — a `valid_to` stamp no verb restores. It is the
-- fourth independent cause of #5000's symptom and the only one that is not a
-- string-matching problem.
--
-- One value per canonical predicate makes the both-sides requirement satisfiable
-- BY CONSTRUCTION: two rows in one slot share a `predicate_key`, so they can no
-- longer each carry an opinion and therefore can no longer disagree. The cause
-- is made unrepresentable rather than fixed.
--
-- ## Why the key is `predicate_key` and not a norm
--
-- `predicate_key` is `alias(lexicalNorm(surface))` (0187, ADR-0037 §1) — the
-- canonical predicate AFTER the vocabulary's closure has been applied, which is
-- exactly the thing §3 says cardinality attaches to. Keying on a raw norm would
-- reintroduce the disagreement this table exists to remove: `is priced at` and
-- `priced at` would hold two entries for one slot the moment an alias merged
-- them.
--
-- The consequence is deliberate and is the one T11 (#5016) inherits: an alias
-- approval MOVES a predicate's population under a different entry. It is the
-- same blast radius the vocabulary already carries, one property over.
--
-- ## Why it is NOT on `brain_vocabulary_target`
--
-- 0189's `recomputeEffectiveTargets` DELETEs and rebuilds that relation's rows
-- wholesale on every approval and every removal, so a human-set cardinality
-- parked there would be destroyed by the next unrelated approval at the
-- predicate position. `vocabulary.ts` says so at the recompute itself: keeping
-- the derived relation free of AUTHORED state is what left room for this table.
--
-- ## One relation, WITH a status — and the difference from 0190 is principled
--
-- 0190 argued at length for a third relation rather than a `status` column,
-- against putting pending rows in `brain_vocabulary_edge`. Neither of its two
-- reasons reaches here, and both are worth checking rather than assuming:
--
--   1. **A pending row would occupy a needed slot.** There, the PK
--      `(workspace, position, from_norm)` IS the at-most-one-parent invariant,
--      so a queued proposal vetoed a decision. Here the "slot" is one canonical
--      predicate, and a pending proposal for `reports to` SHOULD block a second
--      concurrent proposal for `reports to` — that is idempotence, not a veto,
--      and the SAME slot carries the rejection memory once the row is REJECTED.
--   2. **A proposal would be indistinguishable to the closure rebuild.** There,
--      `recomputeEffectiveTargets` reads the edge table wholesale and would
--      compose an unapproved merge into the closure. Here there is no closure
--      and exactly one reader, and that reader filters on `status = 'approved'`
--      explicitly (`cardinalitySingleSql`).
--
-- So: one row per (workspace, canonical predicate), for all time, and its
-- statuses are that predicate's whole history. A `rejected` row occupies the
-- predicate's only slot, which makes a producer's re-proposal structurally
-- impossible rather than a race between a SELECT and an INSERT — #4507's
-- permanent rejection memory, on 0190's own terms.
--
-- ## `single` requires positive evidence; ABSENT means `multi`
--
-- There is no `multi` backfill and there must never be one. Absent from this
-- table means `multi`, so an UNCURATED predicate never supersedes — today's
-- conservative behaviour, made deterministic. Ambiguity resolves to `multi`
-- too: a predicate whose cardinality depends on the subject's type (`located
-- in` — one HQ, many offices) is simply never marked `single`, so it never has
-- to be adjudicated at all.
--
-- We under-supersede DETERMINISTICALLY rather than supersede stochastically.
--
-- ## No advisory lock, and that is a structural difference rather than an
-- ## omission
--
-- Every 0189 primitive is a check-then-write or a clear-then-rebuild and is only
-- atomic inside a transaction, which is why `vocabulary.ts` REFUSES to run
-- outside one. Nothing here has that shape: every write below is a single-row
-- `INSERT … ON CONFLICT`, atomic on its own. Taking 0189's namespace anyway
-- would buy nothing and would create a second lock-order edge into
-- `correction.ts` — which is where the correction-event proposer runs, and
-- which already sits under the identity-mutation namespace's ordering rules.
--
-- ## What is deliberately NOT here
--
-- No `visible_to`. The vocabulary is the one piece of brain state with no ACL,
-- permanently (ADR-0037 §6), and cardinality is a second vocabulary property
-- under the same authority.
--
-- No evidence columns. `source_class` records WHICH of §3(d)'s three sources
-- proposed the row; WHICH facts it read is the proposer's business, and a column
-- added here first would be one nothing writes and everything has to guess at
-- (0190's rule, same reason).
--
-- No drop of `brain_facts.predicate_cardinality`. That column is NOT NULL with a
-- live CHECK, so #5027 stops READING and WRITING it (it leaves
-- `INSERT_FACT_SQL`'s explicit column list and falls to its schema default) and
-- #5028 drops it one release later — the two-phase discipline
-- `db/migrations/README.md` requires.

CREATE TABLE IF NOT EXISTS brain_predicate_cardinality (
  -- Better-Auth organization id. Workspace-global, TEXT/no-FK like every other
  -- org-scoped Atlas table.
  workspace_id text NOT NULL,
  -- The CANONICAL predicate: `alias(lexicalNorm(surface))` at the predicate
  -- position, i.e. exactly what `brain_facts.predicate_key` holds. Callers get
  -- it from `slotKey(surface, vocabulary.predicate)` and never hand-normalize.
  predicate_key text NOT NULL,
  -- 'single' — the subject holds at most one object in this slot at a time, so
  -- a newer claim RETIRES an older one at the publish gate. 'multi' — an
  -- adjudicated record that values coexist. Storing 'multi' explicitly is not
  -- redundant with absence: absence means nobody has looked, and a stored
  -- 'multi' is a human declining the question, which is what stops a producer
  -- re-proposing it.
  cardinality text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  -- WHICH of ADR-0037 §3(d)'s three sources put this row here, and the ONLY
  -- input to whether it may be written without a human:
  --
  --   'warehouse_structural' — a dimension of one row is `single` BY
  --     CONSTRUCTION. Authoritative, not a hint (§3(d)1). Its producer is #5042
  --     and does not exist yet.
  --   'correction_event' — a human superseding a slot has asserted BY THEIR
  --     ACTION that it holds one value (§3(d)2). Repeat-gated. This is the one
  --     source #5027 implements, and it PROPOSES: it may only ever write
  --     `status = 'pending'`.
  --   'human' — direct authoring at the vocabulary's gate (§3(d)3). Writes
  --     `approved` directly, because the human IS the approval. Its UI is #5025.
  --
  -- A CHECK rather than an application-only rule, because this column is the
  -- allowlist: `single` may enter by these three doors and no others, and a
  -- fourth producer must earn its arm here rather than inherit one.
  source_class text NOT NULL,
  -- The producer id, or the human who authored the row directly. NOT NULL on
  -- `brain_vocabulary_proposal.proposed_by`'s reasoning: every row has an
  -- author, and the "machine, no human" case is carried by `reviewed_by` being
  -- NULL rather than by this column.
  proposed_by text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  -- Who approved or rejected, and when. Same three-valued domain as
  -- `brain_vocabulary_edge.approved_by` — NULL for a machine decision,
  -- 'local-operator' for a human on a no-auth deployment, otherwise a user id.
  reviewed_by text,
  reviewed_at timestamptz,
  PRIMARY KEY (workspace_id, predicate_key),
  CONSTRAINT ck_brain_predicate_cardinality_value
    CHECK (cardinality IN ('single', 'multi')),
  CONSTRAINT ck_brain_predicate_cardinality_status
    CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT ck_brain_predicate_cardinality_source_class
    CHECK (source_class IN ('warehouse_structural', 'correction_event', 'human')),
  -- An empty key is not a predicate. `identityKey` answers NULL for a surface
  -- that norms away, and a caller coercing that to `''` would file every
  -- degenerate predicate in the workspace under one entry — which, for a
  -- `single` row, is a workspace-wide licence to supersede.
  CONSTRAINT ck_brain_predicate_cardinality_key_present
    CHECK (predicate_key <> ''),
  -- `NOT NULL` alone admits `''`, which is an unattributed row wearing the
  -- shape of an attributed one. This column is the first thing an audit of a
  -- retroactive re-key reads, and a `single` entry makes every existing
  -- published pair in its slot supersedable at the next publish — so a row
  -- nobody can be shown to have asked for is not a row this table stores.
  --
  -- Enforced here as well as at both write paths because the store is not the
  -- only writer this table will ever have: #5025's route and #5042's producer
  -- are still to come, and a CHECK is what holds for a hand-written INSERT.
  CONSTRAINT ck_brain_predicate_cardinality_author_present
    CHECK (proposed_by <> '')
);

-- The queue read: one workspace's undecided proposals, newest first. The PK
-- leads with `workspace_id` but continues on `predicate_key`, so it is not an
-- access path for a status-filtered scan. Partial, because the decided rows are
-- read by IDENTITY through the PK — the approved ones by the publish gate's
-- EXISTS, the rejected ones by the proposer's ON CONFLICT — and never listed.
CREATE INDEX IF NOT EXISTS idx_brain_predicate_cardinality_pending
  ON brain_predicate_cardinality (workspace_id, proposed_at DESC)
  WHERE status = 'pending';
