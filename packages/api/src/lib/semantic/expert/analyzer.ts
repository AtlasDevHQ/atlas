/**
 * Semantic layer analyzer — orchestrates all 9 category analyzers.
 *
 * Runs each category, deduplicates results, and sorts by composite score.
 */

import type { AnalysisContext, AnalysisResult } from "./types";
import {
  findCoverageGaps,
  findDescriptionIssues,
  findTypeInaccuracies,
  findMissingMeasures,
  findMissingJoins,
  findGlossaryGaps,
  findStaleSampleValues,
  findQueryPatternGaps,
  findVirtualDimensionOpportunities,
} from "./categories";

/**
 * Analyze the semantic layer and return ranked improvement proposals.
 *
 * Runs all 9 analysis categories and returns results sorted by composite
 * score (impact × confidence × (1 - staleness)), highest first.
 */
export function analyzeSemanticLayer(
  context: AnalysisContext,
): AnalysisResult[] {
  const allResults: AnalysisResult[] = [
    ...findCoverageGaps(context),
    ...findDescriptionIssues(context),
    ...findTypeInaccuracies(context),
    ...findMissingMeasures(context),
    ...findMissingJoins(context),
    ...findGlossaryGaps(context),
    ...findStaleSampleValues(context),
    ...findQueryPatternGaps(context),
    ...findVirtualDimensionOpportunities(context),
  ];

  // Deduplicate by entity + amendmentType + amendment.name
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    const key = `${r.entityName}:${r.amendmentType}:${String((r.amendment as Record<string, unknown>).name ?? "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by score descending
  return deduped.toSorted((a, b) => b.score - a.score);
}
