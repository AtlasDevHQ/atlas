/**
 * Types for the semantic expert analysis engine.
 */

import type { AmendmentType } from "@useatlas/types";
import type { TableProfile } from "@useatlas/types";

/** All 9 analysis categories examined by the expert agent. */
export const ANALYSIS_CATEGORIES = [
  "coverage_gaps",
  "description_quality",
  "type_accuracy",
  "missing_measures",
  "missing_joins",
  "glossary_gaps",
  "sample_value_staleness",
  "query_pattern_coverage",
  "virtual_dimension_opportunities",
] as const;

export type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number];

/** A parsed entity from a YAML file. */
export interface ParsedEntity {
  name: string;
  table: string;
  description?: string;
  dimensions: Array<{
    name: string;
    sql: string;
    type: string;
    description?: string;
    sample_values?: string[];
    virtual?: boolean;
  }>;
  measures: Array<{
    name: string;
    sql: string;
    type: string;
    description?: string;
  }>;
  joins: Array<{
    name: string;
    sql: string;
    description?: string;
  }>;
  query_patterns: Array<{
    name: string;
    description?: string;
    sql: string;
  }>;
  connection?: string;
}

/** A glossary term. */
export interface GlossaryTerm {
  term: string;
  definition: string;
  ambiguous?: boolean;
}

/** Audit log pattern summary. */
export interface AuditPattern {
  sql: string;
  count: number;
  tables: string[];
  lastSeen: string;
}

/** Context provided to the analysis engine. */
export interface AnalysisContext {
  /** Profiled tables from the database. */
  profiles: TableProfile[];
  /** Parsed semantic layer entities. */
  entities: ParsedEntity[];
  /** Glossary terms. */
  glossary: GlossaryTerm[];
  /** Audit log patterns (empty if no internal DB). */
  auditPatterns: AuditPattern[];
  /** Previously rejected proposal entity+type combos to suppress re-proposal. */
  rejectedKeys: Set<string>;
}

/** A single analysis finding that may become a proposal. */
export interface AnalysisResult {
  category: AnalysisCategory;
  entityName: string;
  amendmentType: AmendmentType;
  amendment: Record<string, unknown>;
  rationale: string;
  /** Optional test query to validate the amendment. */
  testQuery?: string;
  /** Impact score (0–1): how much this improves the semantic layer. */
  impact: number;
  /** Confidence score (0–1): how sure we are this is correct. */
  confidence: number;
  /** Staleness factor (0–1): 1 = recently rejected, 0 = fresh. */
  staleness: number;
  /** Composite score = impact × confidence × (1 - staleness). */
  score: number;
}
