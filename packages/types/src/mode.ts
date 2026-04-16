/**
 * Wire types for the developer/published mode status endpoint.
 *
 * Used by the frontend to render banners, badges, publish buttons, and
 * pending-changes summaries. Returned by `GET /api/v1/mode`.
 */

import type { AtlasMode } from "./auth";

/** Per-table draft counts surfaced in the pending-changes summary. */
export interface ModeDraftCounts {
  /** Draft connection rows (status = 'draft'). */
  readonly connections: number;
  /** All draft semantic entities for the org (status = 'draft'). */
  readonly entities: number;
  /**
   * Draft entities that supersede an existing published entity —
   * the same (org_id, name, connection_id) key has both a draft and a published row.
   */
  readonly entityEdits: number;
  /** Tombstones marking published entities for deletion (status = 'draft_delete'). */
  readonly entityDeletes: number;
  /** Draft prompt collections (status = 'draft'). */
  readonly prompts: number;
}

/**
 * Effective mode state for the current user/org.
 *
 * - `mode` is the resolved mode after the admin gate (non-admins always see `published`).
 * - `canToggle` reflects whether the user has the role to flip into developer mode.
 * - `demoIndustry` is the industry associated with the org's demo workspace, or null.
 * - `demoConnectionActive` is true iff a `__demo__` connection exists and is published.
 * - `draftCounts` is null when there are no drafts; otherwise per-table counts.
 */
export interface ModeStatusResponse {
  readonly mode: AtlasMode;
  readonly canToggle: boolean;
  readonly demoIndustry: string | null;
  readonly demoConnectionActive: boolean;
  readonly hasDrafts: boolean;
  readonly draftCounts: ModeDraftCounts | null;
}
