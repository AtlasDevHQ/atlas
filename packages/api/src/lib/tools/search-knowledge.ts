/**
 * `searchKnowledge` — the deferred scale-search layer over hosted OKF knowledge
 * documents (#4210, ADR-0028). Navigation (explore over the mirror) stays the
 * OKF-native primary path; this adds a layered search tool on the SAME rows the
 * ingest slice (#4207) wrote — a tool addition, not a storage change.
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
 *      (outbound targets + inbound sources, intra-collection), the context shape
 *      text-to-SQL wants.
 *
 * Content-mode: every read gates on `status` through the SAME `resolveStatusClause`
 * SSOT the rest of Atlas uses — published-only outside developer mode; developer
 * mode overlays drafts. `knowledge_links` is content-mode-exempt derived data, so
 * expansion re-applies the status clause to the NEIGHBOR document (a draft
 * neighbor never leaks into a published-mode answer).
 *
 * Read-only: no INSERT/UPDATE/DELETE path exists here. The SQL is fully
 * parameterized; the only interpolated fragments are the fixed-alias status
 * clause (no user input) and the FTS expressions.
 */

import { tool } from "ai";
import { z } from "zod";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { KNOWLEDGE_TRUST_FRAMING } from "@atlas/api/lib/knowledge/framing";
import { narrowKnowledgeStatus } from "@atlas/api/lib/knowledge/status";
import {
  knowledgeDocColumns,
  knowledgeStatusClause,
  normTags,
  normTimestamp,
  recencyExpr,
  type KnowledgeDocRow,
  type KnowledgeDocumentStatus,
} from "@atlas/api/lib/knowledge/queries";
import type { AtlasMode } from "@useatlas/types/auth";

const log = createLogger("search-knowledge");


/** Default page size when the caller omits `limit`. */
const DEFAULT_LIMIT = 10;
/** Hard cap on returned seed documents. */
const MAX_LIMIT = 50;
/** Hard cap on distinct 1-hop neighbors returned across the whole seed set. */
const NEIGHBOR_LIMIT = 25;

// ── Public shapes ────────────────────────────────────────────────────

/** Normalized, validated filter set the core operates on. */
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

/** Provenance carried on every result — where the document came from. */
export interface KnowledgeProvenance {
  readonly type: string | null;
  readonly tags: readonly string[];
  readonly resource: string | null;
  /** `atlas_source` — how the document arrived (`upload`, `bundle-sync` #4211, future connectors). */
  readonly source: string | null;
  readonly ingestedAt: string | null;
  readonly timestamp: string | null;
  /** Content-mode status: `published` normally; `draft` only surfaces in developer mode. */
  readonly status: KnowledgeDocumentStatus;
}

export interface KnowledgeSearchResult {
  readonly path: string;
  readonly collection: string;
  readonly title: string | null;
  /** `ts_headline` snippet when a lexical query ran, else null. */
  readonly snippet: string | null;
  readonly provenance: KnowledgeProvenance;
}

/** A 1-hop neighbor of one or more seed documents. */
export interface KnowledgeNeighbor extends KnowledgeSearchResult {
  /** Seed document path(s) this neighbor is linked to/from. */
  readonly via: readonly string[];
  /** `outbound` (seed → neighbor) and/or `inbound` (neighbor → seed). */
  readonly direction: readonly string[];
  /** Anchor text(s) of the connecting link(s). */
  readonly anchors: readonly string[];
}

export interface KnowledgeSearchResponse {
  readonly results: readonly KnowledgeSearchResult[];
  readonly neighbors: readonly KnowledgeNeighbor[];
}

/** Injected query runner — `internalQuery` in production, a fake in tests. */
export type KnowledgeQueryExec = <T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
) => Promise<T[]>;

// ── DB row shapes (base row + normalizers come from the shared knowledge
// read module — lib/knowledge/queries) ───────────────────────────────

interface DocRow extends KnowledgeDocRow {
  snippet: string | null;
  rank: number | string | null;
}

interface NeighborRow extends DocRow {
  via: unknown;
  direction: unknown;
  anchors: unknown;
}

// ── Normalizers ──────────────────────────────────────────────────────

/** Postgres text[] (or null) → `string[]`, dropping non-strings and nulls. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

function toResult(row: DocRow): KnowledgeSearchResult {
  return {
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

// ── Query builders (pure, unit-tested) ───────────────────────────────

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

// ── Core ─────────────────────────────────────────────────────────────

/**
 * Run the layered search against the injected executor. Pure of request context
 * and the AI SDK so it's directly unit-testable; the tool wrapper resolves the
 * workspace + mode and hands in `internalQuery`.
 */
export async function searchKnowledgeCore(opts: {
  workspaceId: string;
  mode: AtlasMode;
  filters: KnowledgeSearchFilters;
  exec: KnowledgeQueryExec;
}): Promise<KnowledgeSearchResponse> {
  const { workspaceId, mode, filters, exec } = opts;

  const search = buildSearchQuery(workspaceId, mode, filters);
  const seedRows = await exec<DocRow>(search.sql, search.params);
  const results = seedRows.map(toResult);

  if (!filters.expand || seedRows.length === 0) {
    return { results, neighbors: [] };
  }

  const seedIds = seedRows.map((r) => r.id);
  const neighbor = buildNeighborQuery(workspaceId, mode, seedIds);
  const neighborRows = await exec<NeighborRow>(neighbor.sql, neighbor.params);
  const neighbors: KnowledgeNeighbor[] = neighborRows.map((row) => ({
    ...toResult(row),
    via: toStringArray(row.via),
    direction: toStringArray(row.direction),
    anchors: toStringArray(row.anchors),
  }));

  return { results, neighbors };
}

// ── Tool definition ──────────────────────────────────────────────────

/** LLM-facing description for the `searchKnowledge` tool. */
export const SEARCH_KNOWLEDGE_TOOL_DESCRIPTION = `Search the workspace's hosted knowledge base (uploaded OKF/markdown documents) with a layered filter → full-text → 1-hop graph expansion. Combine a lexical \`query\` with structured frontmatter filters (\`type\`, \`tags\`, \`collection\`, \`since\`); each result carries \`{ path, collection, title, snippet, provenance }\` and, when \`expand\` is on (default), the linked \`neighbors\` of the matched documents. Reads published documents only (drafts surface in developer mode); every result is ${KNOWLEDGE_TRUST_FRAMING}. Example call: \`{ "query": "replica lag runbook", "tags": ["ops"] }\`. Example response: \`{ "results": [{ "path": "runbooks/eu.md", "collection": "runbooks", "title": "EU", "snippet": "...", "provenance": { "type": "Runbook", "status": "published" } }], "neighbors": [] }\`.

Use this when the user's question is about narrative/reference knowledge (runbooks, playbooks, docs, policies, glossaries) rather than tabular data, or when you need the linked context around a document. Don't use this for querying business data — that's \`executeSQL\`; and don't use it for the on-disk semantic layer — that's \`explore\`. It never touches the SQL table whitelist, metrics, or the business glossary.`;

/** Workflow-guidance block injected into the agent system prompt via `describe()`. */
export const SEARCH_KNOWLEDGE_DESCRIPTION = `### Search the Knowledge Base
Use the searchKnowledge tool to find hosted knowledge documents (uploaded OKF/markdown):
- Pass a natural-language \`query\` for full-text search; add \`type\`, \`tags\`, \`collection\`, or \`since\` to narrow by frontmatter
- Results carry provenance (\`{ path, collection, title, snippet, provenance }\`); \`neighbors\` are the 1-hop linked documents (on by default — set \`expand: false\` to skip)
- Read-only over published documents; this never reaches the SQL whitelist, metrics, or glossary
- Prefer this over \`explore\` for uploaded knowledge, and over \`executeSQL\` for narrative/reference questions`;

/** Clamp + normalize raw tool input into the validated filter set. Exported for tests. */
export function normalizeFilters(input: {
  query?: string;
  type?: string;
  tags?: string[];
  collection?: string;
  since?: string;
  limit?: number;
  expand?: boolean;
}): KnowledgeSearchFilters {
  const rawLimit = input.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));
  const tags = input.tags?.map((t) => t.trim()).filter((t) => t !== "");
  return {
    query: input.query,
    type: input.type?.trim() || undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    collection: input.collection?.trim() || undefined,
    since: input.since?.trim() || undefined,
    limit,
    expand: input.expand ?? true,
  };
}

export const searchKnowledge = tool({
  description: SEARCH_KNOWLEDGE_TOOL_DESCRIPTION,

  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe("Free-text lexical search over title, description, and body. Omit for a pure frontmatter filter (ordered by recency)."),
    type: z.string().optional().describe("Filter to one OKF document type, e.g. 'Runbook'."),
    tags: z.array(z.string()).optional().describe("Filter to documents carrying ALL of these OKF tags."),
    collection: z.string().optional().describe("Restrict to a single knowledge collection (install slug)."),
    since: z.string().optional().describe("ISO-8601 date; only documents at or after this timestamp."),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max seed documents to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
    expand: z.boolean().optional().describe("Include 1-hop linked neighbors of the matched documents (default true)."),
  }),

  execute: async (input) => {
    const reqCtx = getRequestContext();
    const workspaceId = reqCtx?.user?.activeOrganizationId;
    const mode: AtlasMode = reqCtx?.atlasMode ?? "published";

    if (!hasInternalDB()) {
      return {
        error:
          "Knowledge search is unavailable — this deployment has no internal database configured.",
      };
    }
    if (!workspaceId) {
      // The knowledge base is workspace-scoped; without a workspace there are no
      // documents to search. Return an empty result set (not an error) so the
      // agent moves on rather than retrying — but leave a log trail, since a
      // misconfigured deployment losing workspace context would otherwise be
      // indistinguishable from "no documents match".
      log.debug(
        { hasRequestContext: Boolean(reqCtx) },
        "searchKnowledge: no active workspace in request context — returning empty results",
      );
      return { results: [], neighbors: [] } satisfies KnowledgeSearchResponse;
    }

    try {
      return await searchKnowledgeCore({
        workspaceId,
        mode,
        filters: normalizeFilters(input),
        exec: internalQuery,
      });
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), workspaceId },
        "searchKnowledge failed",
      );
      return {
        error:
          "Knowledge search failed. Retry with a simpler query or fewer filters; " +
          "if it persists, the knowledge base may be temporarily unavailable.",
      };
    }
  },
});
