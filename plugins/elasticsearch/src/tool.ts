/**
 * Elasticsearch Query DSL tool (`queryElasticsearch`) for the Atlas agent (#3267).
 *
 * The second ES query surface, beside ES SQL via `executeSQL` (#3262). Use it for
 * full-text / relevance questions and deeply-nested aggregations the SQL API
 * can't express. Registered via the plugin's `initialize()` (mirroring how
 * Salesforce registers `querySalesforce`), wired to the static connection.
 *
 * The tool composes three guards before a request reaches the cluster:
 *   1. index whitelist ({@link validateIndexAccess}) — only semantic-layer
 *      indices, no wildcards / `_all` / system indices,
 *   2. read-only DSL validation ({@link validateEsDslRequest}) — default-deny,
 *   3. resource safeguards (size cap / `terminate_after` / timeout) applied in
 *      the connection client via `applyDslSafeguards`.
 * The raw response is then normalized to `{ columns, rows }`
 * ({@link normalizeDslResponse}).
 */

import { tool } from "ai";
import { z } from "zod";
import { gateOnSemanticWhitelist, type SemanticWhitelistSubject } from "@useatlas/plugin-sdk";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import type { ElasticsearchDslEndpoint, ElasticsearchDslQueryOptions } from "./connection";
import { scrubElasticsearchError, SENSITIVE_PATTERNS } from "./connection";
import { validateEsDslRequest, validateIndexAccess, normalizeDslResponse, isPlainObject } from "./dsl";

/**
 * The DSL tool's vocabulary for the SDK's semantic-whitelist load policy
 * (#3243/#3313 fail-closed / structural-only semantics live in the SDK).
 * Shared with `initialize()`'s registration-time operator warning.
 */
export const ES_DSL_WHITELIST_SUBJECT: SemanticWhitelistSubject = {
  toolName: "queryElasticsearch",
  member: "index",
  structuralExposure: "any explicitly-named, non-system index",
  queryKind: "DSL queries",
  logLabel: "ES DSL",
};

/** Parse an integer env var, falling back to `fallback` on missing/garbage. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** `size` ceiling — shares the SQL surface's row cap. */
const ROW_LIMIT = intEnv("ATLAS_ROW_LIMIT", 1000);
/** Hard wall-clock deadline per DSL request. */
const QUERY_TIMEOUT = intEnv("ATLAS_QUERY_TIMEOUT", 30000);
/** `terminate_after` per-shard doc ceiling (non-aggregation searches only). */
const TERMINATE_AFTER = intEnv("ATLAS_ES_TERMINATE_AFTER", 100000);

/** Minimal connection surface the tool depends on (decoupled from the registry). */
interface DslConnection {
  dslQuery(opts: ElasticsearchDslQueryOptions): Promise<unknown>;
}

/**
 * Whether the result was capped. Only meaningful for `_search` hit results:
 * `true` when ES reports more total matches than we returned, or we returned a
 * full page. Aggregation and `_count` results carry no hit-based truncation
 * signal, so they report `false`.
 */
function computeTruncated(
  endpoint: ElasticsearchDslEndpoint,
  raw: unknown,
  rowCount: number,
  maxSize: number,
): boolean {
  if (endpoint !== "_search" || !isPlainObject(raw)) return false;
  if (isPlainObject(raw.aggregations) && Object.keys(raw.aggregations).length > 0) return false;
  const hits = isPlainObject(raw.hits) ? raw.hits : undefined;
  const total = hits?.total;
  const totalValue =
    typeof total === "number"
      ? total
      : isPlainObject(total) && typeof total.value === "number"
        ? total.value
        : undefined;
  if (typeof totalValue === "number" && totalValue > rowCount) return true;
  return rowCount >= maxSize;
}

/**
 * Create the `queryElasticsearch` AI SDK tool.
 *
 * Takes a connection accessor and a whitelist supplier so the tool is decoupled
 * from global registries — everything is injected by the plugin's `initialize`.
 */
export function createQueryElasticsearchTool(opts: {
  getConnection: () => DslConnection;
  /** Semantic-layer index names. The SDK gate builds its own Set — pass the raw accessor result. */
  getWhitelist: () => Iterable<string>;
  logger?: PluginLogger;
}) {
  return tool({
    description: `Run a read-only Elasticsearch Query DSL request against an index. Use this for full-text / relevance search and deeply-nested aggregations that the SQL surface (executeSQL) cannot express.

When to use this instead of executeSQL:
- Full-text relevance: match / multi_match / match_phrase / query_string ranked by _score
- Nested or multi-level aggregations (terms within terms, date_histogram with sub-aggregations, percentiles, cardinality)
- Geo, span, or other DSL-only queries

Rules:
- Read the relevant entity schema from the semantic layer BEFORE writing the DSL — use exact field names.
- "index" must be a single index/alias/data-stream (or comma-separated list) from the semantic layer. Wildcards, _all, and system indices are rejected.
- Only read operations are allowed: _search (default) and _count. Writes, _bulk, _update*, _delete*, and mutating scripts are rejected.
- For aggregation-only questions set "size": 0 in the body so no documents are returned.
- The result is a flat table: hits flatten _source (plus _id/_score); aggregations flatten bucket keys, doc_counts, and metric values into columns.
- size is capped (ATLAS_ROW_LIMIT) and a request timeout is enforced. If a query fails, fix the issue — do not retry the same request.`,

    inputSchema: z.object({
      index: z
        .string()
        .describe(
          "The index, alias, or data stream to query (comma-separated for several). Must be present in the semantic layer — no wildcards or _all.",
        ),
      endpoint: z
        .enum(["_search", "_count"])
        .optional()
        .describe("The read operation. `_search` (default) for hits/aggregations, `_count` for a match count."),
      body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'The Query DSL request body, e.g. {"query": {...}} or {"size": 0, "aggs": {...}}. Omit for a match_all search.',
        ),
      explanation: z.string().describe("Brief explanation of what this query does and why."),
    }),

    execute: async ({ index, endpoint, body, explanation }) => {
      const op: ElasticsearchDslEndpoint = endpoint ?? "_search";

      // 1. Index whitelist (semantic layer) + always-on structural rails.
      // The SDK gate owns the load policy (#3243/#3313): a throwing
      // `getWhitelist` (scan failed) FAILS CLOSED with the canonical refusal;
      // a legitimately-empty layer passes through and `validateIndexAccess`
      // applies its structural-only rails.
      const gate = gateOnSemanticWhitelist(ES_DSL_WHITELIST_SUBJECT, opts.getWhitelist, opts.logger, { index });
      if (!gate.ok) {
        return { success: false, error: gate.error };
      }
      const indexCheck = validateIndexAccess(index, gate.allowed);
      if (!indexCheck.valid) {
        opts.logger?.debug({ index, error: indexCheck.reason }, "ES DSL index access rejected");
        return { success: false, error: indexCheck.reason };
      }

      // 2. Read-only DSL validation (default-deny security boundary).
      const dslCheck = validateEsDslRequest({ endpoint: op, body });
      if (!dslCheck.valid) {
        opts.logger?.debug({ endpoint: op, error: dslCheck.reason }, "ES DSL request rejected");
        return { success: false, error: dslCheck.reason };
      }

      const start = performance.now();
      try {
        const raw = await opts.getConnection().dslQuery({
          index,
          endpoint: op,
          body,
          timeoutMs: QUERY_TIMEOUT,
          maxSize: ROW_LIMIT,
          terminateAfter: TERMINATE_AFTER,
        });
        const result = normalizeDslResponse(raw);
        const durationMs = Math.round(performance.now() - start);
        const truncated = computeTruncated(op, raw, result.rows.length, ROW_LIMIT);

        opts.logger?.debug(
          { durationMs, rowCount: result.rows.length, endpoint: op },
          "ES DSL query executed",
        );

        return {
          success: true,
          explanation,
          endpoint: op,
          index,
          row_count: result.rows.length,
          columns: result.columns,
          rows: result.rows,
          truncated,
          durationMs,
        };
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        // The client already scrubs; re-scrub defensively so a thrown non-client
        // error (e.g. a programming bug) can never leak a credential either.
        const message = scrubElasticsearchError(err);
        opts.logger?.warn({ durationMs, error: message, endpoint: op }, "ES DSL query failed");

        if (SENSITIVE_PATTERNS.test(message)) {
          return {
            success: false,
            error: "Elasticsearch request failed — check server logs for details.",
          };
        }
        return { success: false, error: message };
      }
    },
  });
}
