/**
 * Shared helper for converting QuerySuggestionRow (DB shape) to
 * QuerySuggestion (wire/camelCase shape). Used by both user-facing
 * and admin suggestion routes.
 */

import type { QuerySuggestion } from "@useatlas/types";
import type { QuerySuggestionRow } from "@atlas/api/lib/db/internal";

export function toQuerySuggestion(row: QuerySuggestionRow): QuerySuggestion {
  let tablesInvolved: string[] = [];
  try {
    tablesInvolved = typeof row.tables_involved === "string"
      ? JSON.parse(row.tables_involved)
      : row.tables_involved;
  } catch {
    // intentionally ignored: malformed JSONB
  }
  return {
    id: row.id,
    orgId: row.org_id,
    description: row.description,
    patternSql: row.pattern_sql,
    normalizedHash: row.normalized_hash,
    tablesInvolved,
    primaryTable: row.primary_table,
    frequency: row.frequency,
    clickedCount: row.clicked_count,
    distinctUserClicks: row.distinct_user_clicks ?? 0,
    score: row.score,
    approvalStatus: row.approval_status ?? "pending",
    status: row.status ?? "draft",
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
