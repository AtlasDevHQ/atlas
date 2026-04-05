/**
 * Scoring functions for the semantic expert analysis engine.
 *
 * score = impact × confidence × (1 - staleness)
 */

import type { AnalysisResult } from "./types";

/**
 * Factory for creating AnalysisResult with auto-computed score.
 * Prevents inconsistency between score and its component factors.
 */
export function createAnalysisResult(
  fields: Omit<AnalysisResult, "score">,
): AnalysisResult {
  return {
    ...fields,
    score: computeScore(fields.impact, fields.confidence, fields.staleness),
  };
}

/** Compute the composite score for a finding. */
export function computeScore(
  impact: number,
  confidence: number,
  staleness: number,
): number {
  return Math.round(impact * confidence * (1 - staleness) * 1000) / 1000;
}

/** Score impact based on table query frequency from audit log. */
export function tableFrequencyImpact(
  tableName: string,
  auditPatterns: Array<{ tables: string[]; count: number }>,
): number {
  let totalQueries = 0;
  let tableQueries = 0;

  for (const pattern of auditPatterns) {
    totalQueries += pattern.count;
    if (pattern.tables.includes(tableName)) {
      tableQueries += pattern.count;
    }
  }

  if (totalQueries === 0) return 0.5; // No audit data — default medium impact
  return Math.min(1, tableQueries / totalQueries * 5); // Scale so 20% of queries = 1.0
}

/** Score impact based on how undocumented a table is. */
export function coverageImpact(
  totalColumns: number,
  documentedColumns: number,
): number {
  if (totalColumns === 0) return 0;
  const coverageRate = documentedColumns / totalColumns;
  return 1 - coverageRate; // Low coverage = high impact
}
