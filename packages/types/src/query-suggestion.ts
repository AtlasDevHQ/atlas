/** Query suggestion types — wire format for the query_suggestions table. */

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
  score: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}
