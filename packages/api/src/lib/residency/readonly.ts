/**
 * Migration write-lock — reject write operations while a workspace is migrating.
 *
 * During cross-region data migration, the workspace enters a read-only state
 * to prevent data loss. This module provides the check function used by
 * middleware and route guards.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

/**
 * Check whether a workspace has an active (in_progress) region migration.
 *
 * Returns `true` if the workspace is currently being migrated between regions
 * and write operations should be blocked.
 */
export async function isWorkspaceMigrating(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) return false;

  const rows = await internalQuery<{ id: string }>(
    `SELECT id FROM region_migrations
     WHERE workspace_id = $1 AND status = 'in_progress'
     LIMIT 1`,
    [orgId],
  );

  return rows.length > 0;
}
