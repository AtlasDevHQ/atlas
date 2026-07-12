/** Learned query pattern types — wire format for the learned_patterns table. */

/**
 * All valid learned pattern statuses **on the wire**.
 *
 * Deliberately a subset of the DB `chk_learned_patterns_status` CHECK (migration
 * 0172), which also admits `applying` — the transient amendment-claim state the
 * decide seam writes (pending → applying → approved|pending, #4506) and filters
 * out before anything reaches the wire. Do NOT add `applying` here to "sync"
 * with the CHECK, and do NOT drop it from the CHECK to "sync" with this: the
 * claim UPDATE depends on the DB value existing, the review queue depends on the
 * wire enum never surfacing it.
 */
export const LEARNED_PATTERN_STATUSES = ["pending", "approved", "rejected"] as const;
/** Status lifecycle for learned query patterns. */
export type LearnedPatternStatus = (typeof LEARNED_PATTERN_STATUSES)[number];

/** All valid learned pattern sources. */
export const LEARNED_PATTERN_SOURCES = ["agent", "atlas-learn", "expert-agent"] as const;
/** Who proposed the pattern. */
export type LearnedPatternSource = (typeof LEARNED_PATTERN_SOURCES)[number];

/** All valid learned pattern types. */
export const LEARNED_PATTERN_TYPES = ["query_pattern", "semantic_amendment"] as const;
/** Discriminant for learned pattern row type. */
export type LearnedPatternType = (typeof LEARNED_PATTERN_TYPES)[number];

/** All valid amendment types for semantic_amendment proposals. */
export const AMENDMENT_TYPES = [
  "add_dimension",
  "add_measure",
  "add_join",
  "add_query_pattern",
  "update_description",
  "update_dimension",
  "add_glossary_term",
  "update_glossary_term",
  "add_virtual_dimension",
] as const;
/** Kind of semantic layer change proposed by the expert agent. */
export type AmendmentType = (typeof AMENDMENT_TYPES)[number];

/** Structured payload for semantic_amendment proposals. */
export interface AmendmentPayload {
  entityName: string;
  amendmentType: AmendmentType;
  /** Type-specific amendment data (dimension object, measure object, etc.). */
  amendment: Record<string, unknown>;
  rationale: string;
  /** Unified YAML diff string. */
  diff: string;
  /** Optional SQL to validate the amendment. */
  testQuery?: string;
  /** Result of running the test query. */
  testResult?: {
    success: boolean;
    rowCount: number;
    sampleRows: Record<string, unknown>[];
    /** Present when `success` is false — describes why the test query failed. */
    error?: string;
    /**
     * #4614 — the test query was NOT run: the amendment targets a draft-only
     * entity, which is absent from the query whitelist (published-only), so the
     * query would fail "not in the allowed list". It's deferred until the entity
     * is published. `success` is `false` but this is not a failure — the card
     * renders a neutral "deferred until publish" note, not a red error.
     */
    deferred?: boolean;
  };
  /** Agent's confidence this amendment is correct (0.0–1.0). */
  confidence: number;
}

/** Wire format for the learned_patterns table. */
export interface LearnedPattern {
  id: string;
  orgId: string | null;
  /**
   * Connection group the pattern was learned against (`connection_group_id`),
   * or null for the default (flat `entities/`) scope. Surfaced so an admin in a
   * multi-group workspace can tell two near-identical twins apart before
   * approving one (#4578) — the injection reader already scopes by this column
   * (`getApprovedPatterns`), so an approval must be attributable to a group.
   */
  connectionGroupId: string | null;
  patternSql: string;
  description: string | null;
  sourceEntity: string | null;
  sourceQueries: string[] | null;
  /** Score between 0.0 (no confidence) and 1.0 (full confidence). */
  confidence: number;
  repetitionCount: number;
  status: LearnedPatternStatus;
  proposedBy: LearnedPatternSource | null;
  reviewedBy: string | null;
  /**
   * Reviewer resolved to a human-readable name or email (server-side JOIN on
   * the `user` table), or null when unreviewed or the reviewer no longer
   * exists. The UI renders this — never the raw `reviewedBy` UUID (#4578).
   */
  reviewedByLabel: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  /** Discriminant: 'query_pattern' (default) or 'semantic_amendment'. */
  type: LearnedPatternType;
  /** Structured amendment payload (only for type='semantic_amendment'). */
  amendmentPayload: AmendmentPayload | null;
  /**
   * True when the nightly auto-promote/decay job promoted this row from
   * pending → approved without human review (PRD #3617 B-2). Lets the admin UI
   * mark machine-approved patterns distinct from human-approved ones.
   */
  autoPromoted: boolean;
  /**
   * Rolling-mean wall-clock execution time (ms) of the pattern's runs, or null
   * until first observed (PRD #3617 B-0/B-2). Drives perf-weighted retrieval
   * down-weighting and is surfaced to the agent in injected context.
   */
  avgDurationMs: number | null;
}
