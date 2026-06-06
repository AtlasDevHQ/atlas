/**
 * Normalizers for the `/api/v1/admin/semantic/metrics` response.
 *
 * The endpoint returns `{ metrics: Array<{ source, file, data }> }` where
 * `data` is the raw parsed YAML of one metric file. `data` comes in three
 * shapes (array / `{ metrics: [] }` wrapper / single object), and each entry
 * carries the Connection group it was discovered under as `source`
 * (`"default"` for the flat root, the group name for
 * `groups/<group>/metrics/<id>.yml`).
 *
 * Extracted from `page.tsx` (mirrors the `normalize-drift.ts` pattern) so the
 * single-object handling (#3276) and group attribution (#3235) are unit-
 * testable without rendering the page.
 */

export interface MetricEntry {
  name: string;
  description?: string;
  sql: string;
  entity?: string;
  type?: string;
  file?: string;
  /**
   * Connection group the metric file belongs to (#3235) — `"default"` for the
   * flat root, the group name for `groups/<group>/metrics/<id>.yml`. The
   * metrics endpoint attributes each file to its group via `source`; carried
   * onto the card so group metrics read legibly in the viewer.
   */
  source?: string;
}

/** Coerce one parsed metric object into a `MetricEntry`, or `null` if invalid. */
export function toMetricEntry(m: unknown): MetricEntry | null {
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  // YAML metrics use id/label; normalize to name.
  const name = typeof r.name === "string" ? r.name
    : typeof r.label === "string" ? r.label
    : typeof r.id === "string" ? r.id : null;
  if (!name || typeof r.sql !== "string") return null;
  return {
    name,
    description: typeof r.description === "string" ? r.description : undefined,
    sql: r.sql,
    // NB: `r.source` here is the metric file's INTERNAL `source: { entity, … }`
    // block (its derivation hint), NOT the endpoint wrapper's group `source`
    // string that `normalizeMetrics` reads below. Two different `source`s.
    entity: typeof r.entity === "string" ? r.entity
      : (r.source && typeof r.source === "object" && typeof (r.source as Record<string, unknown>).entity === "string")
        ? (r.source as Record<string, unknown>).entity as string : undefined,
    type: typeof r.type === "string" ? r.type : undefined,
  };
}

/**
 * Unwrap a metric file's parsed `data` into a list of metric objects. Three
 * shapes are recognized:
 *   1. an array of metrics — `[{ id, sql }, …]`
 *   2. a `{ metrics: [...] }` wrapper
 *   3. a single-object metric — `{ id|name|label, sql, … }` (#3276)
 *
 * The single-object case is the common generated `groups/<group>/metrics/<id>.yml`
 * shape; before #3276 it yielded `null` and was silently dropped even though
 * the backend discovered and returned it. Returns `null` when `data` is none
 * of the above so genuinely empty / malformed files stay skipped.
 */
export function metricItemsFromData(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.metrics)) return obj.metrics;
    // Single-object metric file (#3276): a top-level metric with a SQL body
    // and an id/name/label. `toMetricEntry` re-validates, so this guard only
    // has to be permissive enough to not drop a real metric.
    if (
      typeof obj.sql === "string" &&
      (typeof obj.id === "string" ||
        typeof obj.name === "string" ||
        typeof obj.label === "string")
    ) {
      return [data];
    }
  }
  return null;
}

/**
 * Flatten the metrics endpoint payload into a list of `MetricEntry`. Accepts
 * either the already-unwrapped array of entries OR the raw endpoint envelope
 * `{ metrics: [...] }`, so handing it the response body directly can never
 * silently drop every metric.
 */
export function normalizeMetrics(raw: unknown): MetricEntry[] {
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { metrics?: unknown }).metrics)
      ? (raw as { metrics: unknown[] }).metrics
      : [];
  const metrics: MetricEntry[] = [];
  for (const entry of entries) {
    const e = entry as { data: unknown; file?: string; source?: string };
    const data = e?.data;
    const fileName = typeof e?.file === "string" ? e.file : undefined;
    const source = typeof e?.source === "string" ? e.source : undefined;
    const items = metricItemsFromData(data);
    if (items) {
      for (const m of items) {
        const parsed = toMetricEntry(m);
        if (parsed) {
          // toMetricEntry never sets file/source, so the entry-level values win;
          // the `??` keeps a per-item override honest if that ever changes.
          metrics.push({
            ...parsed,
            file: parsed.file ?? fileName,
            source: parsed.source ?? source,
          });
        }
      }
    }
  }
  return metrics;
}
