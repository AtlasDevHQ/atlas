/** Learned query pattern types — wire format for the learned_patterns table. */

/** Status lifecycle for learned query patterns. */
export type LearnedPatternStatus = "pending" | "approved" | "rejected";

/** Who proposed the pattern. */
export type LearnedPatternSource = "agent" | "atlas-learn";

/** Wire format for the learned_patterns table. */
export interface LearnedPattern {
  id: string;
  orgId: string | null;
  patternSql: string;
  description: string | null;
  sourceEntity: string | null;
  sourceQueries: string[] | null;
  confidence: number;
  repetitionCount: number;
  status: LearnedPatternStatus;
  proposedBy: LearnedPatternSource | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}
