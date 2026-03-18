/** Learned query pattern types — wire format for the learned_patterns table. */

/** All valid learned pattern statuses. */
export const LEARNED_PATTERN_STATUSES = ["pending", "approved", "rejected"] as const;
/** Status lifecycle for learned query patterns. */
export type LearnedPatternStatus = (typeof LEARNED_PATTERN_STATUSES)[number];

/** All valid learned pattern sources. */
export const LEARNED_PATTERN_SOURCES = ["agent", "atlas-learn"] as const;
/** Who proposed the pattern. */
export type LearnedPatternSource = (typeof LEARNED_PATTERN_SOURCES)[number];

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
}
