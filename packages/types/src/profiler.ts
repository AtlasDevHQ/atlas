/**
 * Profiler and wizard types — shared between @atlas/api (snake_case wire format)
 * and @atlas/web (camelCase UI types).
 *
 * Canonical definitions live here; both packages import from @useatlas/types.
 */

// ---------------------------------------------------------------------------
// Core enums & primitives — const tuples as single source of truth
// ---------------------------------------------------------------------------

/** Valid database object types returned by profiler discovery. */
export const OBJECT_TYPES = ["table", "view", "materialized_view"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** Valid foreign key relationship sources. */
export const FK_SOURCES = ["constraint", "inferred"] as const;
export type ForeignKeySource = (typeof FK_SOURCES)[number];

/** Valid partition strategies. */
export const PARTITION_STRATEGIES = ["range", "list", "hash"] as const;
export type PartitionStrategy = (typeof PARTITION_STRATEGIES)[number];

/**
 * Index access methods we surface to the agent. PostgreSQL exposes these via
 * `pg_am.amname`; MySQL effectively only has `btree` (and `fulltext`/`spatial`,
 * mapped to `gin`/`gist` respectively for a uniform vocabulary). `other` is the
 * catch-all so an unrecognized access method never drops the index entirely.
 */
export const INDEX_TYPES = ["btree", "gin", "gist", "brin", "hash", "other"] as const;
export type IndexType = (typeof INDEX_TYPES)[number];

/**
 * Marks how a column participates in indexes, for sargability hints (#3634).
 *
 * - `leading`  — the column is independently sargable: it is the first column
 *   of at least one index, OR a member of a non-btree index (GIN/BRIN/etc. do
 *   not depend on column position). The agent can filter on it cheaply.
 * - `trailing` — the column appears in indexes ONLY as a non-first member of a
 *   composite btree. A trailing btree column is NOT independently sargable: an
 *   index on `(a, b)` does not accelerate `WHERE b = ?` without `a`.
 *
 * Derived during profile analysis (`analyzeTableProfiles`), never harvested.
 */
export const INDEX_POSITIONS = ["leading", "trailing"] as const;
export type IndexPosition = (typeof INDEX_POSITIONS)[number];

/** Semantic types inferred from column names, sample values, and SQL types. */
export const SEMANTIC_TYPES = [
  "currency",
  "percentage",
  "email",
  "url",
  "phone",
  "timestamp",
] as const;
export type SemanticType = (typeof SEMANTIC_TYPES)[number];

// ---------------------------------------------------------------------------
// Foreign key
// ---------------------------------------------------------------------------

export interface ForeignKey {
  from_column: string;
  to_table: string;
  to_column: string;
  source: ForeignKeySource;
}

// ---------------------------------------------------------------------------
// Column profile
// ---------------------------------------------------------------------------

/**
 * Column profile from the database profiler.
 *
 * Invariant: when `is_foreign_key` is true, `fk_target_table` and
 * `fk_target_column` are non-null strings. When false, both are null.
 * This is enforced at construction time in the profiler, not via
 * discriminated union, to keep the type ergonomic for constructors.
 */
export interface ColumnProfile {
  name: string;
  type: string;
  nullable: boolean;
  unique_count: number | null;
  null_count: number | null;
  sample_values: string[];
  is_primary_key: boolean;
  is_foreign_key: boolean;
  fk_target_table: string | null;
  fk_target_column: string | null;
  is_enum_like: boolean;
  semantic_type?: SemanticType;
  /**
   * Whether the column participates in any index. Derived during profile
   * analysis from {@link TableProfile.indexes} (#3634), not harvested per-column.
   * Absent on profiles produced before index harvesting (treat as unknown).
   */
  indexed?: boolean;
  /**
   * Sargability marker derived alongside {@link indexed}. Present only when
   * `indexed` is true; see {@link IndexPosition}. A `trailing` column is indexed
   * but not independently sargable.
   */
  index_position?: IndexPosition;
  profiler_notes: string[];
}

// ---------------------------------------------------------------------------
// Index profile
// ---------------------------------------------------------------------------

/**
 * A single index harvested from the database catalog (#3634).
 *
 * `columns` is the ORDERED list of index members — for a composite btree the
 * order is load-bearing (only the leading prefix is independently sargable).
 * Expression-index members are rendered as their definition text (e.g.
 * `lower(email)`) rather than a bare column name, so they survive into the YAML
 * even though they don't map to a single `ColumnProfile`.
 *
 * `predicate` is the partial-index WHERE text (PostgreSQL only; null when the
 * index is not partial). MySQL has no partial indexes, so MySQL-harvested
 * indexes always carry `is_partial: false` and `predicate: null`.
 */
export interface IndexProfile {
  name: string;
  columns: string[];
  index_type: IndexType;
  is_unique: boolean;
  is_primary: boolean;
  is_partial: boolean;
  predicate: string | null;
}

// ---------------------------------------------------------------------------
// Table profile
// ---------------------------------------------------------------------------

/** Heuristic flags set by `analyzeTableProfiles`. */
export interface TableFlags {
  possibly_abandoned: boolean;
  possibly_denormalized: boolean;
}

/** Partition metadata for partitioned Postgres tables. */
export interface PartitionInfo {
  strategy: PartitionStrategy;
  key: string;
  children: string[];
}

/**
 * Table profile from the database profiler.
 *
 * `matview_populated` is only present when `object_type === "materialized_view"`.
 * Check `object_type` before relying on its value.
 */
export interface TableProfile {
  table_name: string;
  object_type: ObjectType;
  row_count: number;
  columns: ColumnProfile[];
  primary_key_columns: string[];
  foreign_keys: ForeignKey[];
  inferred_foreign_keys: ForeignKey[];
  /**
   * Indexes harvested from the catalog (#3634). Empty when the table has no
   * (non-implicit) indexes, when the object is a view/matview, or when the
   * harvest query failed soft (a warning is logged, profiling continues).
   * Optional so profiles produced before index harvesting still type-check.
   */
  indexes?: IndexProfile[];
  profiler_notes: string[];
  table_flags: TableFlags;
  matview_populated?: boolean;
  partition_info?: PartitionInfo;
}

// ---------------------------------------------------------------------------
// Database object (discovery result)
// ---------------------------------------------------------------------------

export interface DatabaseObject {
  name: string;
  type: ObjectType;
}

// ---------------------------------------------------------------------------
// Profiling result
// ---------------------------------------------------------------------------

export interface ProfileError {
  table: string;
  error: string;
}

export interface ProfilingResult {
  profiles: TableProfile[];
  errors: ProfileError[];
}

// ---------------------------------------------------------------------------
// Wizard API wire types (camelCase — returned by /api/v1/wizard/generate)
// ---------------------------------------------------------------------------

/** camelCase column info in the wizard generate response. */
export interface WizardEntityColumn {
  name: string;
  type: string;
  mappedType?: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isEnumLike: boolean;
  semanticType?: SemanticType;
  sampleValues: string[];
  uniqueCount: number | null;
  nullCount: number | null;
}

/** camelCase foreign key in the wizard generate response. */
export interface WizardForeignKey {
  fromColumn: string;
  toTable: string;
  toColumn: string;
  source: ForeignKeySource;
}

/** camelCase inferred foreign key in the wizard generate response. */
export interface WizardInferredForeignKey {
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

/** camelCase heuristic flags in the wizard generate response. */
export interface WizardTableFlags {
  possiblyAbandoned: boolean;
  possiblyDenormalized: boolean;
}

/** Single entity result from the wizard generate endpoint. */
export interface WizardEntityResult {
  tableName: string;
  objectType: ObjectType;
  rowCount: number;
  columnCount: number;
  yaml: string;
  profile: {
    columns: WizardEntityColumn[];
    primaryKeys: string[];
    foreignKeys: WizardForeignKey[];
    inferredForeignKeys: WizardInferredForeignKey[];
    flags: WizardTableFlags;
    notes: string[];
  };
}

/** Table entry returned by the wizard profile endpoint. */
export interface WizardTableEntry {
  name: string;
  type: ObjectType;
}

/**
 * Result of a single table's Phase-2 enrichment
 * (POST /api/v1/wizard/enrich — issue #3236, semantic-onboarding § D).
 *
 * The enrich endpoint is per-table so the two-phase generate UI can stream
 * results in and upgrade each row in place. `yaml` is the LLM-enriched entity
 * YAML when `enriched` is true, or the unchanged mechanical baseline when the
 * model returned an unusable response (`enriched: false`) — either way it's a
 * valid YAML string safe to save.
 */
export interface WizardEnrichResult {
  tableName: string;
  yaml: string;
  enriched: boolean;
}
