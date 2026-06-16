/**
 * Semantic-layer mechanical generator — profile analysis pass.
 *
 * Pure heuristics over `TableProfile[]`: FK inference, abandoned/denormalized
 * table detection, enum-inconsistency flags, plus the `analyzeTableProfiles`
 * orchestrator that the CLI (`atlas init`) and the web wizard both run before
 * generating YAML.
 *
 * Relocated from `lib/profiler.ts` (issue #3233) so the mechanical generator
 * and the LLM enrichment live behind one shared engine. `lib/profiler.ts`
 * re-exports these for backward compatibility.
 */

import type { TableProfile, ForeignKey, IndexProfile } from "@useatlas/types";
import { isViewLike, pluralize, singularize } from "../../profiler-utils";
import {
  inferSemanticTypes,
  inferJoinsFromNamingConventions,
} from "../../profiler-patterns";

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

export function isView(profile: TableProfile): boolean {
  return profile.object_type === "view";
}

export function isMatView(profile: TableProfile): boolean {
  return profile.object_type === "materialized_view";
}

export function mapSalesforceFieldType(sfType: string): string {
  const lower = sfType.toLowerCase();
  switch (lower) {
    case "int":
    case "long":
      return "integer";
    case "double":
    case "currency":
    case "percent":
      return "real";
    case "boolean":
      return "boolean";
    case "date":
    case "datetime":
    case "time":
      return "date";
    default:
      return "string";
  }
}

// ---------------------------------------------------------------------------
// Profiler heuristics (pure functions on TableProfile[])
// ---------------------------------------------------------------------------

export function inferForeignKeys(profiles: TableProfile[]): void {
  const tableMap = new Map(
    profiles.filter((p) => !isViewLike(p)).map((p) => [p.table_name, p])
  );

  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const constrainedCols = new Set(profile.foreign_keys.map((fk) => fk.from_column));

    for (const col of profile.columns) {
      if (!col.name.endsWith("_id")) continue;
      if (constrainedCols.has(col.name)) continue;
      if (col.is_primary_key) continue;

      const prefix = col.name.slice(0, -3);
      if (!prefix) continue;

      const candidates = [prefix, pluralize(prefix), singularize(prefix)];
      let targetTable: TableProfile | undefined;
      for (const candidate of candidates) {
        targetTable = tableMap.get(candidate);
        if (targetTable) break;
      }

      if (!targetTable) continue;

      const hasPkId = targetTable.primary_key_columns.includes("id");
      if (!hasPkId) continue;

      const inferredFK: ForeignKey = {
        from_column: col.name,
        to_table: targetTable.table_name,
        to_column: "id",
        source: "inferred",
      };

      profile.inferred_foreign_keys.push(inferredFK);

      col.profiler_notes.push(
        `Likely FK to ${targetTable.table_name}.id (inferred from column name, no constraint exists)`
      );
    }
  }
}

const ABANDONED_NAME_PATTERNS = [
  /^old_/,
  /^temp_/,
  /^legacy_/,
  /_legacy$/,
  /_backup$/,
  /_archive$/,
  /_v\d+$/,
];

export function detectAbandonedTables(profiles: TableProfile[]): void {
  const referencedTables = new Set<string>();
  for (const p of profiles) {
    for (const fk of p.foreign_keys) referencedTables.add(fk.to_table);
    for (const fk of p.inferred_foreign_keys) referencedTables.add(fk.to_table);
  }

  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const nameMatches = ABANDONED_NAME_PATTERNS.some((pat) =>
      pat.test(profile.table_name)
    );
    if (!nameMatches) continue;

    const hasInboundFKs = referencedTables.has(profile.table_name);
    if (hasInboundFKs) continue;

    profile.table_flags.possibly_abandoned = true;
    profile.profiler_notes.push(
      `Possibly abandoned: name matches legacy/temp pattern and no other tables reference it`
    );
  }
}

export function detectEnumInconsistency(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    for (const col of profile.columns) {
      if (!col.is_enum_like) continue;
      if (col.sample_values.length === 0) continue;

      const groups = new Map<string, string[]>();
      for (const val of col.sample_values) {
        const lower = val.toLowerCase();
        const existing = groups.get(lower) ?? [];
        existing.push(val);
        groups.set(lower, existing);
      }

      const inconsistencies: string[] = [];
      for (const [, originals] of groups) {
        if (originals.length > 1) {
          inconsistencies.push(originals.join(", "));
        }
      }

      if (inconsistencies.length > 0) {
        col.profiler_notes.push(
          `Case-inconsistent enum values: [${inconsistencies.join("; ")}]. Consider using LOWER() for grouping`
        );
      }
    }
  }
}

const DENORMALIZED_NAME_PATTERNS = [
  /_denormalized$/,
  /_cache$/,
  /_summary$/,
  /_stats$/,
  /_rollup$/,
];

export function detectDenormalizedTables(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const nameMatches = DENORMALIZED_NAME_PATTERNS.some((pat) =>
      pat.test(profile.table_name)
    );
    if (!nameMatches) continue;

    profile.table_flags.possibly_denormalized = true;
    profile.profiler_notes.push(
      `Possibly denormalized/materialized table: name matches reporting pattern. Data may duplicate other tables`
    );
  }
}

/**
 * Derive per-column sargability flags from harvested indexes (#3634).
 *
 * Sets `col.indexed` + `col.index_position` on each column from the table's
 * `indexes[]`. This is the leading-vs-trailing rule the agent relies on:
 *
 *  - A column is **leading** (independently sargable) if it is the FIRST member
 *    of any index, OR a member at any position of a NON-btree index — GIN/BRIN/
 *    GiST/hash don't depend on column order, so each member is usable on its own.
 *  - A column that appears in indexes ONLY as a non-first member of a composite
 *    BTREE is **trailing**: `WHERE trailing_col = ?` can't use an `(a, b)` index
 *    without also constraining `a`.
 *
 * Expression-index members (e.g. `lower(email)`) are matched against the bare
 * column name they wrap so the underlying column is still considered indexed
 * when it appears as a clear leading expression part; non-matching expression
 * members simply don't flag any `ColumnProfile`. Index members are compared to
 * column names case-insensitively and with surrounding double-quotes stripped,
 * since Postgres renders quoted identifiers verbatim.
 *
 * Mutates the passed profiles in place (called on the fresh clones built by
 * `analyzeTableProfiles`, never on caller-owned input). Exported for unit tests.
 */
export function deriveColumnIndexFlags(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    const indexes = profile.indexes ?? [];
    if (indexes.length === 0) continue;

    // For each column name, track whether it is ever a leading member and
    // whether it is ever any kind of member at all.
    const leading = new Set<string>();
    const member = new Set<string>();

    for (const idx of indexes) {
      for (const [position, rawMember] of idx.columns.entries()) {
        const colName = matchIndexMemberToColumn(rawMember, profile);
        if (!colName) continue;
        member.add(colName);
        // First member of ANY index, or any member of a non-btree index, is
        // independently sargable.
        if (position === 0 || idx.index_type !== "btree") {
          leading.add(colName);
        }
      }
    }

    for (const col of profile.columns) {
      if (!member.has(col.name)) continue;
      col.indexed = true;
      col.index_position = leading.has(col.name) ? "leading" : "trailing";
    }
  }
}

/**
 * Resolve an index member (a column name OR a rendered expression) to one of the
 * table's column names, or null if it maps to no single column. Used by
 * {@link deriveColumnIndexFlags} so expression indexes still flag the column
 * they wrap when it appears unambiguously.
 */
function matchIndexMemberToColumn(rawMember: string, profile: TableProfile): string | null {
  const unquoted = stripIdentifierQuotes(rawMember.trim());
  const direct = profile.columns.find((c) => c.name === unquoted);
  if (direct) return direct.name;

  // Expression member (e.g. `lower(email)`, `(email)::text`): flag the column
  // only when EXACTLY one column name appears as a whole word in the expression,
  // so a multi-column expression doesn't mis-attribute sargability.
  const matches = profile.columns.filter((c) =>
    new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(c.name)}([^A-Za-z0-9_]|$)`).test(unquoted)
  );
  return matches.length === 1 ? matches[0].name : null;
}

function stripIdentifierQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when an index is worth surfacing as an entity-level `indexes[]` entry:
 * composite (multi-column) or partial. Single-column non-partial indexes are
 * already conveyed by the per-dimension `indexed` flag, so they're omitted to
 * keep the YAML compact (#3634).
 */
export function isCompositeOrPartialIndex(idx: IndexProfile): boolean {
  return idx.columns.length > 1 || idx.is_partial;
}

export function analyzeTableProfiles(profiles: readonly TableProfile[]): TableProfile[] {
  // Create fresh copies with reset analysis fields (no mutation of input).
  // Deep-clone foreign_keys and partition_info to fully isolate from input.
  const analyzed: TableProfile[] = profiles.map((p) => ({
    ...p,
    foreign_keys: p.foreign_keys.map((fk) => ({ ...fk })),
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    // Strip any stale derived index flags on the clone; deriveColumnIndexFlags
    // sets them fresh from the harvested indexes[] below.
    columns: p.columns.map((col) => {
      const { indexed: _indexed, index_position: _pos, ...rest } = col;
      return { ...rest, profiler_notes: [] };
    }),
    indexes: p.indexes
      ? p.indexes.map((idx) => ({ ...idx, columns: [...idx.columns] }))
      : undefined,
    partition_info: p.partition_info
      ? { ...p.partition_info, children: [...p.partition_info.children] }
      : undefined,
  }));

  inferForeignKeys(analyzed);
  inferJoinsFromNamingConventions(analyzed);
  inferSemanticTypes(analyzed);
  detectAbandonedTables(analyzed);
  detectEnumInconsistency(analyzed);
  detectDenormalizedTables(analyzed);
  deriveColumnIndexFlags(analyzed);

  return analyzed;
}
