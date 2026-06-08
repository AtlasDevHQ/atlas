/**
 * Elasticsearch Query DSL surface (#3267) — the second query surface, beside the
 * ES SQL `executeSQL` path (#3262). Three PURE, independently-testable modules,
 * no SDK / `fetch` / `@atlas/api` dependency:
 *
 *   1. Read-only DSL validator — {@link validateEsDslRequest}. A **default-deny**
 *      gate: only the read request shapes (`_search`, `_count`, `_msearch`,
 *      `_field_caps`, `_mapping`, read-only `_cat`) are allowed; every mutating /
 *      administrative shape (`_bulk`, `_update`, `_delete_by_query`,
 *      `_update_by_query`, index create/delete, mutating scripts) is rejected.
 *      Unknown endpoints are rejected, never passed through. This is the security
 *      boundary — see the adversarial deny-cases in `__tests__/dsl.test.ts`.
 *   2. Response normalizer — {@link normalizeDslResponse}. Flattens an ES
 *      `_search` response: `hits.hits[]._source` into one row per document, and
 *      the `aggregations` tree (bucket + metric aggs) into a table, into the
 *      Atlas `{ columns, rows }` shape. Also handles `_count` (`{ count }`).
 *   3. Request safeguards — {@link applyDslSafeguards}. Clamps `size`, sets a
 *      search `timeout`, and adds `terminate_after` (only when the request has no
 *      aggregations, so aggregate accuracy is preserved) to every `_search`.
 *
 * Index-whitelist enforcement (per-index, against the semantic layer) lives in
 * the tool ({@link "./tool".createQueryElasticsearchTool}) via
 * {@link validateIndexAccess}, which is kept here so it is unit-testable in
 * isolation.
 */

import type { PluginQueryResult } from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default ceiling on `size` (hits returned) for a DSL `_search`, mirroring the
 * SQL surface's auto-`LIMIT` (`ATLAS_ROW_LIMIT`, default 1000). The tool passes
 * the resolved env value; this is the fallback when none is supplied.
 */
export const DEFAULT_DSL_MAX_SIZE = 1000;

/**
 * Default `terminate_after` — the per-shard document-collection ceiling that
 * bounds a pathological full-cluster scan. Deliberately HIGH so ordinary top-N
 * and (non-aggregation) queries are unaffected; only a runaway scan trips it.
 * Applied ONLY to requests with no aggregations — `terminate_after` makes
 * aggregate results approximate, so {@link applyDslSafeguards} never adds it to
 * an aggregation request. Set `ATLAS_ES_TERMINATE_AFTER=0` to disable.
 */
export const DEFAULT_DSL_TERMINATE_AFTER = 100_000;

// ---------------------------------------------------------------------------
// Read-only DSL validator (security boundary)
// ---------------------------------------------------------------------------

/** A DSL request the validator gates: a read endpoint plus an optional body. */
export interface EsDslRequest {
  /** The operation suffix only (no index segment), e.g. `_search`, `_count`. */
  endpoint: string;
  /** The request body (Query DSL). Optional — `_search` defaults to match_all. */
  body?: unknown;
}

/**
 * Result of validating a DSL request. `reason` is user/agent-facing and is
 * always present on a failure. Shape mirrors the plugin SDK's
 * `QueryValidationResult` convention (`{ valid: boolean; reason?: string }`).
 */
export interface EsDslValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Exact read endpoints allowed. Everything else is default-denied — including
 * every write/admin endpoint (`_bulk`, `_update`, `_delete_by_query`,
 * `_update_by_query`, `_doc`, `_create`, `_reindex`, `_aliases`, `_settings`,
 * `_close`, `_open`, `_forcemerge`, `_search/scroll`, …). The `_cat` read-only
 * family is matched separately (it has sub-resources).
 *
 * This is the validator's **defense-in-depth** allow-list and is intentionally
 * BROADER than the endpoints the tool/client actually execute
 * ({@link "./connection".ElasticsearchDslEndpoint} = `_search` | `_count`). The
 * tool's input schema is the second gate that pins the executable surface, so
 * widening it later is a deliberate change — not silent drift through here.
 */
export const ES_READ_ENDPOINTS: ReadonlySet<string> = new Set([
  "_search",
  "_count",
  "_msearch",
  "_field_caps",
  "_mapping",
]);

/**
 * Painless mutation markers. `ctx` is bound only in write/update/ingest script
 * contexts (never in search/aggregation scripts), so any `ctx.<...>` / `ctx[...]`
 * in a script body signals a document-mutating script smuggled into a read
 * request. Matched case-insensitively against every string inside a `script`.
 */
const MUTATING_SCRIPT_PATTERN = /\bctx\s*[.[]/i;

/**
 * Write-action verbs that never appear at the top level of a `_search` / `_count`
 * body. Their presence there is a bulk-style write smuggled into a read body
 * (e.g. `{ "query": {…}, "delete": {…} }`). Checked at the TOP LEVEL only — a
 * field literally named `update`/`delete` nested inside a `query` is legitimate
 * and must not false-positive.
 */
const TOP_LEVEL_WRITE_KEYS: ReadonlySet<string> = new Set([
  "index",
  "create",
  "update",
  "delete",
  "delete_by_query",
  "update_by_query",
  "bulk",
]);

/** Narrow to a non-array, non-null object. Exported so the tool's truncation
 *  check shares the exact same predicate the validator/normalizer use. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `endpoint` is a read-only request shape. Strips surrounding slashes,
 * rejects anything containing path-traversal or out-of-charset characters, then
 * allows the exact read set plus the read-only `_cat` family (`_cat`,
 * `_cat/<resource>`). Anything else is denied — the default-deny posture.
 */
export function isReadEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 256) return false;
  const ep = endpoint.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  // A real read endpoint is short (`_field_caps`, `_cat/indices`); bound the
  // length so the per-segment checks below can never run on a pathological input.
  if (ep === "" || ep.length > 64) return false;

  // Split into at most two segments and validate each with a SIMPLE, anchored,
  // single-quantifier character class — no nested quantifiers (ReDoS-safe).
  // This blocks traversal (`..`), query-string smuggling (`?`), and nested index
  // paths (`flights/_doc/1`) before the allow-list check.
  const segments = ep.split("/");
  if (segments.length > 2) return false;
  const SEGMENT = /^[a-z0-9_]+$/i;
  if (!segments.every((s) => SEGMENT.test(s))) return false;

  if (segments[0] === "_cat") return true; // `_cat` or `_cat/<resource>`
  return segments.length === 1 && ES_READ_ENDPOINTS.has(ep);
}

/** Recursively test every string inside a `script` subtree for mutation markers. */
function scriptSubtreeMutates(node: unknown): boolean {
  if (typeof node === "string") return MUTATING_SCRIPT_PATTERN.test(node);
  if (Array.isArray(node)) return node.some(scriptSubtreeMutates);
  if (isPlainObject(node)) return Object.values(node).some(scriptSubtreeMutates);
  return false;
}

/**
 * Walk the whole body; when a script-bearing key is found, scan its subtree for
 * mutation markers. Returns true if any mutating script is present anywhere.
 *
 * Script-bearing keys are `script` and any `*_script` (the `scripted_metric`
 * agg's `init_script` / `map_script` / `combine_script` / `reduce_script`). The
 * full subtree under such a key is scanned, so the nested `source` / `inline`
 * script-body strings are covered — and `script_score`, a `script` agg,
 * `script_fields`, `runtime_mappings`, and `scripted_metric` all expose one of
 * these keys. Scanning is scoped to these keys (NOT every string, and NOT bare
 * `source` / `inline` fields, which collide with ordinary document fields like a
 * log `source`), so a legitimate full-text search for the literal text "ctx."
 * doesn't false-positive.
 */
function bodyHasMutatingScript(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(bodyHasMutatingScript);
  if (!isPlainObject(node)) return false;
  for (const [key, value] of Object.entries(node)) {
    const isScriptKey = key === "script" || /_script$/.test(key);
    if (isScriptKey && scriptSubtreeMutates(value)) return true;
    if (bodyHasMutatingScript(value)) return true;
  }
  return false;
}

/**
 * Detect a stored-script reference (`{ "script": { "id": "…" } }`) under any
 * script-bearing key. A stored script's body lives server-side, so it is
 * INVISIBLE to {@link bodyHasMutatingScript} — we cannot prove it read-only. From
 * a `_search` / `_count` context a script can't actually mutate documents, so
 * this is belt-and-suspenders: refuse the opaque reference rather than execute a
 * body we can't inspect. Inline read-only scripts (`script.source`) are unaffected.
 *
 * A terms LOOKUP (`{ "terms": { "<field>": { "index", "id", "path" } } }`) also
 * carries a string `id`, and its `<field>` may legitimately be named `*_script`,
 * so it would otherwise false-positive here. A real terms lookup always carries
 * BOTH `index` and `path`; a stored-script ref never does. So we treat the value
 * as a stored-script reference unless it has both lookup markers — requiring both
 * (not either) keeps an attacker from cloaking a stored-script id behind a single
 * bogus `index`/`path` key.
 */
function bodyReferencesStoredScript(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(bodyReferencesStoredScript);
  if (!isPlainObject(node)) return false;
  for (const [key, value] of Object.entries(node)) {
    const isScriptKey = key === "script" || /_script$/.test(key);
    if (
      isScriptKey &&
      isPlainObject(value) &&
      typeof value.id === "string" &&
      !("index" in value && "path" in value)
    ) {
      return true;
    }
    if (bodyReferencesStoredScript(value)) return true;
  }
  return false;
}

/**
 * Validate a Query DSL request against the read-only boundary. **Default-deny**:
 *
 *  1. Endpoint must be a known read shape ({@link isReadEndpoint}) — every
 *     write/admin/unknown endpoint is rejected.
 *  2. No mutating script anywhere in the body (`ctx._source` / `ctx.op` / `ctx[…]`).
 *  3. No top-level write-action key in an object body (a smuggled bulk write).
 *
 * Returns `{ valid: false, reason }` on the first failing check. The `reason` is
 * safe to surface to the agent/user (it carries no credential or cluster detail).
 */
export function validateEsDslRequest(request: EsDslRequest): EsDslValidationResult {
  const endpoint = typeof request?.endpoint === "string" ? request.endpoint.trim() : "";
  if (!endpoint) {
    return { valid: false, reason: "No Elasticsearch endpoint specified." };
  }
  if (!isReadEndpoint(endpoint)) {
    return {
      valid: false,
      reason: `Endpoint "${endpoint}" is not a read-only operation. Only ${[...ES_READ_ENDPOINTS].join(", ")}, and read-only _cat/* are allowed.`,
    };
  }

  const body = request.body;
  if (body !== undefined && body !== null) {
    if (bodyHasMutatingScript(body)) {
      return {
        valid: false,
        reason: "Mutating script detected in the request body — scripts that reference `ctx` are write-context and are not allowed.",
      };
    }
    if (bodyReferencesStoredScript(body)) {
      return {
        valid: false,
        reason: "Stored-script reference (`script.id`) is not allowed — its body lives server-side and can't be verified read-only. Use an inline read-only script (`script.source`) instead.",
      };
    }
    if (isPlainObject(body)) {
      for (const key of Object.keys(body)) {
        if (TOP_LEVEL_WRITE_KEYS.has(key.toLowerCase())) {
          return {
            valid: false,
            reason: `Write action "${key}" is not allowed in a read request body.`,
          };
        }
      }
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Index whitelist enforcement (used by the tool; kept here for unit testing)
// ---------------------------------------------------------------------------

/**
 * Enforce per-index access for a DSL request. ALWAYS-ON structural rails reject
 * cross-index fan-out regardless of the whitelist:
 *   - empty / missing index,
 *   - `_all` and wildcards (`*`, `?`) that are NOT an explicit whitelist member,
 *   - system / internal indices (leading `.` or `_`).
 *
 * When `allowed` is non-empty, each comma-separated index must additionally be a
 * member (case-insensitive) — the semantic-layer whitelist. A wildcard that IS a
 * member is allowed: an index-PATTERN entity (`logs-*`) is a deliberately-declared
 * logical source (#3269), so the operator has authorized exactly that fan-out.
 * When `allowed` is empty (structural-only fallback) there is no declared layer
 * to authorize a pattern, so the no-wildcard rail stays on — mirroring the
 * Salesforce tool's structural-only fallback when its object whitelist is
 * unavailable.
 */
export function validateIndexAccess(
  index: string,
  allowed: Set<string>,
): EsDslValidationResult {
  const raw = typeof index === "string" ? index.trim() : "";
  if (!raw) {
    return { valid: false, reason: "No index specified — name an index from the semantic layer." };
  }

  const segments = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { valid: false, reason: "No index specified — name an index from the semantic layer." };
  }

  const allowedLower = new Set(Array.from(allowed, (s) => s.toLowerCase()));

  for (const seg of segments) {
    // Reject path-injection / illegal characters BEFORE the
    // membership/pattern/system checks, so this validator is self-contained: its
    // safety must not depend on a downstream caller URL-encoding the segment. A
    // `/`, backslash, whitespace, control char, quote, or `< > | %` slipping
    // through (e.g. in structural-only mode, where membership isn't enforced)
    // would otherwise enable path injection if interpolated into a request path
    // unescaped. This is a DENY-list, not an ASCII allow-list: Elasticsearch
    // permits Unicode index names (e.g. CJK), so a legitimately whitelisted
    // non-ASCII index must still pass. The wildcard chars `* ?` are deliberately
    // NOT denied — they're gated by the pattern-membership rule below. Control
    // chars are matched via the Unicode `\p{Cc}` class (C0+C1+DEL) under the `u`
    // flag rather than an `\x00-\x1f` literal range, which both widens coverage
    // and avoids ESLint `no-control-regex` on a literal control escape.
    if (/[\p{Cc}/\\\s"'`<>|%]/u.test(seg)) {
      return {
        valid: false,
        reason: `Index "${seg}" contains characters that are not allowed in an index name.`,
      };
    }

    const isMember = allowedLower.has(seg.toLowerCase());

    // `_all` / wildcards fan out beyond the named index — allowed ONLY when the
    // exact token is a whitelisted PATTERN entity (#3269). `_all` can never be a
    // member (the system rail below rejects any `_`-leading name), so it always
    // falls here.
    //
    // SECURITY NOTE: membership authorizes the LITERAL pattern string (`logs-*`),
    // not a fixed set of indices. The cluster — not Atlas — expands `logs-*` at
    // query time, so a pattern entity authorizes whatever matches it *then*,
    // INCLUDING indices created after `atlas init` profiled the layer. That is the
    // intended contract: declaring a `logs-*` entity is the operator's explicit
    // authorization of that family. Operators who must NOT expose
    // future/by-pattern indices should declare concrete-index entities instead of
    // a pattern. (There is no per-query expansion check; adding one would require
    // resolving the pattern against the live cluster on every request.)
    if ((seg === "_all" || /[*?]/.test(seg)) && !isMember) {
      return {
        valid: false,
        reason: `Wildcard / _all index access ("${seg}") is not allowed. Name an explicit index or a declared index-pattern entity from the semantic layer.`,
      };
    }
    if (seg.startsWith(".") || seg.startsWith("_")) {
      return {
        valid: false,
        reason: `System / internal index "${seg}" is not queryable.`,
      };
    }
    if (allowedLower.size > 0 && !isMember) {
      return {
        valid: false,
        reason: `Index "${seg}" is not in the semantic layer. Query only indices defined by the entity YAMLs.`,
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Request safeguards
// ---------------------------------------------------------------------------

/** Resource bounds applied to a DSL request. All optional — defaults backstop. */
export interface DslSafeguardLimits {
  /** `size` ceiling for `_search`. Defaults to {@link DEFAULT_DSL_MAX_SIZE}. */
  maxSize?: number;
  /** `terminate_after` (per-shard doc ceiling). `<= 0` omits it. */
  terminateAfter?: number;
  /** Search `timeout` in ms, written into the body as `"<n>ms"`. */
  timeoutMs?: number;
}

/**
 * PURE: return a copy of `body` with resource safeguards applied. Only `_search`
 * bodies are rewritten:
 *   - `size` is clamped to `[0, maxSize]` (an explicit `size: 0` aggregation
 *     request is preserved; an omitted size defaults to `maxSize`),
 *   - `timeout` is set to `"<timeoutMs>ms"` when a positive `timeoutMs` is given,
 *   - `terminate_after` is added ONLY when the body has NO aggregations (it would
 *     make aggregate results approximate) and `terminateAfter > 0`.
 *
 * Other endpoints (`_count`, …) pass through unchanged (their wall-clock is
 * bounded by the client-side abort deadline, not a body param).
 */
export function applyDslSafeguards(
  endpoint: string,
  body: unknown,
  limits: DslSafeguardLimits = {},
): Record<string, unknown> {
  const base = isPlainObject(body) ? { ...body } : {};
  if (endpoint !== "_search") {
    return base;
  }

  const maxSize = limits.maxSize ?? DEFAULT_DSL_MAX_SIZE;
  const requested =
    typeof base.size === "number" && Number.isFinite(base.size) ? base.size : maxSize;
  // Floor so a fractional agent-supplied size can't reach ES (which rejects a
  // non-integer `size`); clamp to [0, maxSize].
  base.size = Math.max(0, Math.min(Math.floor(requested), maxSize));

  if (typeof limits.timeoutMs === "number" && limits.timeoutMs > 0) {
    base.timeout = `${Math.round(limits.timeoutMs)}ms`;
  }

  const terminateAfter = limits.terminateAfter ?? DEFAULT_DSL_TERMINATE_AFTER;
  const hasAggs = "aggs" in base || "aggregations" in base;
  if (terminateAfter > 0 && !hasAggs) {
    base.terminate_after = Math.round(terminateAfter);
  }

  return base;
}

// ---------------------------------------------------------------------------
// Response normalizer — ES _search/_count → { columns, rows }
// ---------------------------------------------------------------------------

/** One search hit (the subset the normalizer reads). */
interface EsHit {
  _id?: string;
  _score?: number | null;
  _source?: Record<string, unknown>;
}

/** Reserved keys on a bucket object that are metadata, not sub-aggregations. */
const BUCKET_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "key",
  "key_as_string",
  "doc_count",
  "from",
  "to",
  "from_as_string",
  "to_as_string",
  "doc_count_error_upper_bound",
  "sum_other_doc_count",
]);

/** Stat fields a multi-value metric agg (stats / extended_stats) exposes. */
const STAT_KEYS = [
  "count",
  "min",
  "max",
  "avg",
  "sum",
  "std_deviation",
  "variance",
  "sum_of_squares",
] as const;

type Row = Record<string, unknown>;

/**
 * PURE: flatten a nested object into dotted-path keys. Scalars and ARRAYS are
 * kept as-is (an array is a single cell value); only plain objects recurse.
 * Mirrors the dotted-path convention of the `_mapping` profiler (mapping.ts).
 */
export function flattenSource(
  source: Record<string, unknown>,
  prefix = "",
  out: Row = {},
): Row {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      flattenSource(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** Order the column union across rows by first-seen key. */
function columnsFromRows(rows: Row[], leading: string[] = []): string[] {
  const seen = new Set<string>(leading);
  const cols = [...leading];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  // Drop leading columns that never actually appear in any row.
  const present = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) present.add(k);
  return cols.filter((c) => present.has(c));
}

function flattenHits(hits: EsHit[]): PluginQueryResult {
  const rows: Row[] = hits.map((hit) => {
    const row: Row = {};
    if (hit && typeof hit._id === "string") row._id = hit._id;
    if (hit && (typeof hit._score === "number" || hit._score === null)) {
      row._score = hit._score;
    }
    if (hit && isPlainObject(hit._source)) {
      flattenSource(hit._source, "", row);
    }
    return row;
  });
  return { columns: columnsFromRows(rows, ["_id", "_score"]), rows };
}

/** A metric agg looks like `{ value }`, `{ values }`, or a stats object. */
function applyMetricAgg(row: Row, name: string, agg: Record<string, unknown>): void {
  if ("value" in agg) {
    row[name] = agg.value ?? null;
    return;
  }
  if ("values" in agg) {
    const values = agg.values;
    // percentiles keyed:true → { "50.0": x }, keyed:false → [{ key, value }]
    if (isPlainObject(values)) {
      for (const [pct, v] of Object.entries(values)) row[`${name}.${pct}`] = v ?? null;
    } else if (Array.isArray(values)) {
      for (const item of values) {
        if (isPlainObject(item) && (typeof item.key === "number" || typeof item.key === "string")) {
          row[`${name}.${item.key}`] = item.value ?? null;
        }
      }
    }
    return;
  }
  let matchedStat = false;
  for (const stat of STAT_KEYS) {
    if (stat in agg) {
      row[`${name}.${stat}`] = agg[stat] ?? null;
      matchedStat = true;
    }
  }
  if (matchedStat) return;
  // Bare single-bucket count (a `filter` agg with no sub-aggs).
  if ("doc_count" in agg) row[`${name}.doc_count`] = agg.doc_count ?? null;
}

/** Sub-aggregation entries of a bucket/single-bucket node (non-reserved keys). */
function subAggEntries(node: Record<string, unknown>): [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(node)) {
    if (BUCKET_RESERVED_KEYS.has(key)) continue;
    if (isPlainObject(value)) out.push([key, value]);
  }
  return out;
}

type AggKind = "multi-bucket" | "single-bucket" | "metric";

function classifyAgg(agg: Record<string, unknown>): AggKind {
  if ("buckets" in agg) return "multi-bucket";
  if ("doc_count" in agg && subAggEntries(agg).length > 0) return "single-bucket";
  return "metric";
}

/** Normalize an agg's `buckets` (array or keyed-object form) into a common shape. */
function normalizeBuckets(
  buckets: unknown,
): { key: unknown; doc_count: unknown; raw: Record<string, unknown> }[] {
  if (Array.isArray(buckets)) {
    return buckets.filter(isPlainObject).map((b) => ({
      key: "key_as_string" in b ? b.key_as_string : b.key,
      doc_count: b.doc_count,
      raw: b,
    }));
  }
  if (isPlainObject(buckets)) {
    return Object.entries(buckets)
      .filter(([, v]) => isPlainObject(v))
      .map(([key, v]) => ({
        key,
        doc_count: (v as Record<string, unknown>).doc_count,
        raw: v as Record<string, unknown>,
      }));
  }
  return [];
}

/**
 * Recursively flatten one level of aggregations into rows, given the columns
 * accumulated from parent buckets (`baseRow`). Metric aggs add columns to the
 * current row; bucket aggs expand it into multiple rows (cross-product across
 * sibling bucket aggs — column names disambiguate which agg each came from).
 */
function flattenAggLevel(aggs: Record<string, unknown>, baseRow: Row): Row[] {
  const row: Row = { ...baseRow };
  const expanders: { name: string; agg: Record<string, unknown>; kind: AggKind }[] = [];

  for (const [name, value] of Object.entries(aggs)) {
    if (!isPlainObject(value)) continue;
    const kind = classifyAgg(value);
    if (kind === "metric") {
      applyMetricAgg(row, name, value);
    } else {
      expanders.push({ name, agg: value, kind });
    }
  }

  if (expanders.length === 0) return [row];

  let rows: Row[] = [row];
  for (const exp of expanders) {
    const next: Row[] = [];
    for (const r of rows) next.push(...expandBucketAgg(exp.name, exp.agg, exp.kind, r));
    rows = next;
  }
  return rows;
}

function expandBucketAgg(
  name: string,
  agg: Record<string, unknown>,
  kind: AggKind,
  baseRow: Row,
): Row[] {
  if (kind === "single-bucket") {
    const r: Row = { ...baseRow, [`${name}.doc_count`]: agg.doc_count ?? null };
    const subs = Object.fromEntries(subAggEntries(agg));
    return Object.keys(subs).length === 0 ? [r] : flattenAggLevel(subs, r);
  }

  const buckets = normalizeBuckets(agg.buckets);
  const out: Row[] = [];
  for (const bucket of buckets) {
    const r: Row = {
      ...baseRow,
      [name]: bucket.key ?? null,
      [`${name}.doc_count`]: bucket.doc_count ?? null,
    };
    const subs = Object.fromEntries(subAggEntries(bucket.raw));
    if (Object.keys(subs).length === 0) out.push(r);
    else out.push(...flattenAggLevel(subs, r));
  }
  return out;
}

function flattenAggregations(aggs: Record<string, unknown>): PluginQueryResult {
  // Drop zero-key rows — they only arise from a degenerate agg that produced no
  // column at all (e.g. an empty metric object); real bucket/metric rows always
  // carry at least one key.
  const rows = flattenAggLevel(aggs, {}).filter((r) => Object.keys(r).length > 0);
  return { columns: columnsFromRows(rows), rows };
}

/**
 * PURE: normalize an Elasticsearch DSL response into Atlas `{ columns, rows }`.
 *
 * Precedence: a non-empty `aggregations` tree (the analytical result, usually
 * paired with `size: 0`) wins; otherwise `hits.hits[]` is flattened (full-text
 * search); otherwise a `_count` response (`{ count }`) becomes a one-cell table.
 * An empty / unrecognized body yields `{ columns: [], rows: [] }`.
 *
 * Side-effect free and HTTP-free so it is unit-tested in isolation — the fetch
 * lives in {@link "./connection".createElasticsearchClient}.
 */
export function normalizeDslResponse(body: unknown): PluginQueryResult {
  if (!isPlainObject(body)) return { columns: [], rows: [] };

  const aggregations = body.aggregations;
  if (isPlainObject(aggregations) && Object.keys(aggregations).length > 0) {
    return flattenAggregations(aggregations);
  }

  const hits = isPlainObject(body.hits) ? body.hits.hits : undefined;
  if (Array.isArray(hits)) {
    return flattenHits(hits as EsHit[]);
  }

  if (typeof body.count === "number") {
    return { columns: ["count"], rows: [{ count: body.count }] };
  }

  return { columns: [], rows: [] };
}
