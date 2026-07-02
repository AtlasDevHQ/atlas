/**
 * Shared `knowledge_documents` read module — the ONE place that knows the row
 * shape, projection, normalizers, and content-mode gating for knowledge reads.
 *
 * Three agent-/admin-facing readers consume it (the per-mode disk mirror + the
 * system-prompt ToC in `mirror.ts`, the `searchKnowledge` tool, and the
 * `/admin/knowledge` routes). Before this module each hand-built its own SELECT,
 * row type, and timestamp/tags normalizers over the same table — a schema change
 * meant three edits and two separate real-Postgres drift tests, or silent drift.
 *
 * Mode gating: every agent-facing read goes through {@link knowledgeStatusClause}
 * (the `resolveStatusClause` SSOT — published-only outside developer mode, draft
 * overlay inside). The admin surface intentionally diverges — review is
 * mode-independent, so it filters `status <> 'archived'` instead; that
 * divergence is DECLARED here as {@link buildCollectionDocumentsQuery} rather
 * than incidentally re-derived in the route.
 */

import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { resolveStatusClause } from "@atlas/api/lib/content-mode/port";

const log = createLogger("knowledge-queries");

/** Content-mode segment key for `knowledge_documents` (see content-mode/tables.ts). */
export const KNOWLEDGE_TABLE_KEY = "knowledgeDocuments";

// The status vocabulary's single home is `./status` (#4229) — re-exported here
// so read-side consumers get row types and status types from one import.
export {
  KNOWLEDGE_DOCUMENT_STATUSES,
  narrowKnowledgeStatus,
  type KnowledgeDocumentStatus,
} from "./status";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** Raw `knowledge_documents` read-back for the shared projection
 *  ({@link knowledgeDocColumns}) — timestamptz columns come back Date|string. */
export interface KnowledgeDocRow extends Record<string, unknown> {
  id: string;
  collection_id: string;
  path: string;
  type: string | null;
  title: string | null;
  description: string | null;
  tags: unknown;
  timestamp: Date | string | null;
  resource: string | null;
  atlas_source: string | null;
  atlas_ingested_at: Date | string | null;
  status: string;
}

/** Row read with `{ body: true }` — the mirror/export path needs the content. */
export interface KnowledgeDocRowWithBody extends KnowledgeDocRow {
  body: string;
}

// ---------------------------------------------------------------------------
// Normalizers (untrusted DB read-backs → clean wire/domain values)
// ---------------------------------------------------------------------------

/**
 * Normalize a timestamptz read-back to ISO | null. Takes `unknown` because the
 * row is untrusted DB output: a `Date`, an ISO string, null, or — after a
 * hypothetical schema drift — anything. Non-date inputs normalize to null
 * rather than throwing.
 */
export function normTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * jsonb `tags` read-back → clean `string[]` (drops non-strings). pg normally
 * hands back a parsed array, but a raw JSON string (driver/config edge) is
 * parsed too; a non-JSON string is malformed provenance metadata, not
 * query-fatal — tags are display-only (never a gate), so degrade to none but
 * surface it.
 */
export function normTags(value: unknown): string[] {
  let arr: unknown = value;
  if (typeof value === "string") {
    try {
      arr = JSON.parse(value);
    } catch {
      // intentionally ignored: see docstring — malformed tags degrade to [].
      log.debug({ raw: value }, "normTags: unparseable jsonb tags — defaulting to []");
      return [];
    }
  }
  return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : [];
}

// ---------------------------------------------------------------------------
// Projection + shared SQL fragments
// ---------------------------------------------------------------------------

/**
 * The shared `knowledge_documents` projection. Every agent-facing reader
 * (mirror/ToC, search) selects the same columns in the same order so one row
 * type ({@link KnowledgeDocRow}) fits all;
 * `body` is opt-in (the mirror/export path needs it, search results don't).
 * `alias` is a fixed code-supplied table alias, never user input.
 */
export function knowledgeDocColumns(alias: string, opts?: { body?: boolean }): string {
  const a = alias;
  const cols = `${a}.id, ${a}.collection_id, ${a}.path, ${a}.type, ${a}.title, ${a}.description,
  ${a}.tags, ${a}."timestamp", ${a}.resource, ${a}.atlas_source, ${a}.atlas_ingested_at, ${a}.status`;
  return opts?.body ? `${cols}, ${a}.body` : cols;
}

/**
 * A document's effective recency — its own OKF `timestamp` frontmatter, falling
 * back to ingest time. The ordering/filter expression search and any future
 * recency consumer must share (two spellings of this coalesce would silently
 * rank differently).
 */
export function recencyExpr(alias: string): string {
  return `coalesce(${alias}."timestamp", ${alias}.atlas_ingested_at)`;
}

/**
 * The content-mode visibility clause for knowledge documents — published-only
 * outside developer mode, draft overlay inside — via the same
 * `resolveStatusClause` SSOT entities use. Built from a fixed table key + mode
 * + code-supplied alias (no user input), so it is safe to inline into query text.
 */
export function knowledgeStatusClause(mode: AtlasMode, alias: string): string {
  return resolveStatusClause(KNOWLEDGE_TABLE_KEY, mode, alias);
}

// ---------------------------------------------------------------------------
// Query builders (pure — exported so the real-Postgres test can execute the
// exact SQL against the live schema, the drift class a mocked pool can't catch)
// ---------------------------------------------------------------------------

/**
 * Build the content-mode-filtered read that feeds the disk mirror, the
 * system-prompt ToC, and the collection export — full documents (with body),
 * grouped by the caller. `collectionId` filters to a single collection (the
 * export path).
 */
export function buildCollectionsQuery(
  orgId: string,
  mode: AtlasMode,
  collectionId?: string,
): { text: string; params: unknown[] } {
  const params: unknown[] = [orgId];
  let collectionFilter = "";
  if (collectionId !== undefined) {
    params.push(collectionId);
    collectionFilter = ` AND kd.collection_id = $${params.length}`;
  }
  return {
    text: `SELECT ${knowledgeDocColumns("kd", { body: true })}
       FROM knowledge_documents kd
      WHERE kd.workspace_id = $1 AND ${knowledgeStatusClause(mode, "kd")}${collectionFilter}
      ORDER BY kd.collection_id, kd.path`,
    params,
  };
}

/** Admin documents-list row — wire-formatted timestamp, no body. */
export interface AdminDocumentRow extends Record<string, unknown> {
  id: string;
  path: string;
  title: string | null;
  description: string | null;
  type: string | null;
  tags: unknown;
  status: string;
  updated_at: string | null;
}

/**
 * The `/admin/knowledge/{slug}/documents` read. Admin review is
 * mode-independent, so this is the DECLARED divergence from
 * {@link knowledgeStatusClause}: drafts and published both list; only archived
 * documents (from a prior uninstall) are excluded.
 */
export function buildCollectionDocumentsQuery(
  orgId: string,
  collectionId: string,
): { text: string; params: unknown[] } {
  return {
    text: `SELECT id,
              path,
              title,
              description,
              type,
              tags,
              status,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
         FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = $2 AND status <> 'archived'
        ORDER BY path ASC`,
    params: [orgId, collectionId],
  };
}

/** Per-(collection, status) document counts for the admin collection list. */
export function buildDocumentStatusCountsQuery(orgId: string): {
  text: string;
  params: unknown[];
} {
  return {
    text: `SELECT collection_id, status, COUNT(*)::int AS n
           FROM knowledge_documents
          WHERE workspace_id = $1
          GROUP BY collection_id, status`,
    params: [orgId],
  };
}
