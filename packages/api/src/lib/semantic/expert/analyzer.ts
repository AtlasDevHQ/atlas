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

  // Deduplicate by group + entity + amendmentType + amendment.name. The group
  // is part of the key (#3284) so the same entity name in two Connection groups
  // (`groups/eu/entities/orders.yml` + `groups/us/entities/orders.yml`) doesn't
  // collapse to one proposal — each group's amendment must survive to be applied
  // against its own row. `??""` keys the default/legacy group consistently.
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    const key = `${r.group ?? ""}:${r.entityName}:${r.amendmentType}:${String(((r.amendment as Record<string, unknown>).name ?? "") as string)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by score descending
  return deduped.toSorted((a, b) => b.score - a.score);
}
