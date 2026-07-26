-- 0180 — Brain substrate: episodes, facts, edges (#4767, ADR-0036 §The
-- knowledge substrate / §Temporal, conflict & provenance / §Access control).
--
-- The first net-new code of the company-brain bet. ADR-0036 decided a fact/
-- edge/episode substrate with its OWN trust identity, reusing the Knowledge
-- Base's LIFECYCLE (review gate, per-org mirror, ingest seam) but explicitly
-- NOT extending ADR-0028's descriptive-document model — extending KB in place
-- was considered and rejected, because the fact class breaks ADR-0028's flat
-- "descriptive-only" line and that break has to be visible in the schema.
--
-- The three trust tiers, in the vocabulary reserved by the re-aim guide:
--   * tier-1 — warehouse facts, authoritative BY CONSTRUCTION. Not stored
--     here at all: they are computed live through the semantic layer and
--     gated by warehouse RLS. No table in this migration holds a tier-1 fact.
--   * tier-2 — reviewed facts (`brain_facts`), authoritative FOR THEIR CLASS;
--     they yield to the warehouse in any overlap.
--   * tier-3 — raw episodes (`brain_episodes`), source-of-truth for what was
--     actually said, never for what is true.
--
-- SCOPE: schema only. The M2 conflict machinery (as-of reads, in-tension
-- clustering, `correct_fact`, the predicate-cardinality *engine*) is out of
-- scope — but every column and the edge-type enum it will need land NOW, so
-- M2 is purely additive and never rewrites a table under live data.
--
-- ADR-0036 states two rules as absolutes ("no-provenance-no-promotion",
-- "no-grant-no-promotion"), so they are CHECKs rather than application code:
-- an empty provenance object and a grant with no usable principal are refused
-- AT REST, by every writer.
--
-- "No usable principal" is stricter than `cardinality > 0` on purpose:
-- `ARRAY[NULL]` and `ARRAY['']` both have cardinality 1 while granting access
-- to nobody — the same denies-everyone state the rule exists to refuse,
-- wearing a non-empty shape. Structural VALIDITY stops there: whether
-- `['everyone']` is a MEANINGFUL principal is #4768's parser and its deny+log
-- path. The split matters because anything legal at rest must be migratable,
-- and an importer stricter than the CHECK would make a workspace that Postgres
-- happily stores impossible to move between regions.
--
-- Workspace containment is structural too: a fact's `(workspace_id,
-- source_episode_id)` is a COMPOSITE FK onto the episode's `(workspace_id,
-- id)`, and each edge endpoint composes the same way. A fact hanging off
-- another workspace's episode would otherwise be exportable into the wrong
-- tenant's bundle and invisible to the residency cleanup sweep — the sweep
-- scopes facts through the episode. Nothing writes these tables yet, which
-- makes this the cheapest possible moment to make it unrepresentable.

-- ---------------------------------------------------------------------------
-- brain_episodes — tier-3. Immutable, append-only, deduped by stable
-- source-id. The raw record of what a source actually said.
-- ---------------------------------------------------------------------------
--
-- Append-only is the point, not an optimization: an episode is evidence, and
-- evidence that can be edited after the fact cannot back a provenance claim.
-- There is deliberately NO `updated_at` column — its absence is the signal.
--
-- Re-ingest must be a NO-OP rather than an upsert: the ADR-0030 connector
-- engine's subtractive-archive + path-upsert half is bypassed entirely for
-- episodes (that half scopes to facts), because a chat message edited
-- upstream is a NEW episode, not a mutation of the old one. The connector
-- that writes `ON CONFLICT (workspace_id, source, source_id) DO NOTHING`
-- ships in #4770; the UNIQUE index below is what makes that the only
-- available behaviour rather than a call-site convention.
CREATE TABLE IF NOT EXISTS brain_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Better-Auth organization id. Workspace-global, TEXT/no-FK like the other
  -- org-scoped Atlas tables (knowledge_documents, dashboards, …).
  workspace_id text NOT NULL,
  -- Connector class/vendor that produced this episode ('slack', 'warehouse',
  -- 'human'). Class-major per ADR-0036 §Ingestion; `human` is the correction
  -- entry point, `warehouse` the SQL-pinned one.
  source text NOT NULL,
  -- The source's OWN stable identifier for this record. The dedupe key, and a
  -- per-connector obligation: it must be stable across BOTH the webhook
  -- fast-path and the polling path, or the two writers duplicate every
  -- episode they race on.
  source_id text NOT NULL,
  -- The source-side principal who authored the record (e.g. a Slack user id).
  -- Feeds grant derivation and entity resolution at the reconcile stage; NULL
  -- when the source has no meaningful author (a warehouse snapshot).
  source_actor text,
  -- Body XOR locator. ADR-0036 stores episodes BY REFERENCE for warehouse- and
  -- KB-derived facts (the content already has an authoritative home and
  -- copying it would fork the truth), and BY VALUE for chat, where the source
  -- may delete the message out from under us and the evidence must survive.
  -- Exactly one, enforced below — "both" would make it ambiguous which one the
  -- provenance claim actually rests on.
  body text,
  locator text,
  -- Event time: when the thing was said/happened at the source. Distinct from
  -- ingested_at (when Atlas learned of it) — the gap between them is the
  -- freshness lag the connector's high-water mark is chasing.
  occurred_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  -- Extraction work-queue marker. The async extraction fiber (#4771) drains
  -- `extracted_at IS NULL`; stamping it is what takes an episode off the
  -- queue. NULL forever is a visible backlog, not a silent drop — which is why
  -- this is a nullable timestamp and not a boolean.
  extracted_at timestamptz,
  -- ACL grant (see brain_facts.visible_to for the grammar). Tiers 2 AND 3 are
  -- gated: an episode is raw source content and is frequently MORE sensitive
  -- than the facts extracted from it.
  visible_to text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Body XOR locator — never both, never neither. An empty string is refused
  -- outright rather than treated as absent: evidence that is '' backs a
  -- provenance claim with nothing, and "'' means absent" would make
  -- `body='x', locator=''` legal at rest while every reader has to remember
  -- which emptiness counts.
  CONSTRAINT chk_brain_episodes_body_xor_locator
    CHECK (
      num_nonnulls(body, locator) = 1
      AND coalesce(body, 'x') <> ''
      AND coalesce(locator, 'x') <> ''
    ),
  -- No-grant-no-promotion, tier-3 half. A grant that denies everyone reads as
  -- "hidden" but behaves as "unreviewed" — refuse it at rest rather than let
  -- it mean two things. NULL and '' elements are refused for the same reason:
  -- they pass a bare cardinality test while granting access to nobody.
  CONSTRAINT chk_brain_episodes_grant_nonempty
    CHECK (cardinality(array_remove(array_remove(visible_to, NULL::text), '')) > 0)
);

-- The dedupe key. UNIQUE is what makes re-ingest a no-op rather than a
-- duplicate; scoped per workspace + source because two connectors (or two
-- tenants) can legitimately mint the same opaque source id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_brain_episodes_source_id
  ON brain_episodes (workspace_id, source, source_id);

-- Referent for the composite FK from brain_facts / brain_edges. `id` is
-- already the PK, so this adds no new uniqueness — it exists purely to give
-- `(workspace_id, id)` a unique index to point at, which is what lets the FK
-- prove an episode and the rows referencing it share a workspace.
CREATE UNIQUE INDEX IF NOT EXISTS uq_brain_episodes_workspace_id
  ON brain_episodes (workspace_id, id);

-- The extraction fiber's backlog. The delivered drain (#4771) is
-- oldest-unextracted-first ACROSS workspaces, so it uses this index for the
-- `extracted_at IS NULL` PREDICATE and sorts for its ordering; the leading
-- `workspace_id` serves a per-workspace backlog read instead.
-- PARTIAL so the index holds only the backlog — once an episode is extracted
-- it leaves the index, which keeps the queue scan proportional to work
-- remaining rather than to history.
CREATE INDEX IF NOT EXISTS idx_brain_episodes_extraction_queue
  ON brain_episodes (workspace_id, ingested_at)
  WHERE extracted_at IS NULL;

-- Per-tenant source browsing / connector backfill inspection.
CREATE INDEX IF NOT EXISTS idx_brain_episodes_source
  ON brain_episodes (workspace_id, source, occurred_at);

-- Grant containment for the fail-closed visibility predicate (#4768), which
-- pushes down as `visible_to && ARRAY[...principals]`. GIN is the index that
-- makes array-overlap a lookup instead of a seq scan.
CREATE INDEX IF NOT EXISTS idx_brain_episodes_visible_to
  ON brain_episodes USING gin (visible_to);

-- ---------------------------------------------------------------------------
-- brain_facts — tier-2. Subject-predicate-object claims, bi-temporal,
-- review-gated, invalidate-never-delete.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,

  -- SPO shape. Plain text at this stage: entity resolution is the reconcile
  -- stage's job (#4771), and a failed subject/object resolution FLAGS the
  -- candidate provisional rather than blocking it (a quality problem the
  -- reviewer clears), so these columns must be able to hold an unresolved
  -- surface form.
  subject text NOT NULL,
  predicate text NOT NULL,
  object text NOT NULL,

  -- Bi-temporal, four columns, invalidate-never-delete:
  --   valid_from/valid_to — VALID time: when the claim was true in the world.
  --     `valid_to` is stamped by a HUMAN promotion at the review gate. There
  --     is no autonomous supersession; staleness decay only SURFACES a fact
  --     for review, it never demotes one on its own.
  --   ingested_at        — TRANSACTION time: when Atlas learned the claim.
  --   invalidated_at     — the tombstone. Supersession is NOT deletion: a
  --     superseded fact stays readable so "what we believed on Monday" still
  --     answers correctly. Retraction (the only tombstone verb, and the
  --     GDPR-erasure path) stamps this; nothing ever DELETEs a fact row.
  valid_from timestamptz,
  valid_to timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,

  -- When the extraction pass that produced this candidate ran. Distinct from
  -- the episode's own `extracted_at` queue marker: this one dates the CLAIM,
  -- and lets a re-extraction (better model, revised prompt) be told apart from
  -- the original pass over the same episode. NULL for human-authored facts,
  -- which are not extracted from anything.
  extracted_at timestamptz,

  -- The episode this fact derives from. NOT NULL by construction — this is
  -- "no-provenance-no-promotion" made structural. Every entry point onto the
  -- reconcile stage has an episode: connector records have theirs, warehouse-
  -- derived facts pin an SQL + snapshot episode, human corrections ARE a
  -- first-class authored episode, and a write-back proposal lazily
  -- materializes a session episode at propose time. A fact with no episode is
  -- a claim with no evidence, and there is no such thing here.
  -- COMPOSITE FK with workspace_id (see the header): the episode must be in
  -- the SAME workspace as the fact, so a cross-tenant claim is unrepresentable
  -- rather than merely unlikely. RESTRICT, not CASCADE: deleting the evidence
  -- under a live fact must fail loudly. Episodes are append-only anyway, so
  -- this should never fire in normal operation.
  source_episode_id uuid NOT NULL,

  -- Provenance payload — the actor, the source pointer, and for warehouse-
  -- derived facts the pinned SQL + data snapshot (pinned, NOT a live view: a
  -- provenance claim that re-runs is not a record of what was seen).
  -- Immutable/append-only by convention; forks are recorded as `derives-from`
  -- edges rather than by rewriting this.
  provenance jsonb NOT NULL,

  -- Content-mode lifecycle. DEFAULTS to `draft`: an extraction candidate
  -- lands there and is promoted only by the atomic publish endpoint. The
  -- review gate IS the brain's conflict-resolution mechanism (ADR-0036
  -- §Temporal) — this column is where "trust over breadth" stops being a
  -- slogan. Registered with the content-mode registry in #4769.
  --
  -- A default, NOT an enforcement, and deliberately so: human corrections are
  -- the second human-authoritative entry point and land authoritative
  -- immediately (ADR-0036 §Temporal), and a region import preserves the source
  -- workspace's review status verbatim rather than demoting reviewed facts
  -- back to draft.
  status text NOT NULL DEFAULT 'draft',

  -- The ACL grant: a SELF-CONTAINED principal set, derived at ingest and
  -- evaluated read-time-local. Grammar (#4768 owns the parser):
  --   org | role:{owner,admin,member} | user:<id> | audience:<source-derived>
  -- Per-version IMMUTABLE: a read of "what we believed Monday" evaluates
  -- Monday's grant against as-of-now membership. That is why the grant is a
  -- column on the fact rather than a join to a policy table — a policy table
  -- would retroactively rewrite who could see history.
  visible_to text[] NOT NULL,

  -- Predicate cardinality — the supersede-vs-coexist switch M2 needs, landing
  -- now so M2 adds an engine and not a column. `single` (a person has one
  -- manager) means a new value SUPERSEDES; `multi` (a person knows many
  -- languages) means values COEXIST and corroborate. Defaults to the
  -- conservative arm: coexisting is recoverable, wrongly superseding destroys
  -- a belief.
  predicate_cardinality text NOT NULL DEFAULT 'multi',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_brain_facts_status
    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT chk_brain_facts_predicate_cardinality
    CHECK (predicate_cardinality IN ('single', 'multi')),
  -- No-grant-no-promotion, tier-2 half. The public majority carries an
  -- explicit `org` — "visible to everyone" is a stated grant, never an
  -- omission, so that a forgotten grant can never read as "public". NULL and
  -- '' elements are refused too: they pass a bare cardinality test while
  -- granting access to nobody.
  CONSTRAINT chk_brain_facts_grant_nonempty
    CHECK (cardinality(array_remove(array_remove(visible_to, NULL::text), '')) > 0),
  -- No-provenance-no-promotion. NOT NULL alone would admit `'{}'::jsonb`,
  -- which is an empty claim wearing the shape of a real one.
  CONSTRAINT chk_brain_facts_provenance_nonempty
    CHECK (jsonb_typeof(provenance) = 'object' AND provenance <> '{}'::jsonb),
  -- A closed validity interval must not run backwards.
  CONSTRAINT chk_brain_facts_valid_interval
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),

  CONSTRAINT fk_brain_facts_episode
    FOREIGN KEY (workspace_id, source_episode_id)
    REFERENCES brain_episodes (workspace_id, id) ON DELETE RESTRICT
);

-- Referent for brain_edges' composite endpoint FKs — see the note on
-- uq_brain_episodes_workspace_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_brain_facts_workspace_id
  ON brain_facts (workspace_id, id);

-- Content-mode status filter (published-only read + admin/dev-mode overlay),
-- mirroring idx_knowledge_documents_status.
CREATE INDEX IF NOT EXISTS idx_brain_facts_status
  ON brain_facts (workspace_id, status);

-- The retrieval read (#4773): look up live claims about a subject. PARTIAL on
-- the live set — the overwhelming majority of reads want current belief, and
-- excluding tombstones keeps the index from growing with retracted history.
CREATE INDEX IF NOT EXISTS idx_brain_facts_subject
  ON brain_facts (workspace_id, subject, predicate)
  WHERE invalidated_at IS NULL;

-- M2's as-of reads and the staleness sweep walk validity, not insertion order.
CREATE INDEX IF NOT EXISTS idx_brain_facts_valid_from
  ON brain_facts (workspace_id, valid_from);

-- Walk every fact extracted from one episode — the reviewer's "what did this
-- message produce?" view, and the re-extraction path.
CREATE INDEX IF NOT EXISTS idx_brain_facts_source_episode
  ON brain_facts (source_episode_id);

-- Grant containment for the push-down visibility predicate (#4768).
CREATE INDEX IF NOT EXISTS idx_brain_facts_visible_to
  ON brain_facts USING gin (visible_to);

-- ---------------------------------------------------------------------------
-- brain_edges — the typed graph. Enum pinned to ADR-0036's committed set.
-- ---------------------------------------------------------------------------
--
-- Endpoints are fact-or-episode on BOTH sides, expressed as two nullable FK
-- columns per endpoint with an exactly-one CHECK, rather than a polymorphic
-- (kind, id) pair. The polymorphic shape is shorter but throws away
-- referential integrity — and an edge whose endpoint has silently vanished is
-- precisely the corruption a provenance graph must not tolerate.
--
-- Endpoint KINDS are constrained per type, not merely documented — M2's
-- arbitration walker and #4773's retrieval both assume these shapes, and an
-- episode→episode `provenance` edge would satisfy a bare exactly-one-per-side
-- rule while being meaningless:
--
--   supersedes      fact  → fact          the M2 arbitration outcome
--   in-tension-with fact  → fact          genuine coexisting conflict;
--                                         SURFACED with both provenances,
--                                         never ranked
--   derives-from    fact  → fact|episode  fork lineage
--   provenance      fact  → episode       the evidence pointer
--
-- Every type originates at a fact, so `from_episode_id` is currently always
-- NULL. The column exists anyway: it keeps the two sides symmetric for a
-- future episode-rooted type, and the CHECK is what stops one appearing by
-- accident in the meantime.
--
-- Endpoint FKs CASCADE, deliberately asymmetric with the RESTRICT on
-- brain_facts.source_episode_id. The asymmetry tracks what each reference
-- MEANS: a fact's episode is its evidence, and evidence must not be
-- deletable out from under a live claim (RESTRICT). An edge is a derived
-- assertion ABOUT facts and episodes with no independent evidentiary value —
-- once an endpoint is gone the edge is dangling structure, so it should
-- vanish with it (CASCADE) rather than block the delete.
--
-- That asymmetry also keeps the #4458 source-cleanup sweep sound. The sweep's
-- column phase assumes CASCADE between in-scope tables; `brain_facts` is the
-- one exception and is handled by PHASE instead (it carries a `parent` rule
-- in cleanup.ts so its delete is ordered ahead of brain_episodes). A RESTRICT
-- here would need the same treatment and doesn't have it.
CREATE TABLE IF NOT EXISTS brain_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  edge_type text NOT NULL,

  from_fact_id uuid,
  from_episode_id uuid,
  to_fact_id uuid,
  to_episode_id uuid,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- The four committed types. M2 extends the ENGINE, not this list.
  CONSTRAINT chk_brain_edges_type
    CHECK (edge_type IN ('supersedes', 'in-tension-with', 'derives-from', 'provenance')),
  CONSTRAINT chk_brain_edges_from_endpoint
    CHECK (num_nonnulls(from_fact_id, from_episode_id) = 1),
  CONSTRAINT chk_brain_edges_to_endpoint
    CHECK (num_nonnulls(to_fact_id, to_episode_id) = 1),
  -- The per-type endpoint kinds from the table above.
  CONSTRAINT chk_brain_edges_endpoint_kinds CHECK (
    from_fact_id IS NOT NULL
    AND CASE edge_type
          WHEN 'provenance' THEN to_episode_id IS NOT NULL
          WHEN 'derives-from' THEN TRUE
          ELSE to_fact_id IS NOT NULL
        END
  ),

  -- Composite endpoint FKs — an edge can only join rows in its OWN workspace.
  -- Postgres's default MATCH SIMPLE skips the check when any referencing
  -- column is NULL, which is exactly right for the nullable-endpoint design:
  -- the unused side of each pair is simply not constrained.
  CONSTRAINT fk_brain_edges_from_fact
    FOREIGN KEY (workspace_id, from_fact_id)
    REFERENCES brain_facts (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_brain_edges_from_episode
    FOREIGN KEY (workspace_id, from_episode_id)
    REFERENCES brain_episodes (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_brain_edges_to_fact
    FOREIGN KEY (workspace_id, to_fact_id)
    REFERENCES brain_facts (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_brain_edges_to_episode
    FOREIGN KEY (workspace_id, to_episode_id)
    REFERENCES brain_episodes (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_brain_edges_from_fact
  ON brain_edges (from_fact_id, edge_type)
  WHERE from_fact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brain_edges_to_fact
  ON brain_edges (to_fact_id, edge_type)
  WHERE to_fact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brain_edges_to_episode
  ON brain_edges (to_episode_id, edge_type)
  WHERE to_episode_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brain_edges_workspace_type
  ON brain_edges (workspace_id, edge_type);

-- ---------------------------------------------------------------------------
-- fact_audience_member — Atlas-owned audience membership.
-- ---------------------------------------------------------------------------
--
-- Backs the `audience:<name>` arm of the grant grammar. ADR-0036 accepted a
-- real cost in choosing derive-at-ingest grants: source membership changes do
-- NOT propagate to already-ingested facts. This table is the escape hatch —
-- a sensitive fact grants to an `audience:`, membership is synced here, and
-- revocation therefore flows through LIVE without re-ingesting anything.
--
-- Deliberately NOT Better Auth teams: Atlas has none, and "group" in this
-- codebase means a connection-group (a set of datasources), not a set of
-- people. Consumed by #4768's visibility predicate; populated by #4801's
-- membership sync (`lib/brain/audience/`), which reconciles rather than
-- inserts: the DELETE is what makes revocation flow through live, and it is
-- licensed by a completeness check on the source roster (an incomplete vendor
-- read would otherwise revoke the members it failed to fetch).
--
-- `user_id` is a Better Auth user id resolved from the source principal by
-- email, narrowed to the workspace's DNS-verified SSO domain where it has one.
-- A source principal that resolves to no Atlas user is logged and gets no row —
-- never guessed. See `lib/brain/audience/resolver.ts` for why the join is
-- workspace-scoped in SQL rather than by caller discipline.
CREATE TABLE IF NOT EXISTS fact_audience_member (
  workspace_id text NOT NULL,
  -- The source-derived audience identifier, WITHOUT the `audience:` prefix
  -- (the prefix belongs to the grant grammar, not to the identity).
  audience_id text NOT NULL,
  -- Better-Auth user id.
  user_id text NOT NULL,
  -- Which connector derived this membership. An audience belongs to exactly
  -- one source by construction, so this is not part of the key — it is here so
  -- a re-sync can scope its reconciliation and so an operator can answer "why
  -- can this person see that?" without guessing.
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, audience_id, user_id)
);

-- "Which audiences is this user in?" — the per-request principal expansion the
-- visibility predicate performs before it can push anything down.
CREATE INDEX IF NOT EXISTS idx_fact_audience_member_user
  ON fact_audience_member (workspace_id, user_id);
