/**
 * Pattern detection for semantic layer profiling.
 *
 * Enriches profiled columns with semantic types (currency, percentage, email,
 * url, phone, timestamp), discovers joins from naming conventions beyond _id
 * suffix, and suggests appropriate aggregation types for measures.
 *
 * Detection functions (`detectSemanticType`, `suggestMeasureType`, `describeMeasure`)
 * are pure. Bulk inference functions (`inferSemanticTypes`,
 * `inferJoinsFromNamingConventions`) mutate profiles in place.
 */

import type {
  ColumnProfile,
  ForeignKey,
  SemanticType,
  TableProfile,
} from "@useatlas/types";
import { mapSQLType, isViewLike, pluralize, singularize } from "./profiler";

// ---------------------------------------------------------------------------
// Semantic type detection
// ---------------------------------------------------------------------------

const CURRENCY_NAME_PATTERNS = /(?:^|_)(amount|price|cost|revenue|fee|payment|balance|salary|wage|income|expense|budget|profit|loss|total_cost|total_price|total_revenue|subtotal|tax|charge|refund|credit|debit)(?:$|_)/i;
const CURRENCY_VALUE_PATTERN = /^[$€£¥₹]\s?[\d,.]+$/;
const TWO_DECIMAL_PATTERN = /^\d[\d,]*\.\d{2}$/;

const PERCENTAGE_NAME_PATTERNS = /(?:^|_)(rate|pct|percent|ratio|proportion|share|coverage|utilization|completion|success_rate|failure_rate|click_rate|open_rate|conversion|churn)(?:$|_)/i;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\//i;
const URL_NAME_PATTERNS = /(?:^|_)(url|link|href|website|webpage|homepage|endpoint|uri)(?:$|_)/i;

const PHONE_PATTERN = /^[+]?[\d\s().-]{7,20}$/;
const PHONE_NAME_PATTERNS = /(?:^|_)(phone|tel|telephone|mobile|cell|fax|sms)(?:$|_)/i;

/** Detect semantic type for a single column based on name, SQL type, and sample values. */
export function detectSemanticType(
  col: ColumnProfile,
  rowCount: number,
): SemanticType | undefined {
  const mappedType = mapSQLType(col.type);
  const lowerType = col.type.toLowerCase();

  // Timestamp vs date — only when SQL type explicitly says "timestamp"
  if (mappedType === "date" && lowerType.includes("timestamp")) {
    return "timestamp";
  }

  // Percentage — check before currency since "discount_pct" should be percentage, not currency
  if (mappedType === "number" && !col.is_primary_key && !col.is_foreign_key) {
    if (PERCENTAGE_NAME_PATTERNS.test(col.name)) {
      return "percentage";
    }
  }

  // Currency — numeric columns with money-related names or $ in values
  if (mappedType === "number" && !col.is_primary_key && !col.is_foreign_key) {
    if (CURRENCY_NAME_PATTERNS.test(col.name)) {
      return "currency";
    }
    if (col.sample_values.length > 0) {
      const currencyMatches = col.sample_values.filter(
        (v) => CURRENCY_VALUE_PATTERN.test(v) || TWO_DECIMAL_PATTERN.test(v),
      );
      if (currencyMatches.length >= col.sample_values.length * 0.5 && currencyMatches.length >= 2) {
        return "currency";
      }
    }
  }

  // Email — string columns with email-like sample values
  if (mappedType === "string" && col.sample_values.length >= 2) {
    const emailMatches = col.sample_values.filter((v) => EMAIL_PATTERN.test(v));
    if (emailMatches.length >= col.sample_values.length * 0.5) {
      return "email";
    }
  }

  // URL — string columns with URL values or url-related names
  if (mappedType === "string") {
    if (URL_NAME_PATTERNS.test(col.name)) {
      return "url";
    }
    if (col.sample_values.length >= 2) {
      const urlMatches = col.sample_values.filter((v) => URL_PATTERN.test(v));
      if (urlMatches.length >= col.sample_values.length * 0.5) {
        return "url";
      }
    }
  }

  // Phone — string columns with phone-like values or phone-related names
  if (mappedType === "string" && !col.is_enum_like) {
    if (PHONE_NAME_PATTERNS.test(col.name)) {
      if (col.sample_values.length === 0 || col.sample_values.some((v) => PHONE_PATTERN.test(v))) {
        return "phone";
      }
    }
    if (col.sample_values.length >= 2) {
      const phoneMatches = col.sample_values.filter((v) => PHONE_PATTERN.test(v));
      if (phoneMatches.length >= col.sample_values.length * 0.5 && rowCount > 0) {
        // Only if high cardinality (not enum-like), to avoid false positives on short codes
        const uniqueRatio = col.unique_count !== null ? col.unique_count / rowCount : 1;
        if (uniqueRatio > 0.1) {
          return "phone";
        }
      }
    }
  }

  return undefined;
}

/**
 * Detect semantic types for all columns across all profiles.
 * Mutates the `semantic_type` field on each column.
 */
export function inferSemanticTypes(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    for (const col of profile.columns) {
      const detected = detectSemanticType(col, profile.row_count);
      if (detected) {
        col.semantic_type = detected;
        col.profiler_notes.push(`Detected semantic type: ${detected}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Enhanced join discovery
// ---------------------------------------------------------------------------

/** Suffixes that strongly suggest a FK relationship when combined with a table name. */
const FK_SUFFIXES = ["_id", "_uuid", "_key", "_code", "_ref"] as const;

/**
 * Infer joins from naming conventions beyond the basic _id pattern.
 *
 * Looks for columns whose name matches `{table_name}{suffix}` for known
 * FK-like suffixes (_uuid, _key, _code, _ref), and checks that the target
 * table has a matching column.
 *
 * The basic `_id` pattern is handled by the existing `inferForeignKeys()` in
 * profiler.ts — this function covers additional suffixes.
 */
export function inferJoinsFromNamingConventions(profiles: TableProfile[]): void {
  const tableMap = new Map(
    profiles.filter((p) => !isViewLike(p)).map((p) => [p.table_name, p]),
  );

  // Build a set of PK column names per table for quick lookup
  const tablePKs = new Map<string, Set<string>>();
  for (const p of profiles) {
    if (!isViewLike(p)) {
      tablePKs.set(p.table_name, new Set(p.primary_key_columns));
    }
  }

  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    // Columns already handled by FK constraints or existing inferred FKs
    const handledCols = new Set([
      ...profile.foreign_keys.map((fk) => fk.from_column),
      ...profile.inferred_foreign_keys.map((fk) => fk.from_column),
    ]);

    for (const col of profile.columns) {
      if (col.is_primary_key) continue;
      if (handledCols.has(col.name)) continue;

      // Try each suffix (skip _id — already handled by inferForeignKeys)
      for (const suffix of FK_SUFFIXES) {
        if (suffix === "_id") continue;
        if (!col.name.endsWith(suffix)) continue;

        const prefix = col.name.slice(0, -suffix.length);
        if (!prefix) continue;

        // Find target table
        const candidates = [prefix, pluralize(prefix), singularize(prefix)];
        let targetTable: TableProfile | undefined;
        for (const candidate of candidates) {
          targetTable = tableMap.get(candidate);
          if (targetTable) break;
        }
        if (!targetTable) continue;
        if (targetTable.table_name === profile.table_name) continue;

        // Find matching target column — look for the suffix column name (e.g., "uuid", "code")
        const targetColName = suffix.slice(1); // strip leading _
        const targetHasCol = targetTable.columns.some((c) => c.name === targetColName);
        // Also accept "id" as fallback target
        const targetHasId = tablePKs.get(targetTable.table_name)?.has("id") ?? false;

        const toColumn = targetHasCol ? targetColName : targetHasId ? "id" : null;
        if (!toColumn) continue;

        const inferredFK: ForeignKey = {
          from_column: col.name,
          to_table: targetTable.table_name,
          to_column: toColumn,
          source: "inferred",
        };

        profile.inferred_foreign_keys.push(inferredFK);
        handledCols.add(col.name);

        col.profiler_notes.push(
          `Likely FK to ${targetTable.table_name}.${toColumn} (inferred from naming convention ${col.name})`,
        );
        break; // Found a match for this column, move on
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Measure type suggestion
// ---------------------------------------------------------------------------

/** Aggregation type suggestion for a column based on name patterns and semantic type. */
export const MEASURE_SUGGESTIONS = ["sum", "avg", "sum_and_avg", "count_where"] as const;
export type MeasureSuggestion = (typeof MEASURE_SUGGESTIONS)[number];

const SUM_ONLY_PATTERNS = /(?:^|_)(count|total|num|quantity|qty|sum)(?:$|_)/i;
const AVG_ONLY_PATTERNS = /(?:^|_)(rate|ratio|pct|percent|avg|average|mean|score|rating|index|rank)(?:$|_)/i;

/**
 * Suggest the most appropriate aggregation type for a numeric column.
 *
 * Returns:
 * - `"sum"` for count/total columns (SUM of counts is meaningful)
 * - `"avg"` for rate/ratio/score columns (SUM of rates is meaningless)
 * - `"sum_and_avg"` for currency and general numeric columns
 * - `"count_where"` for boolean columns
 */
export function suggestMeasureType(col: ColumnProfile): MeasureSuggestion {
  const mappedType = mapSQLType(col.type);

  // Boolean columns → COUNT WHERE
  if (mappedType === "boolean") {
    return "count_where";
  }

  // Percentage semantic type → AVG only
  if (col.semantic_type === "percentage") {
    return "avg";
  }

  // Name-based patterns
  if (SUM_ONLY_PATTERNS.test(col.name)) {
    return "sum";
  }
  if (AVG_ONLY_PATTERNS.test(col.name)) {
    return "avg";
  }

  // Currency and general numeric → both
  return "sum_and_avg";
}

/**
 * Generate a human-readable description for a measure based on semantic type.
 */
export function describeMeasure(
  col: ColumnProfile,
  aggType: "sum" | "avg",
): string {
  const label = col.name.replace(/_/g, " ");
  const prefix = aggType === "sum" ? "Total" : "Average";

  if (col.semantic_type === "currency") {
    return `${prefix} ${label} (monetary)`;
  }
  if (col.semantic_type === "percentage") {
    return `${prefix} ${label} (rate/percentage)`;
  }
  return `${prefix === "Total" ? "Sum" : "Average"} of ${label}`;
}
