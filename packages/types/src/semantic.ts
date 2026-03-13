export interface Dimension {
  name: string;
  type: string;
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
  type?: "table" | "view";
  dimensions: Record<string, Dimension> | Dimension[];
  joins?: Join[] | Record<string, Join>;
  measures?: Record<string, Measure> | Measure[];
  query_patterns?: Record<string, QueryPattern> | QueryPattern[];
}

export interface EntityData extends SemanticEntityDetail {
  name: string;
}
