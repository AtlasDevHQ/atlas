/**
 * Data access for `connection_group_descriptions` — per-Connection-group routing
 * descriptions feeding the agent Source catalog (ADR-0022 §4, #3894).
 *
 * Two write paths, distinguished by the `source` column:
 *   - {@link upsertAutoGroupDescription} — the auto-generated seed written at the
 *     semantic-generation seam (`/wizard/save`). Upserts only when no manual
 *     override exists, so re-profiling never clobbers an operator's edit.
 *   - {@link setManualGroupDescription} — an admin's refinement. Stamps
 *     `source = 'manual'`; an empty/blank value clears the row (reverting the
 *     catalog to the auto seed / entity-name fallback).
 *
 * One read path, {@link getGroupDescriptionMap} (catalog loader) and its row
 * form {@link listGroupDescriptions} (admin surface). All degrade to empty /
 * no-op without an internal DB so a self-hosted single-connection deploy is
 * unaffected.
 */

import { MAX_GROUP_DESCRIPTION_CHARS } from "@useatlas/schemas";
import { hasInternalDB, internalQuery } from "./internal";

/** Persisted group description with its provenance. */
export interface GroupDescriptionRow {
  readonly groupId: string;
  readonly description: string;
  readonly source: "auto" | "manual";
  readonly updatedAt: string;
}

// `MAX_GROUP_DESCRIPTION_CHARS` is the single bound shared by this write-boundary
// truncation, the admin PATCH validation, and the web editor — defined once in
// `@useatlas/schemas` (the wire SSOT) so the three can't drift.

/** List all group descriptions for an org. `[]` without an internal DB. */
export async function listGroupDescriptions(
  orgId: string,
): Promise<ReadonlyArray<GroupDescriptionRow>> {
  if (!hasInternalDB()) return [];
  const rows = await internalQuery<{
    group_id: string;
    description: string;
    source: string;
    updated_at: string;
  }>(
    `SELECT group_id, description, source, updated_at
       FROM connection_group_descriptions
      WHERE org_id = $1
      ORDER BY group_id ASC`,
    [orgId],
  );
  return rows.map((r) => ({
    groupId: r.group_id,
    description: r.description,
    // The CHECK constraint guarantees one of the two; default to 'auto' for the
    // impossible third value rather than widening the type.
    source: r.source === "manual" ? "manual" : "auto",
    updatedAt: r.updated_at,
  }));
}

/** Map of group id → description text for the catalog. Empty without an internal DB. */
export async function getGroupDescriptionMap(
  orgId: string,
): Promise<Map<string, string>> {
  const rows = await listGroupDescriptions(orgId);
  return new Map(rows.map((r) => [r.groupId, r.description]));
}

/**
 * Write the auto-generated description for a group, without clobbering a manual
 * override. The `ON CONFLICT ... WHERE source = 'auto'` guard makes the update a
 * no-op when an admin has already refined the row (the profile-then-refine
 * pattern). A blank description is a no-op (nothing to seed). No-op without an
 * internal DB.
 */
export async function upsertAutoGroupDescription(
  orgId: string,
  groupId: string,
  description: string,
): Promise<void> {
  if (!hasInternalDB()) return;
  const value = description.trim().slice(0, MAX_GROUP_DESCRIPTION_CHARS);
  if (!value) return;
  await internalQuery(
    `INSERT INTO connection_group_descriptions (org_id, group_id, description, source)
     VALUES ($1, $2, $3, 'auto')
     ON CONFLICT (org_id, group_id)
     DO UPDATE SET description = EXCLUDED.description,
                   updated_at = now()
     WHERE connection_group_descriptions.source = 'auto'`,
    [orgId, groupId, value],
  );
}

/**
 * Set (or clear) an admin-refined description for a group. A non-blank value
 * upserts with `source = 'manual'`; a blank value deletes the row, reverting the
 * catalog to the auto seed / entity-name fallback. Returns whether a row now
 * exists for the group (`false` after a clear). No-op (returns false) without an
 * internal DB.
 */
export async function setManualGroupDescription(
  orgId: string,
  groupId: string,
  description: string,
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  const value = description.trim().slice(0, MAX_GROUP_DESCRIPTION_CHARS);
  if (!value) {
    await internalQuery(
      `DELETE FROM connection_group_descriptions WHERE org_id = $1 AND group_id = $2`,
      [orgId, groupId],
    );
    return false;
  }
  await internalQuery(
    `INSERT INTO connection_group_descriptions (org_id, group_id, description, source)
     VALUES ($1, $2, $3, 'manual')
     ON CONFLICT (org_id, group_id)
     DO UPDATE SET description = EXCLUDED.description,
                   source = 'manual',
                   updated_at = now()`,
    [orgId, groupId, value],
  );
  return true;
}
