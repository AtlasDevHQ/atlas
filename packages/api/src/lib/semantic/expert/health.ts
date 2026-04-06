/**
 * Semantic layer health score computation.
 *
 * Pure functions that derive health sub-scores from an AnalysisContext.
 * No I/O — all data must be pre-loaded into the context before calling.
 */

import type { AnalysisContext, ParsedEntity } from "./types";
import {
  findCoverageGaps,
  findDescriptionIssues,
  findMissingMeasures,
  findMissingJoins,
} from "./categories";

// ── Types ────────────────────────────────────────────────────────

export interface SemanticHealthScore {
  /** Overall health 0–100 (weighted average of sub-scores). */
  readonly overall: number;
  /** Fraction of profiled columns represented as dimensions (0–100). */
  readonly coverage: number;
  /** Fraction of dimensions with meaningful descriptions (0–100). */
  readonly descriptionQuality: number;
  /** Fraction of entities that have at least one measure (0–100). */
  readonly measureCoverage: number;
  /** Fraction of detected FK relationships captured as joins (0–100). */
  readonly joinCoverage: number;
  /** Total entity count. */
  readonly entityCount: number;
  /** Total dimension count across all entities. */
  readonly dimensionCount: number;
  /** Total measure count across all entities. */
  readonly measureCount: number;
  /** Total glossary term count. */
  readonly glossaryTermCount: number;
}

// ── Weights for overall score ────────────────────────────────────

const WEIGHT_COVERAGE = 0.3;
const WEIGHT_DESCRIPTION = 0.3;
const WEIGHT_MEASURES = 0.2;
const WEIGHT_JOINS = 0.2;

// ── Helpers ──────────────────────────────────────────────────────

function countTotalDimensions(entities: readonly ParsedEntity[]): number {
  return entities.reduce((sum, e) => sum + e.dimensions.length, 0);
}

function countTotalMeasures(entities: readonly ParsedEntity[]): number {
  return entities.reduce((sum, e) => sum + e.measures.length, 0);
}

/**
 * Compute the coverage sub-score.
 *
 * Uses the coverage gap analyzer: fewer gaps = higher score.
 * Score = 1 - (gaps / total profiled columns). If no profiles, returns 100.
 */
function computeCoverage(ctx: AnalysisContext): number {
  if (ctx.profiles.length === 0) return 100;

  const totalProfiledColumns = ctx.profiles.reduce(
    (sum, p) => sum + (p.columns?.length ?? 0),
    0,
  );
  if (totalProfiledColumns === 0) return 100;

  const gaps = findCoverageGaps(ctx).length;
  return Math.round(Math.max(0, (1 - gaps / totalProfiledColumns)) * 100);
}

/**
 * Compute the description quality sub-score.
 *
 * Uses the description issue analyzer: fewer issues = higher score.
 * Score = 1 - (issues / total dimensions). If no dimensions, returns 100.
 */
function computeDescriptionQuality(ctx: AnalysisContext): number {
  const totalDimensions = countTotalDimensions(ctx.entities);
  if (totalDimensions === 0) return 100;

  const issues = findDescriptionIssues(ctx).length;
  return Math.round(Math.max(0, (1 - issues / totalDimensions)) * 100);
}

/**
 * Compute the measure coverage sub-score.
 *
 * Score = entities with at least one measure / total entities.
 * If no entities, returns 100.
 */
function computeMeasureCoverage(ctx: AnalysisContext): number {
  if (ctx.entities.length === 0) return 100;

  const withMeasures = ctx.entities.filter((e) => e.measures.length > 0).length;
  return Math.round((withMeasures / ctx.entities.length) * 100);
}

/**
 * Compute the join coverage sub-score.
 *
 * Uses the missing joins analyzer: fewer missing = higher score.
 * If no profiles (can't detect FKs), returns 100 (unknown = healthy).
 */
function computeJoinCoverage(ctx: AnalysisContext): number {
  if (ctx.profiles.length === 0) return 100;

  const totalJoins = ctx.entities.reduce((sum, e) => sum + e.joins.length, 0);
  const missingJoins = findMissingJoins(ctx).length;
  const totalDetected = totalJoins + missingJoins;
  if (totalDetected === 0) return 100;

  return Math.round((totalJoins / totalDetected) * 100);
}

// ── Main ─────────────────────────────────────────────────────────

/**
 * Compute a complete semantic layer health score from an analysis context.
 */
export function computeSemanticHealth(ctx: AnalysisContext): SemanticHealthScore {
  const coverage = computeCoverage(ctx);
  const descriptionQuality = computeDescriptionQuality(ctx);
  const measureCoverage = computeMeasureCoverage(ctx);
  const joinCoverage = computeJoinCoverage(ctx);

  const overall = Math.round(
    coverage * WEIGHT_COVERAGE +
    descriptionQuality * WEIGHT_DESCRIPTION +
    measureCoverage * WEIGHT_MEASURES +
    joinCoverage * WEIGHT_JOINS,
  );

  return {
    overall,
    coverage,
    descriptionQuality,
    measureCoverage,
    joinCoverage,
    entityCount: ctx.entities.length,
    dimensionCount: countTotalDimensions(ctx.entities),
    measureCount: countTotalMeasures(ctx.entities),
    glossaryTermCount: ctx.glossary.length,
  };
}
