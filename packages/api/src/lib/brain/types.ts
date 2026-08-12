/**
 * Company brain substrate — the shared vocabulary (#4767, ADR-0036).
 *
 * Types only. The behaviour that uses them lands in the sibling M1 slices:
 * the grant parser + fail-closed visibility predicate (#4768), the
 * content-mode registration (#4769), the connector (#4770), the extraction
 * fiber + reconcile stage (#4771), the review surface (#4772), and
 * `searchBrain` (#4773). Mirrors migration 0180.
 *
 * This module is deliberately dependency-free so every one of those slices can
 * import the vocabulary without dragging in a database handle.
 */

/**
 * The three trust tiers, in the vocabulary reserved by the ADR-0036 re-aim
 * guide. The ordering is the arbitration order: a lower tier wins any overlap.
 *
 * Tier 1 has NO representation in the brain tables — warehouse facts resolve
 * live through the semantic layer and are gated by warehouse RLS, which is
 * precisely why they are authoritative by construction and why the ACL
 * primitive deliberately does not double-gate them. The tier exists in this
 * enum so that retrieval can LABEL a result's provenance tier to the caller;
 * trust labelling is the wedge, and a tier that can't be named can't be shown.
 */
export const TRUST_TIERS = {
  /** Warehouse facts — authoritative by construction. Never stored here. */
  warehouse: 1,
  /** Reviewed facts — authoritative for their class; yield to the warehouse. */
  fact: 2,
  /** Raw episodes — source-of-truth for what was said, not for what is true. */
  episode: 3,
} as const;

export type TrustTier = (typeof TRUST_TIERS)[keyof typeof TRUST_TIERS];

/**
 * The four committed edge types (ADR-0036 §Temporal). M2 extends the engine
 * that walks these, never this list — the enum is pinned here and by
 * `chk_brain_edges_type` in migration 0180, and `types.test.ts` fails if the
 * two ever drift.
 */
export const BRAIN_EDGE_TYPES = [
  /** fact → fact. The M2 arbitration outcome; supersession is not deletion. */
  "supersedes",
  /**
   * fact → fact. Genuine coexisting conflict. Surfaced with BOTH provenances
   * and never ranked — refusing to auto-arbitrate is the point, not a gap.
   */
  "in-tension-with",
  /** fact → fact | episode. Fork lineage. */
  "derives-from",
  /** fact → episode. The evidence pointer. */
  "provenance",
] as const;

export type BrainEdgeType = (typeof BRAIN_EDGE_TYPES)[number];

/**
 * Content-mode lifecycle for a fact. Every candidate lands `draft`; only the
 * atomic publish endpoint promotes it, because the review gate IS the brain's
 * conflict-resolution mechanism.
 */
export const BRAIN_FACT_STATUSES = ["draft", "published", "archived"] as const;
export type BrainFactStatus = (typeof BRAIN_FACT_STATUSES)[number];

/**
 * The supersede-vs-coexist switch. `single` (a person has one manager) means a
 * new value supersedes the old; `multi` (a person knows many languages) means
 * values coexist and corroborate.
 *
 * `multi` is the default in the schema on purpose: coexisting wrongly is
 * recoverable at the review gate, superseding wrongly destroys a belief.
 */
export const PREDICATE_CARDINALITIES = ["single", "multi"] as const;
export type PredicateCardinality = (typeof PREDICATE_CARDINALITIES)[number];

/**
 * A grant is a self-contained principal set, derived at ingest and evaluated
 * read-time-local. Grammar:
 *
 *   `org` | `role:{owner,admin,member}` | `user:<id>` | `audience:<name>`
 *
 * The parser and the fail-closed push-down predicate are #4768's; this type is
 * the wire shape they agree on. A grant is never empty — `cardinality > 0` is
 * a CHECK on both brain tables, so "visible to everyone" is always the
 * explicit `org` principal and never a forgotten field.
 */
export type BrainGrant = readonly string[];

/** tier-3. Immutable, append-only, deduped by `(workspaceId, source, sourceId)`. */
export interface BrainEpisode {
  readonly id: string;
  readonly workspaceId: string;
  /** Connector class/vendor — `slack`, `warehouse`, `human`. */
  readonly source: string;
  /** The source's own stable id. Must be stable across webhook AND poll. */
  readonly sourceId: string;
  /** Source-side author principal; NULL when the source has no author. */
  readonly sourceActor: string | null;
  /** Body XOR locator — by-value for chat, by-reference for warehouse/KB. */
  readonly body: string | null;
  readonly locator: string | null;
  /** Event time at the source. */
  readonly occurredAt: Date | null;
  /** Transaction time — when Atlas learned of it. */
  readonly ingestedAt: Date;
  /** Extraction work-queue marker; `null` means still queued. */
  readonly extractedAt: Date | null;
  readonly visibleTo: BrainGrant;
  readonly createdAt: Date;
}

/** tier-2. Bi-temporal, review-gated, invalidate-never-delete. */
export interface BrainFact {
  readonly id: string;
  readonly workspaceId: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /** Valid time — when the claim held in the world. */
  readonly validFrom: Date | null;
  /** Stamped by a HUMAN promotion. There is no autonomous supersession. */
  readonly validTo: Date | null;
  /** Transaction time. */
  readonly ingestedAt: Date;
  /** The tombstone. Nothing ever DELETEs a fact row. */
  readonly invalidatedAt: Date | null;
  /** When the extraction pass that produced this claim ran; null if authored. */
  readonly extractedAt: Date | null;
  /** Never null — no-provenance-no-promotion, enforced at rest. */
  readonly sourceEpisodeId: string;
  readonly provenance: Record<string, unknown>;
  readonly status: BrainFactStatus;
  /** Never empty — no-grant-no-promotion, enforced at rest. */
  readonly visibleTo: BrainGrant;
  /**
   * ⚠️ VESTIGIAL — do not branch on it, and do not treat it as live contract.
   *
   * One of FIVE declaration sites of a field #5027 made meaningless:
   * cardinality is a property of the CANONICAL PREDICATE, curated in
   * `brain_predicate_cardinality` and read at the publish gate. Three
   * consumer-facing copies — `BrainFactCandidate`, `BrainFactResult`, and the
   * Zod schema — were annotated by #5027 and DELETED by #5028 phase 1b. A
   * fourth survives DELIBERATELY: `ExportedBrainFact` in `@useatlas/types`
   * keeps it optional so a v1/v2 bundle stays representable (#5035, ADR-0037
   * §8), and `bundle-identity-v3.test.ts` pins it there. THIS one was missed by
   * #5027 and by phase 1b both, and a required field with no annotation reads
   * as live contract — which is exactly how a re-read gets written. Nothing in
   * the tree constructs `BrainFact` at all, so no compiler checks it into truth.
   *
   * Kept rather than deleted only because this interface models the ROW, and
   * the row still has the column until the phase-2 migration. It goes with it.
   */
  readonly predicateCardinality: PredicateCardinality;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Which side of a subject-predicate-object claim an entity sits on. Spelled
 * once so the resolver seam, the provisional flag, and the stored provenance
 * cannot drift into three stringly-typed spellings of the same two words.
 */
export type EntityRole = "subject" | "object";

/**
 * The shape written into `brain_facts.provenance` (#4771).
 *
 * The column is `jsonb`, so nothing at rest enforces this — which is exactly
 * why it is named. There is one writer (the reconcile stage) and at least three
 * readers already scheduled (#4772's review surface, which must filter on
 * `provisional`; #4773's `searchBrain`; and the promotion classifier, which
 * reads the column as `unknown`). Without a named shape, renaming a key is a
 * silently blank field in a UI rather than a compile error.
 *
 * `provisional` / `unresolved` are OPTIONAL and written only when true, so a
 * reviewer's filter on the key is not defeated by every fact carrying
 * `provisional: false`. Producer-specific extras (a model id, a confidence, a
 * warehouse fact's pinned SQL) are the index signature; they are merged UNDER
 * the structural keys, so a producer can enrich the payload but never restate
 * where the claim came from.
 */
export interface BrainFactProvenance {
  /** Connector class of the evidence — mirrors `brain_episodes.source`. */
  readonly source: string;
  readonly sourceId: string;
  readonly episodeId: string;
  /** The principal that asserted the claim. Never null past the block gate. */
  readonly actor: string | null;
  /** What produced the candidate — `extraction:v1`, `write-back`, `human`. */
  readonly producer: string;
  /** ISO-8601, or null when the source exposed no event time. */
  readonly occurredAt: string | null;
  /** ISO-8601 of the extraction pass; null for an authored claim. */
  readonly extractedAt: string | null;
  readonly reconciledAt: string;
  /**
   * Written ONLY when the entity store failed to answer the episode's batch —
   * never for an honest "no entry" (#5031). It means exactly *this row's
   * `object_cmp` is worth recomputing*, and NOT that its keys are: no resolver
   * reaches a slot key, so a replay recomputes those to the same bytes under the
   * same vocabulary. An
   * abstain will not change on replay and its rows are findable by key, while an
   * outage will change and its rows are findable by nothing else
   * (`object_cmp IS NULL` matches every honest abstain too).
   *
   * ⚠️ Not total: a candidate that CORROBORATES writes no provenance PAYLOAD, so
   * it carries no flag of its own. It is not traceless — its `provenance` edge
   * to the episode is written, and that edge is how those facts are found.
   */
  readonly provisional?: true;
  /**
   * Both roles whenever {@link provisional} is set, and absent otherwise. One
   * batch covers both positions, so a failure has no per-role granularity — the
   * array survives because `lib/brain/candidates.ts` reads it — the projection,
   * and `PROVISIONAL_PREDICATE`'s `jsonb_array_length(… -> 'unresolved') > 0`
   * arm — not because the two sides can fail apart. #4772's review surface stopped reading
   * it when #5031 deleted the which-side copy it fed.
   *
   * There are no legacy one-sided rows to handle. Before #5031 the positions
   * were resolved by separate calls and COULD fail apart — but the only
   * resolver ever shipped was the passthrough, which returned a canonical form
   * for every non-blank surface and so never produced this flag at all.
   */
  readonly unresolved?: readonly EntityRole[];
  readonly [key: string]: unknown;
}

/**
 * A typed edge. Each endpoint is a fact OR an episode — exactly one of the two
 * id columns is set, enforced by `chk_brain_edges_{from,to}_endpoint`.
 */
export interface BrainEdge {
  readonly id: string;
  readonly workspaceId: string;
  readonly edgeType: BrainEdgeType;
  readonly fromFactId: string | null;
  readonly fromEpisodeId: string | null;
  readonly toFactId: string | null;
  readonly toEpisodeId: string | null;
  readonly createdAt: Date;
}

/**
 * Atlas-owned audience membership — the live-revocation escape hatch for
 * derive-at-ingest grants.
 */
export interface FactAudienceMember {
  readonly workspaceId: string;
  /** WITHOUT the `audience:` prefix — the prefix belongs to the grammar. */
  readonly audienceId: string;
  readonly userId: string;
  readonly source: string;
  readonly createdAt: Date;
}
