/**
 * Shared profiler utilities — extracted to break circular dependency
 * between profiler.ts and profiler-patterns.ts.
 */

import type { TableProfile } from "@useatlas/types";

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

export function isViewLike(profile: TableProfile): boolean {
  return profile.object_type === "view" || profile.object_type === "materialized_view";
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

export function mapSQLType(sqlType: string): string {
  // Peel ClickHouse wrappers inside-out. Bounded `[^()]+` capture avoids the
  // ambiguous greedy `.+\)` match that CodeQL flagged as polynomial-ReDoS.
  let unwrapped = sqlType;
  for (let i = 0; i < 16; i++) {
    const next = unwrapped
      .replace(/Nullable\(([^()]+)\)/, "$1")
      .replace(/LowCardinality\(([^()]+)\)/, "$1");
    if (next === unwrapped) break;
    unwrapped = next;
  }
  const t = unwrapped.toLowerCase();
  if (t.includes("interval") || t.includes("money")) return "string";
  if (
    t.includes("int") ||
    t.includes("float") ||
    t.includes("real") ||
    t.includes("numeric") ||
    t.includes("decimal") ||
    t.includes("double") ||
    t === "currency" ||
    t === "percent" ||
    t === "long"
  )
    return "number";
  if (t.startsWith("bool")) return "boolean";
  if (t.includes("date") || t.includes("time") || t.includes("timestamp"))
    return "date";
  return "string";
}

// ---------------------------------------------------------------------------
// Pluralization helpers
// ---------------------------------------------------------------------------

const IRREGULAR_PLURALS: Record<string, string> = {
  people: "person",
  children: "child",
  men: "man",
  women: "woman",
  mice: "mouse",
  data: "datum",
  criteria: "criterion",
  analyses: "analysis",
};

const IRREGULAR_SINGULARS_TO_PLURALS: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_PLURALS).map(([plural, singular]) => [singular, plural])
);

export function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR_SINGULARS_TO_PLURALS[lower]) return IRREGULAR_SINGULARS_TO_PLURALS[lower];
  if (lower.endsWith("y") && !/[aeiou]y$/i.test(lower))
    return word.slice(0, -1) + "ies";
  if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z") || lower.endsWith("sh") || lower.endsWith("ch"))
    return word + "es";
  return word + "s";
}

export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
  if (lower.endsWith("ies")) return word.slice(0, -3) + "y";
  if (lower.endsWith("ses") || lower.endsWith("xes") || lower.endsWith("zes"))
    return word.slice(0, -2);
  if (lower.endsWith("s") && !lower.endsWith("ss") && !lower.endsWith("us") && !lower.endsWith("is")) return word.slice(0, -1);
  return word;
}

// ---------------------------------------------------------------------------
// Entity name helper
// ---------------------------------------------------------------------------

export function entityName(tableName: string): string {
  return tableName
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
