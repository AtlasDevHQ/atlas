/** Query suggestion types — wire format for the query_suggestions table. */

/**
 * Moderation lifecycle for a learned query suggestion.
 *
 * Orthogonal to {@link SuggestionStatus}: an approved entry may still be a
 * draft awaiting publish. The two axes are independent.
 */
export type SuggestionApprovalStatus = "pending" | "approved" | "hidden";

/** Mode-system lifecycle shared with connections, entities, and prompt collections. */
export type SuggestionStatus = "draft" | "published" | "archived";

export interface QuerySuggestion {
  id: string;
  orgId: string | null;
  description: string;
  patternSql: string;
  normalizedHash: string;
  tablesInvolved: string[];
  primaryTable: string | null;
  frequency: number;
  clickedCount: number;
  distinctUserClicks: number;
  score: number;
  approvalStatus: SuggestionApprovalStatus;
  status: SuggestionStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}
