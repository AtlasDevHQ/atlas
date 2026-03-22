/**
 * Profiler and wizard types — shared between @atlas/api (snake_case wire format)
 * and @atlas/web (camelCase UI types).
 *
 * Canonical definitions live here; both packages import from @useatlas/types.
 */

// ---------------------------------------------------------------------------
// Core enums & primitives
// ---------------------------------------------------------------------------

/** Database object type returned by profiler discovery. */
export type ObjectType = "table" | "view" | "materialized_view";

/** Source of a foreign key relationship. */
export type ForeignKeySource = "constraint" | "inferred";

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
  profiler_notes: string[];
}

// ---------------------------------------------------------------------------
// Table profile
// ---------------------------------------------------------------------------

/**
 * Table profile from the database profiler.
 *
 * `matview_populated` is only meaningful when `object_type === "materialized_view"`.
 * Use the `isMatView()` guard from the profiler module before accessing it.
 */
export interface TableProfile {
  table_name: string;
  object_type: ObjectType;
  row_count: number;
  columns: ColumnProfile[];
  primary_key_columns: string[];
  foreign_keys: ForeignKey[];
  inferred_foreign_keys: ForeignKey[];
  profiler_notes: string[];
  table_flags: {
    possibly_abandoned: boolean;
    possibly_denormalized: boolean;
  };
  matview_populated?: boolean;
  partition_info?: { strategy: "range" | "list" | "hash"; key: string; children: string[] };
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
    flags: { possiblyAbandoned: boolean; possiblyDenormalized: boolean };
    notes: string[];
  };
}

/** Table entry returned by the wizard profile endpoint. */
export interface WizardTableEntry {
  name: string;
  type: ObjectType;
}
