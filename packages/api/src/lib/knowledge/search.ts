/**
 * The knowledge-document STORE reader — one of the three fuzzy stores
 * `searchBrain` fuses (#4773, ADR-0036 §Retrieval).
 *
 * This is the layered search that shipped as `searchKnowledge` (#4210,
 * ADR-0028 §5) with its query builders lifted out of `lib/tools/` and into the
 * knowledge subsystem, where the other `knowledge_documents` readers already
 * live. Nothing about the SQL changed in the move; what changed is that
 * `lib/brain/search.ts` can now compose it without a tools-layer import, and
 * the projection emits a TIER-LABELED row rather than a bare document.
 *
 * Three tiers, all against the internal Postgres (`knowledge_documents` /
 * `knowledge_links`) — never the analytics datasource, the semantic whitelist,
 * metrics, or the glossary (the hard-boundary invariant, ADR-0028):
 *
 *   1. Structured frontmatter filter — `type`, `tags` (GIN-backed jsonb
 *      containment), `collection`, and a `since` recency bound.
 *   2. Lexical FTS — the stored generated `fts` tsvector (title + description +
 *      body, weighted A/B/D, GIN-indexed — migration 0167) matched with
 *      `websearch_to_tsquery` (user-friendly, never throws on arbitrary agent
 *      input) and `ts_headline` snippets, ranked by `ts_rank`.
 *   3. 1-hop graph expansion — the seed docs' neighbors via `knowledge_links`
 *      (outbound targets + inbound sources, intra-collection).
 *
 * ## Gating
 *
 * Content-mode only, through the same `resolveStatusClause` SSOT the rest of
 * Atlas uses — published-only outside developer mode, drafts overlaid inside.
 * `knowledge_links` is content-mode-exempt derived data, so expansion
 * re-applies the status clause to the NEIGHBOR document (a draft neighbor never
 * leaks into a published-mode answer).
 *
 * There is deliberately no `aclVisibilityClause` here, and the asymmetry with
 * the brain stores is worth naming: ADR-0028 documents are collection-scoped
 * workspace content with no per-row grant column to push a predicate against.
 * Adding one is a KB decision, not a retrieval one. What that means in practice
 * is that a fused page mixes rows gated on two different axes — which is why
 * the fused result carries its tier: the label IS the statement of what gated
 * the row.
 *
 * Read-only: no INSERT/UPDATE/DELETE path exists here. The SQL is fully
 * parameterized; the only interpolated fragments are the fixed-alias status
 * clause (no user input) and the FTS expressions.
 */

import type { AtlasMode } from "@useatlas/types/auth";
import type { BrainDocumentNeighbor, BrainDocumentResult } from "@useatlas/types";
import { narrowKnowledgeStatus } from "@atlas/api/lib/knowledge/status";
import {
  knowledgeDocColumns,
  knowledgeStatusClause,
  normTags,
  normTimestamp,
  recencyExpr,
  type KnowledgeDocRow,
} from "@atlas/api/lib/knowledge/queries";

/** Hard cap on distinct 1-hop neighbors returned across the whole seed set. */
export const NEIGHBOR_LIMIT = 25;

/** Normalized, validated filter set the document store operates on. */
export interface KnowledgeSearchFilters {
  /** Free-text lexical query. Absent/blank ⇒ pure structured filter, ordered by recency. */
  readonly query?: string;
  readonly type?: string;
  readonly tags?: readonly string[];
  /** Restrict to a single collection (`workspace_plugins.install_id` slug). */
  readonly collection?: string;
  /** ISO-8601 lower bound on the document's own timestamp (falls back to ingest time). */
  readonly since?: string;
  readonly limit: number;
  readonly expand: boolean;
}

/** Injected query runner — `internalQuery` in production, a fake in tests. */
export type KnowledgeQueryExec = <T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
) => Promise<T[]>;

interface DocRow extends KnowledgeDocRow {
  snippet: string | null;
  rank: number | string | null;
}

interface NeighborRow extends DocRow {
  via: unknown;
  direction: unknown;
  anchors: unknown;
}

/** Postgres text[] (or null) → `string[]`, dropping non-strings and nulls. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

/**
 * Project one row into the labeled document class.
 *
 * `tier` / `trustTier` are written HERE, at the single seam every document
 * result passes through, rather than by each caller — which is what makes an
 * unlabeled document row unconstructible in practice as well as in the type.
 */
export function toDocumentResult(row: DocRow): BrainDocumentResult {
  return {
    tier: "document",
    // Descriptive prose has no position in ADR-0036's truth ordering — see
    // `BrainResultTier`. A number here would claim it does.
    trustTier: null,
    path: row.path,
    collection: row.collection_id,
    title: row.title,
    snippet: row.snippet ?? null,
    provenance: {
      type: row.type,
      tags: normTags(row.tags),
      resource: row.resource,
      source: row.atlas_source,
      ingestedAt: normTimestamp(row.atlas_ingested_at),
      timestamp: normTimestamp(row.timestamp),
      // `status` is CHECK-constrained in `knowledge_documents` to exactly the
      // tuple's values; narrow via the vocabulary anyway (fail toward `draft` —
      // never label an unrecognized state as trusted published content).
      status: narrowKnowledgeStatus(row.status, "draft"),
    },
  };
}

/** Shared projection (lib/knowledge/queries) — same shape drives seed + neighbor mapping. */
const DOC_COLUMNS = knowledgeDocColumns("kd");

// Full-text vector over the human-readable fields (title + description + body).
// `fts` is a stored generated column (migration 0167, mirrored in db/schema.ts)
// weighted title A / description B / body D, GIN-indexed — lexical queries take
// the bitmap-index path instead of recomputing the vector per row (#4222).
const TS_VECTOR = `kd.fts`;

/**
 * Build the seed-search query. Every dynamic value is a bind parameter; the
 * only interpolated fragments are the status clause (fixed alias, no user
 * input) and the FTS expressions. Returns the SQL and its ordered params.
 */
export function buildSearchQuery(
  workspaceId: string,
  mode: AtlasMode,
  filters: KnowledgeSearchFilters,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [workspaceId];
  const where: string[] = [`kd.workspace_id = $1`, knowledgeStatusClause(mode, "kd")];

  const trimmedQuery = filters.query?.trim();
  let tsQueryExpr: string | null = null;
  if (trimmedQuery) {
    params.push(trimmedQuery);
    tsQueryExpr = `websearch_to_tsquery('english', $${params.length})`;
  }

  if (filters.type) {
    params.push(filters.type);
    where.push(`kd.type = $${params.length}`);
  }
  if (filters.collection) {
    params.push(filters.collection);
    where.push(`kd.collection_id = $${params.length}`);
  }
  if (filters.tags && filters.tags.length > 0) {
    params.push(JSON.stringify(filters.tags));
    where.push(`kd.tags @> $${params.length}::jsonb`);
  }
  if (filters.since) {
    params.push(filters.since);
    where.push(`${recencyExpr("kd")} >= $${params.length}::timestamptz`);
  }
  if (tsQueryExpr) {
    where.push(`${TS_VECTOR} @@ ${tsQueryExpr}`);
  }

  const snippetExpr = tsQueryExpr
    ? `ts_headline('english', kd.body, ${tsQueryExpr},
        'StartSel=**, StopSel=**, MaxFragments=2, MaxWords=28, MinWords=8')`
    : `NULL`;
  const rankExpr = tsQueryExpr ? `ts_rank(${TS_VECTOR}, ${tsQueryExpr})` : `NULL`;
  // Relevance first when there's a lexical query; recency is the tiebreaker
  // (and the sole order when the query is a pure structured filter).
  const orderBy = tsQueryExpr
    ? `rank DESC NULLS LAST, ${recencyExpr("kd")} DESC NULLS LAST`
    : `${recencyExpr("kd")} DESC NULLS LAST`;

  params.push(filters.limit);
  const limitPlaceholder = `$${params.length}`;

  const sql = `
    SELECT ${DOC_COLUMNS},
           ${snippetExpr} AS snippet,
           ${rankExpr} AS rank
      FROM knowledge_documents kd
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderBy}
     LIMIT ${limitPlaceholder}`;

  return { sql, params };
}

/**
 * Build the 1-hop expansion query for a set of seed document ids. Neighbors are
 * the seeds' outbound link targets AND their inbound link sources, intra-
 * collection, with the status clause re-applied to the neighbor document. Seeds
 * themselves are excluded (they're already in `results`).
 *
 * Params: `$1` workspaceId, `$2` seed id array, `$3` neighbor limit.
 */
export function buildNeighborQuery(
  workspaceId: string,
  mode: AtlasMode,
  seedIds: readonly string[],
): { sql: string; params: unknown[] } {
  const statusClause = knowledgeStatusClause(mode, "kd");
  const sql = `
    WITH seeds AS (
      SELECT id, collection_id, path
        FROM knowledge_documents
       WHERE workspace_id = $1 AND id = ANY($2::uuid[])
    ),
    edges AS (
      -- outbound: neighbor is the doc the seed links to
      SELECT tgt.id AS neighbor_id, s.path AS via, l.anchor_text AS anchor_text,
             'outbound' AS direction
        FROM seeds s
        JOIN knowledge_links l ON l.source_document_id = s.id
        JOIN knowledge_documents tgt
          ON tgt.workspace_id = $1
         AND tgt.collection_id = s.collection_id
         AND tgt.path = l.target_path
         AND tgt.id <> s.id
      UNION ALL
      -- inbound: neighbor is the doc that links to the seed
      SELECT src.id AS neighbor_id, s.path AS via, l.anchor_text AS anchor_text,
             'inbound' AS direction
        FROM seeds s
        JOIN knowledge_links l ON l.target_path = s.path
        JOIN knowledge_documents src
          ON src.id = l.source_document_id
         AND src.workspace_id = $1
         AND src.collection_id = s.collection_id
         AND src.id <> s.id
    )
    SELECT ${DOC_COLUMNS},
           NULL AS snippet,
           NULL AS rank,
           array_agg(DISTINCT e.via) AS via,
           array_agg(DISTINCT e.direction) AS direction,
           array_agg(DISTINCT e.anchor_text)
             FILTER (WHERE e.anchor_text IS NOT NULL) AS anchors
      FROM edges e
      JOIN knowledge_documents kd ON kd.id = e.neighbor_id
     WHERE ${statusClause}
       AND kd.id <> ALL($2::uuid[])
     GROUP BY ${DOC_COLUMNS}
     ORDER BY kd.path
     LIMIT $3`;

  return { sql, params: [workspaceId, [...seedIds], NEIGHBOR_LIMIT] };
}

export interface KnowledgeStoreResult {
  readonly documents: readonly BrainDocumentResult[];
  readonly neighbors: readonly BrainDocumentNeighbor[];
  /** True when the seed query returned a full page and the store may hold more. */
  readonly truncated: boolean;
}

/**
 * Run the layered document search against the injected executor.
 *
 * Pure of request context and the AI SDK, so it is directly unit-testable and
 * so the fused reader can call it with whatever handle it already holds.
 */
export async function searchKnowledgeDocuments(opts: {
  workspaceId: string;
  mode: AtlasMode;
  filters: KnowledgeSearchFilters;
  exec: KnowledgeQueryExec;
}): Promise<KnowledgeStoreResult> {
  const { workspaceId, mode, filters, exec } = opts;

  const search = buildSearchQuery(workspaceId, mode, filters);
  const seedRows = await exec<DocRow>(search.sql, search.params);
  const documents = seedRows.map(toDocumentResult);
  const truncated = seedRows.length >= filters.limit;

  if (!filters.expand || seedRows.length === 0) {
    return { documents, neighbors: [], truncated };
  }

  const seedIds = seedRows.map((r) => r.id);
  const neighbor = buildNeighborQuery(workspaceId, mode, seedIds);
  const neighborRows = await exec<NeighborRow>(neighbor.sql, neighbor.params);
  const neighbors: BrainDocumentNeighbor[] = neighborRows.map((row) => ({
    ...toDocumentResult(row),
    via: toStringArray(row.via),
    direction: toStringArray(row.direction),
    anchors: toStringArray(row.anchors),
  }));

  return { documents, neighbors, truncated };
}
