/** Types for the pre-computed semantic index. */

/** A parsed entity from a YAML file, used internally by the index builder. */
export interface ParsedEntity {
  name: string;
  table: string;
  description?: string;
  type?: string;
  grain?: string;
  connection?: string;
  /** Source directory name for multi-source layouts (e.g. "warehouse"). */
  sourceId?: string;
  dimensions: ParsedDimension[];
  measures: ParsedMeasure[];
  joins: ParsedJoin[];
  queryPatterns: ParsedQueryPattern[];
  /** Catalog-provided use_for hints. */
  useFor?: string[];
}

export interface ParsedDimension {
  name: string;
  type: string;
  description?: string;
  primary_key?: boolean;
  foreign_key?: boolean;
  sample_values?: string[];
}

export interface ParsedMeasure {
  name: string;
  type?: string;
  sql?: string;
  description?: string;
}

export interface ParsedJoin {
  target_entity: string;
  relationship?: string;
  description?: string;
}

export interface ParsedQueryPattern {
  name: string;
  description: string;
}

/** A metric defined in metrics/*.yml. */
export interface ParsedMetric {
  name: string;
  description?: string;
  entity?: string;
  aggregation?: string;
}

/** A glossary term defined in glossary.yml. */
export interface ParsedGlossaryTerm {
  term: string;
  definition?: string;
  status?: string;
  disambiguation?: string;
}

/** Catalog entry with use_for hints. */
export interface CatalogEntry {
  name: string;
  description?: string;
  useFor?: string[];
}
