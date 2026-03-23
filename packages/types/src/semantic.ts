/** Semantic layer entity types — dimensions, joins, measures, query patterns, and entity shapes. */

import type { PIICategory, PIIConfidence } from "./compliance";

/** Valid dimension types per the semantic layer YAML spec. */
export type DimensionType = "string" | "number" | "date" | "boolean" | "timestamp";

export interface Dimension {
  name: string;
  type: DimensionType | (string & {});
  description?: string;
  sample_values?: string[];
  primary_key?: boolean;
  foreign_key?: boolean;
  /** PII category detected during profiling. Enterprise feature. Must be set together with pii_confidence. */
  pii?: PIICategory | (string & {});
  /** PII detection confidence level. Must be set together with pii. */
  pii_confidence?: PIIConfidence | (string & {});
}

export interface Join {
  to: string;
  description?: string;
  relationship?: string;
  on?: string;
}

export interface Measure {
  name: string;
  sql: string;
  type?: string;
  description?: string;
}

export interface QueryPattern {
  name: string;
  description: string;
  sql: string;
}

export interface SemanticEntitySummary {
  table: string;
  description: string;
  columnCount: number;
  joinCount: number;
  type: "table" | "view" | null;
}

export interface SemanticEntityDetail {
  table: string;
  description: string;
  type?: "table" | "view" | null;
  dimensions: Record<string, Dimension> | Dimension[];
  joins?: Join[] | Record<string, Join>;
  measures?: Record<string, Measure> | Measure[];
  query_patterns?: Record<string, QueryPattern> | QueryPattern[];
}

export interface EntityData extends SemanticEntityDetail {
  name: string;
}

// ---------------------------------------------------------------------------
// Schema diff types (admin API)
// ---------------------------------------------------------------------------

/** Column-level diff for a single table that exists in both DB and YAML. */
export interface SemanticTableDiff {
  table: string;
  addedColumns: { name: string; type: string }[];
  removedColumns: { name: string; type: string }[];
  typeChanges: { name: string; yamlType: string; dbType: string }[];
}

/** Full diff result returned by `GET /api/v1/admin/semantic/diff`. */
export interface SemanticDiffResponse {
  connection: string;
  newTables: string[];
  removedTables: string[];
  tableDiffs: SemanticTableDiff[];
  unchangedCount: number;
  summary: {
    total: number;
    new: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
  warnings?: string[];
}

/** Column info returned by the public tables endpoint. */
export interface TableColumn {
  name: string;
  type: DimensionType | (string & {});
  description: string;
}

/**
 * Simplified table info returned by the public `GET /api/v1/tables` endpoint.
 * A projection of `SemanticEntityDetail` exposing only dimensions (as columns).
 */
export interface TableInfo {
  table: string;
  description: string;
  columns: TableColumn[];
}
