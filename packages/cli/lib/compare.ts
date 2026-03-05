/**
 * Result-set comparison utilities shared by the BIRD benchmark and eval runners.
 *
 * Compares gold and predicted SQL result sets with:
 * - Order-insensitive row matching (rows sorted before comparison)
 * - Column-name-insensitive comparison (only values matter)
 * - Type coercion: null/undefined/empty/"null"/"none" → null; numeric strings
 *   parsed to numbers; numbers compared with 0.001 absolute + relative tolerance;
 *   strings case-insensitive + trimmed; booleans → 0/1
 */

/** Escape a SQL identifier (double-quote wrapping with internal quote doubling). */
export function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Normalize a single cell value for comparison. */
export function normalizeValue(v: unknown): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;

  const s = String(v).trim();
  if (s === "" || s.toLowerCase() === "null" || s.toLowerCase() === "none") return null;

  // Try parsing as number
  const n = Number(s);
  if (!Number.isNaN(n) && s !== "") return n;

  return s.toLowerCase();
}

/** Sort rows for order-insensitive comparison. */
export function sortRows(rows: unknown[][]): unknown[][] {
  return [...rows].sort((a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const va = normalizeValue(a[i]);
      const vb = normalizeValue(b[i]);
      if (va === null && vb === null) continue;
      if (va === null) return -1;
      if (vb === null) return 1;
      if (typeof va === "number" && typeof vb === "number") {
        if (va !== vb) return va - vb;
        continue;
      }
      const sa = String(va);
      const sb = String(vb);
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
    return 0;
  });
}

/** Compare two values with tolerance. */
export function valuesMatch(a: unknown, b: unknown): boolean {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);

  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;

  if (typeof na === "number" && typeof nb === "number") {
    if (na === nb) return true;
    // Absolute tolerance
    if (Math.abs(na - nb) <= 0.001) return true;
    // Relative tolerance for larger numbers
    const denom = Math.max(Math.abs(na), Math.abs(nb));
    if (denom > 0 && Math.abs(na - nb) / denom <= 0.001) return true;
    return false;
  }

  return na === nb;
}

/**
 * Compare gold and predicted result sets for execution accuracy.
 *
 * - Order-insensitive (rows sorted before comparison)
 * - Column-name-insensitive (only values matter)
 * - Type coercion: null/undefined/empty/"null"/"none" → null; numeric strings
 *   parsed to numbers; numbers compared with 0.001 absolute + relative
 *   tolerance; strings case-insensitive + trimmed; booleans → 0/1
 */
export function compareResultSets(
  gold: { columns: string[]; rows: Record<string, unknown>[] },
  predicted: { columns: string[]; rows: Record<string, unknown>[] },
): boolean {
  return explainMismatch(gold, predicted) === null;
}

/**
 * Compare result sets and return a human-readable reason if they don't match,
 * or null if they match. Non-breaking companion to compareResultSets.
 */
export function explainMismatch(
  gold: { columns: string[]; rows: Record<string, unknown>[] },
  predicted: { columns: string[]; rows: Record<string, unknown>[] },
): string | null {
  // Column count must match
  if (gold.columns.length !== predicted.columns.length) {
    return `Column count mismatch: gold=${gold.columns.length}, predicted=${predicted.columns.length}`;
  }

  // Row count must match
  if (gold.rows.length !== predicted.rows.length) {
    return `Row count mismatch: gold=${gold.rows.length}, predicted=${predicted.rows.length}`;
  }

  // Convert to value arrays (column-name-insensitive)
  const goldVals = gold.rows.map((r) => gold.columns.map((c) => r[c]));
  const predVals = predicted.rows.map((r) => predicted.columns.map((c) => r[c]));

  // Sort both for order-insensitive comparison
  const sortedGold = sortRows(goldVals);
  const sortedPred = sortRows(predVals);

  for (let i = 0; i < sortedGold.length; i++) {
    for (let j = 0; j < sortedGold[i].length; j++) {
      if (!valuesMatch(sortedGold[i][j], sortedPred[i][j])) {
        return `Row ${i}, col ${j}: gold=${JSON.stringify(sortedGold[i][j])}, predicted=${JSON.stringify(sortedPred[i][j])}`;
      }
    }
  }

  return null;
}
