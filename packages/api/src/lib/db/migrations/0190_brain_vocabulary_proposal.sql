-- 0190 — The alias proposal queue and its permanent rejection memory (#5023,
-- ADR-0037 §6 "Authority: `decideAmendment`'s shape, not the publish gate").
--
-- 0189 shipped the vocabulary as two relations and said in as many words what
-- it left out: "No proposal queue, no rejection memory, no decide-seam
-- plumbing — #5023 owns the approval flow." This is that table.
--
-- ## Why a THIRD relation rather than a `status` column on the edge table
--
-- `brain_vocabulary_edge` holds APPROVED edges and nothing else, and its
-- primary key `(workspace_id, slot_position, from_norm)` is the
-- at-most-one-parent invariant that makes `alias` a function. A pending row
-- carrying a `status` would OCCUPY the slot an approved edge needs: propose
-- `is priced at → list price`, and the workspace can no longer approve
-- `is priced at → priced at` without the PK refusing it — a queue entry
-- vetoing a decision. Worse in the other direction: a proposal and an approved
-- edge would be indistinguishable to `recomputeEffectiveTargets`, which reads
-- the edge table wholesale, so a merge nobody approved would enter the closure
-- and re-key the corpus.
--
-- So the queue is its own relation, and the edge table keeps meaning exactly
-- one thing.
--
-- ## The identity is the UNORDERED pair, and that is the rejection memory
--
-- ADR-0037 §6 adopts #4507's permanent rejection memory: a rejected identity is
-- refused at insert, forever, because "T3 §8 made removal the sole reversibility
-- mechanism — and a producer RE-RUNS". Without it the next producer pass
-- re-writes what a human removed.
--
-- The identity a rejection remembers is the pair `{a, b}` at a position, NOT
-- the ordered edge `a → b`. Two reasons, and the first is a hole rather than a
-- preference:
--
--   1. Direction is not fixed until approval. A seam-proposed candidate is
--      UNDIRECTED when neither side is warehouse-derived (`priced at` vs `is
--      priced at` — #5000's own case), so an ordered identity would let a
--      producer route around a rejection by emitting the pair the other way,
--      and it would do so without any intent to.
--   2. A rejection means "these two norms are not the same slot". It never has
--      to mean "wrong direction", because approval SETS the direction — a
--      reviewer who wants the other one approves it, rather than rejecting and
--      waiting for the producer to guess again.
--
-- `pair_low` / `pair_high` are GENERATED columns rather than a caller-computed
-- key, so the unordered identity is a property of the row and cannot be got
-- wrong by a second writer. Approval may SWAP `from_norm` / `to_norm` to set
-- the direction; both generated columns are invariant under that swap, so the
-- row keeps its identity across the decision that changes it.
--
-- The UNIQUE below is therefore total, not partial: at most ONE row per
-- (workspace, position, pair), for all time. Its statuses are the pair's whole
-- history — which is what lets `approved → rejected` (a REMOVAL) write the
-- rejection memory that stops the producer re-emitting the edge it just
-- removed. A partial unique index scoped to the live statuses would have let a
-- second row for a rejected pair exist, and the refusal would then depend on a
-- SELECT finding the right one of them.
--
-- ## `applying` is here and is unobservable, deliberately
--
-- The seam is `decideAmendment`'s shape — claim → apply → stamp — so
-- "approved means applied" holds by construction. Unlike a semantic amendment,
-- whose apply mutates YAML on disk across three separate transactions, an alias
-- apply is a DB write in the SAME transaction as the claim and the stamp. So
-- `applying` never commits: a crash rolls the whole decision back, and no
-- reader outside that transaction can observe the state.
--
-- Kept anyway, and the reason is #5024. ADR-0037 §7 puts the drift re-key —
-- a sequential rewrite of every affected `brain_facts` row — inside this same
-- decide transaction. The moment that write is long enough to want its own
-- transaction, `applying` becomes observable and `claimed_at` becomes the
-- takeover token `decide.ts:31-41` describes. Adding the column then would be a
-- migration on a hot table; having it now costs nothing and keeps the seam's
-- shape honest about what it is modelled on.
--
-- ## What is deliberately NOT here
--
-- No `visible_to`. The vocabulary is the one piece of brain state with no ACL,
-- permanently (ADR-0037 §6), and a proposal is vocabulary state. Proposal
-- VISIBILITY is positional and is a property of the queue READ (#5025's surface
-- over #5034's proposal query), computed from the evidence rows — not a grant
-- stored here, which would be a second, drifting ACL for a subsystem whose
-- design says it has none.
--
-- No evidence columns (which facts generated the proposal). #5034 owns the
-- proposal query and is where the evidence shape gets decided; a column added
-- here first would be one nothing writes and everything has to guess at.

CREATE TABLE IF NOT EXISTS brain_vocabulary_proposal (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  slot_position TEXT NOT NULL,
  -- The proposed direction. For a DIRECTED proposal this is the producer's
  -- claim about which norm is canonical; for an UNDIRECTED one it is just the
  -- pair in the order it arrived, and approval is what fixes it (ADR-0037 §6 —
  -- "approval sets direction where absent"). Both are LEXICAL NORMS, re-normed
  -- by the writer for `approveAliasEdge`'s reason.
  from_norm TEXT NOT NULL,
  to_norm TEXT NOT NULL,
  -- The unordered identity. GENERATED, so the two-relation split cannot be
  -- defeated by a writer that computes the pair key itself and gets the
  -- ordering wrong — and so a direction-setting approval, which swaps the two
  -- columns above, leaves the row's identity untouched.
  pair_low TEXT GENERATED ALWAYS AS (LEAST(from_norm, to_norm)) STORED,
  pair_high TEXT GENERATED ALWAYS AS (GREATEST(from_norm, to_norm)) STORED,
  -- FALSE when neither side is warehouse-derived, so no producer can say which
  -- spelling is canonical. An approval of an undirected proposal MUST supply
  -- the direction; the seam refuses without it rather than picking one, because
  -- picking one is exactly the silent workspace-wide re-key the vocabulary
  -- exists to put a human in front of.
  directed BOOLEAN NOT NULL,
  -- Where the proposal came from, and the ONLY input to auto-approve
  -- eligibility. T11 (#5016) §3(b), restated by ADR-0037 §6: warehouse-derived
  -- entity edges backed by a primary key may auto-approve; extractor-derived
  -- and seam-proposed edges always queue.
  --
  -- `warehouse_key` is refused at the PREDICATE position by the writer, not by
  -- a CHECK — a CHECK here would state the rule without the message that makes
  -- it actionable, and the rule is an authority posture rather than a data
  -- shape. A warehouse primary key backs an entity INSTANCE; a predicate is a
  -- verb phrase and has none, so the class cannot honestly arise there.
  source_class TEXT NOT NULL,
  -- The producer's confidence, 0–1. The threshold half of the auto-approve
  -- knob reads it (`ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD`), on
  -- `ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD`'s model. A warehouse primary key is
  -- 1 by construction; the column exists so a producer that has a real score
  -- (#5034) has somewhere to put it and the knob has something to gate on.
  confidence DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- The producer, or the human who authored the proposal directly (ADR-0037
  -- §6's "direct human authoring is admitted"). NOT NULL: unlike
  -- `brain_vocabulary_edge.approved_by`, where NULL carries the meaning
  -- "auto-approved, no human", every proposal has an author.
  proposed_by TEXT NOT NULL,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The claim token. Set when the row moves to `applying`, and the stamp is
  -- conditional on it — see the header on why it is unobservable today.
  claimed_at TIMESTAMPTZ,
  -- Who approved or rejected, and when. Same three-valued domain as
  -- `brain_vocabulary_edge.approved_by` — NULL for auto-approval,
  -- 'local-operator' for a human on a no-auth deployment, otherwise a user id.
  -- See 0189's column comment for why the machine case is the NULL one.
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT ck_brain_vocabulary_proposal_slot_position
    CHECK (slot_position IN ('subject', 'predicate', 'object')),
  CONSTRAINT ck_brain_vocabulary_proposal_status
    CHECK (status IN ('pending', 'applying', 'approved', 'rejected')),
  CONSTRAINT ck_brain_vocabulary_proposal_source_class
    CHECK (source_class IN ('warehouse_key', 'extractor', 'seam', 'human')),
  CONSTRAINT ck_brain_vocabulary_proposal_confidence
    CHECK (confidence >= 0 AND confidence <= 1),
  -- The same non-emptiness and 1-cycle refusals the edge table carries, for the
  -- same reasons (0189): an empty norm is not a slot, and a pair whose two
  -- sides are one norm proposes nothing. Enforced here too rather than left to
  -- the approval, so a degenerate row cannot sit in the queue looking decidable.
  CONSTRAINT ck_brain_vocabulary_proposal_norms_present
    CHECK (from_norm <> '' AND to_norm <> ''),
  CONSTRAINT ck_brain_vocabulary_proposal_not_self
    CHECK (from_norm <> to_norm)
);

-- One row per pair, for all time. This IS the rejection memory: a `rejected`
-- row occupies the pair's only slot, so a re-proposal cannot insert beside it
-- and the refusal is structural rather than a race between a SELECT and an
-- INSERT.
--
-- A unique INDEX rather than a table `UNIQUE` constraint, purely so this file
-- and its `db/schema.ts` mirror emit the same object: drizzle's `uniqueIndex`
-- produces `CREATE UNIQUE INDEX`, and a hand-written constraint here would make
-- the two spellings drift for a reader diffing them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_brain_vocabulary_proposal_pair
  ON brain_vocabulary_proposal (workspace_id, slot_position, pair_low, pair_high);

-- The queue read: one workspace's undecided proposals, newest first. The
-- UNIQUE above leads with `workspace_id` but continues on the pair columns, so
-- it is not an access path for a status-filtered scan. Partial, because the
-- decided rows are rejection MEMORY — read by identity through the unique
-- constraint, never listed.
CREATE INDEX IF NOT EXISTS idx_brain_vocabulary_proposal_pending
  ON brain_vocabulary_proposal (workspace_id, slot_position, proposed_at DESC)
  WHERE status IN ('pending', 'applying');
