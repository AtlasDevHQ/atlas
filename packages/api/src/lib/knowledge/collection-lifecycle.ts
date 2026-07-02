/**
 * Collection lifecycle — the archive-on-uninstall posture (ADR-0028 §5) and the
 * subtractive half of the sync diff, with ONE owner for the archive SQL.
 *
 * Documents are ARCHIVED, never hard-deleted: uninstall archives the whole
 * collection; a sync archives the paths absent from the fetched bundle. Both
 * are the same statement ({@link ARCHIVE_COLLECTION_DOCS_SQL}) — uninstall is
 * the degenerate empty except-set. Before this module the two sites each
 * carried their own UPDATE and a third caller would have written a third copy.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { withInternalTransaction } from "@atlas/api/lib/db/with-internal-transaction";
import type { IngestClient } from "./ingest";
import { invalidateKnowledgeMirror } from "./mirror-invalidation";

const log = createLogger("knowledge-lifecycle");

/**
 * The in-transaction install re-check backing the uninstall × in-flight-ingest
 * race guard (`FOR UPDATE` serializes against the uninstall's UPDATE on the
 * same row). Run by `ingestBundle` at the top of its transaction — for BOTH
 * write paths: a sync racing an uninstall must not resurrect just-archived
 * documents (#4229), and an upload racing an uninstall has the same hazard.
 * Exported for the real-Postgres test.
 */
export const INSTALL_RECHECK_SQL = `SELECT status
         FROM workspace_plugins
        WHERE workspace_id = $1 AND install_id = $2 AND pillar = 'knowledge'
        FOR UPDATE`;

/**
 * Archive every non-archived doc in a collection whose path is NOT in `$3`.
 * `$3 = '{}'` archives the whole collection (uninstall); the sync path passes
 * the fetched bundle's present set (parsed docs PLUS per-file rejections — a
 * present-but-broken file must not archive its previously-reviewed document).
 * Exported so the real-Postgres test executes this exact string against the
 * live schema.
 */
export const ARCHIVE_COLLECTION_DOCS_SQL = `UPDATE knowledge_documents
            SET status = 'archived', updated_at = NOW()
          WHERE workspace_id = $1 AND collection_id = $2 AND status <> 'archived'
            AND path <> ALL($3::text[])
          RETURNING id`;

/**
 * Archive a collection's documents, except `exceptPaths`. Runs on the caller's
 * transactional client; returns the number of documents archived.
 */
export async function archiveCollectionDocuments(
  client: IngestClient,
  workspaceId: string,
  collectionId: string,
  opts?: { exceptPaths?: readonly string[] },
): Promise<number> {
  const rows = await client.query(ARCHIVE_COLLECTION_DOCS_SQL, [
    workspaceId,
    collectionId,
    [...(opts?.exceptPaths ?? [])],
  ]);
  return rows.rows.length;
}

/**
 * Uninstall a collection: archive the install row + its documents in one
 * transaction (never hard-delete — `knowledge_links` cascade only on document
 * DELETE, so archiving leaves the graph intact; link visibility follows its
 * source document's status). Sync bookkeeping and the endpoint credential
 * (bundle-sync collections) are hard-DELETED — secrets never outlive their
 * install; both are no-op for upload collections. Invalidates the knowledge
 * mirror so archived documents drop out of both modes on the next explore call.
 */
export async function uninstallCollection(params: {
  workspaceId: string;
  collectionSlug: string;
}): Promise<{ archivedDocuments: number }> {
  const { workspaceId, collectionSlug } = params;

  const archivedDocuments = await withInternalTransaction("knowledge-uninstall", async (client) => {
    await client.query(
      `UPDATE workspace_plugins
          SET status = 'archived', enabled = false, updated_at = NOW()
        WHERE workspace_id = $1 AND install_id = $2 AND pillar = 'knowledge'`,
      [workspaceId, collectionSlug],
    );
    const archived = await archiveCollectionDocuments(client, workspaceId, collectionSlug);
    await client.query(
      `DELETE FROM knowledge_sync_credentials
        WHERE workspace_id = $1 AND collection_id = $2`,
      [workspaceId, collectionSlug],
    );
    await client.query(
      `DELETE FROM knowledge_sync_state
        WHERE workspace_id = $1 AND collection_id = $2`,
      [workspaceId, collectionSlug],
    );
    return archived;
  });

  await invalidateKnowledgeMirror(workspaceId);

  log.info({ workspaceId, collectionSlug, archivedDocuments }, "Knowledge collection uninstalled (archived)");
  return { archivedDocuments };
}
