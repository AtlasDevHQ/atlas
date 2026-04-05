/** Learned query pattern types — wire format for the learned_patterns table. */

/** All valid learned pattern statuses. */
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
  };
  /** Agent's confidence this amendment is correct (0.0–1.0). */
  confidence: number;
}

/** Wire format for the learned_patterns table. */
export interface LearnedPattern {
  id: string;
  orgId: string | null;
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
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  /** Discriminant: 'query_pattern' (default) or 'semantic_amendment'. */
  type: LearnedPatternType;
  /** Structured amendment payload (only for type='semantic_amendment'). */
  amendmentPayload: AmendmentPayload | null;
}
