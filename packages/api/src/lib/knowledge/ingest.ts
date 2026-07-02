/**
 * Knowledge ingest core (#4207, ADR-0028 §5) — upsert a parsed OKF bundle into a
 * collection's `knowledge_documents` + `knowledge_links` rows, by path.
 *
 * Runs inside the caller's transaction (the admin ingest route owns
 * BEGIN/COMMIT) so an ingest is all-or-nothing and an "upload & publish" can
 * promote in the SAME transaction. The upsert-by-path + review-gate rules
 * (ADR-0028 §4):
 *   - a NEW path → INSERT at `status='draft'` (the review gate: a human sees
 *     third-party content before the non-admin agent path can);
 *   - an existing PUBLISHED doc whose content CHANGED → demoted back to `draft`
 *     (the change must be re-reviewed); an UNCHANGED published doc is left
 *     published (no needless churn, no draft-count noise);
 *   - an existing DRAFT doc → updated in place, stays draft;
 *   - an ARCHIVED doc (a prior uninstall archived it) → resurrected to `draft`
 *     on an EXPLICIT re-upload. This is not the "silent resurrect on re-install"
 *     the ADR forbids — re-install only recreates the collection row and never
 *     calls ingest; only an admin deliberately re-uploading a bundle lands here.
 *
 * Links are derived data (content-mode exempt, migration 0163): whenever a
 * document's row is (re)written, its outbound edges are deleted and re-inserted
 * from the freshly-parsed body, so the graph never drifts from the text.
 */

import type { LenientDoc } from "./parse-lenient";

/** Minimal transactional client shape (satisfied by `pg.PoolClient`). */
export interface IngestClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * How the documents arrived. v0 has only `upload` (the explicit admin bundle
 * upload). Future connector syncs (Notion/Confluence) will add sources — and,
 * per ADR-0028 §4, connector-synced content NEVER gets an "upload & publish"
 * option; it always queues for review. The publish path keys off this: only
 * `upload` may be paired with an atomic publish (enforced in the route).
 */
export type IngestSource = "upload";

export interface IngestParams {
  readonly client: IngestClient;
  readonly workspaceId: string;
  /** The owning collection = the `workspace_plugins.install_id` slug. */
  readonly collectionId: string;
  readonly source: IngestSource;
  readonly docs: readonly LenientDoc[];
}

export interface IngestReport {
  /** New documents inserted at draft. */
  readonly created: number;
  /** Existing draft documents updated in place (content changed). */
  readonly updated: number;
  /** Published documents demoted to draft because their content changed. */
  readonly demoted: number;
  /** Archived documents brought back to draft by an explicit re-upload. */
  readonly resurrected: number;
  /** Documents left exactly as they were (unchanged, already draft/published). */
  readonly unchanged: number;
  /** Total documents processed. */
  readonly documents: number;
  /** Link-graph edges (re)written across all touched documents. */
  readonly linksWritten: number;
}

/** The subset of an existing row the change comparison needs. */
interface ExistingRow {
  readonly id: string;
  readonly status: string;
  readonly body: string;
  readonly type: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly resource: string | null;
  readonly tags: unknown;
  readonly timestamp: Date | string | null;
}

/** Normalize a timestamptz read-back (Date | ISO string | null) to ISO | null. */
function normTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** True when the freshly-parsed doc differs from the stored row (any mirrored field). */
export function docChanged(existing: ExistingRow, next: LenientDoc): boolean {
  const existingTags = Array.isArray(existing.tags)
    ? existing.tags.filter((t): t is string => typeof t === "string")
    : [];
  return (
    existing.body !== next.body ||
    (existing.type ?? "") !== next.type ||
    (existing.title ?? "") !== next.title ||
    (existing.description ?? null) !== next.description ||
    (existing.resource ?? null) !== next.resource ||
    normTimestamp(existing.timestamp) !== next.timestamp ||
    JSON.stringify(existingTags) !== JSON.stringify(next.tags)
  );
}

/** Delete + re-insert a document's outbound link edges. Returns the count written. */
async function rewriteLinks(
  client: IngestClient,
  documentId: string,
  links: LenientDoc["links"],
): Promise<number> {
  await client.query(`DELETE FROM knowledge_links WHERE source_document_id = $1`, [documentId]);
  for (const link of links) {
    await client.query(
      `INSERT INTO knowledge_links (source_document_id, target_path, anchor_text)
       VALUES ($1, $2, $3)`,
      [documentId, link.targetPath, link.anchorText],
    );
  }
  return links.length;
}

/**
 * Upsert a parsed bundle into a collection. Assumes it runs inside a
 * transaction supplied by the caller (no BEGIN/COMMIT here).
 */
export async function ingestBundleIntoCollection(params: IngestParams): Promise<IngestReport> {
  const { client, workspaceId, collectionId, source, docs } = params;

  let created = 0;
  let updated = 0;
  let demoted = 0;
  let resurrected = 0;
  let unchanged = 0;
  let linksWritten = 0;

  for (const doc of docs) {
    const existingResult = await client.query<ExistingRow>(
      `SELECT id, status, body, type, title, description, resource, tags, "timestamp"
         FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = $2 AND path = $3
        LIMIT 1`,
      [workspaceId, collectionId, doc.path],
    );
    const existing = existingResult.rows[0];

    if (!existing) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO knowledge_documents
           (workspace_id, collection_id, path, type, title, description, tags,
            "timestamp", resource, body, atlas_source, atlas_ingested_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NOW(), 'draft')
         RETURNING id`,
        [
          workspaceId,
          collectionId,
          doc.path,
          doc.type,
          doc.title,
          doc.description,
          JSON.stringify(doc.tags),
          doc.timestamp,
          doc.resource,
          doc.body,
          source,
        ],
      );
      created++;
      linksWritten += await rewriteLinks(client, inserted.rows[0].id, doc.links);
      continue;
    }

    const isArchived = existing.status === "archived";
    const changed = docChanged(existing, doc);

    // An unchanged, non-archived doc is left exactly as-is — no write, no link
    // churn, no draft-count noise. (A published one stays published.)
    if (!isArchived && !changed) {
      unchanged++;
      continue;
    }

    // Every write lands the doc at `draft`: a new-content change to a published
    // doc is a demotion (re-review), a draft update stays draft, an archived doc
    // re-uploaded comes back as draft. Classify for the report before writing.
    if (isArchived) {
      resurrected++;
    } else if (existing.status === "published") {
      demoted++;
    } else {
      updated++;
    }

    await client.query(
      `UPDATE knowledge_documents
          SET type = $2, title = $3, description = $4, tags = $5::jsonb,
              "timestamp" = $6, resource = $7, body = $8,
              atlas_source = $9, atlas_ingested_at = NOW(),
              status = 'draft', updated_at = NOW()
        WHERE id = $1`,
      [
        existing.id,
        doc.type,
        doc.title,
        doc.description,
        JSON.stringify(doc.tags),
        doc.timestamp,
        doc.resource,
        doc.body,
        source,
      ],
    );
    linksWritten += await rewriteLinks(client, existing.id, doc.links);
  }

  return {
    created,
    updated,
    demoted,
    resurrected,
    unchanged,
    documents: docs.length,
    linksWritten,
  };
}
