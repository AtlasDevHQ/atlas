/** Semantic layer entity types — dimensions, joins, measures, query patterns, and entity shapes. */

/** Valid dimension types per the semantic layer YAML spec. */
export type DimensionType = "string" | "number" | "date" | "boolean" | "timestamp";

export interface Dimension {
  name: string;
  type: DimensionType | (string & {});
  description?: string;
  sample_values?: string[];
  primary_key?: boolean;
  foreign_key?: boolean;
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
