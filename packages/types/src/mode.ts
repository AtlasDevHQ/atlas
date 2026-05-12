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
  /** Draft starter-prompt suggestions (status = 'draft'). */
  readonly starterPrompts: number;
}

/**
 * Per-surface "when was the most recent draft edited" metadata, surfaced
 * in the pending-changes pill popover (#2177). ISO-8601 timestamps so the
 * frontend can render a relative time (e.g. "5 minutes ago") without
 * parsing pg date strings.
 *
 * Keys map 1:1 to {@link ModeDraftCounts}. A null `lastEditedAt` means no
 * draft rows for that surface (or — for the legacy `entityEdits` /
 * `entityDeletes` slices that share the `semantic_entities` table — no
 * draft of that specific shape).
 */
export interface ModeDraftActivity {
  readonly connections: { readonly lastEditedAt: string | null };
  readonly entities: { readonly lastEditedAt: string | null };
  readonly entityEdits: { readonly lastEditedAt: string | null };
  readonly entityDeletes: { readonly lastEditedAt: string | null };
  readonly prompts: { readonly lastEditedAt: string | null };
  readonly starterPrompts: { readonly lastEditedAt: string | null };
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
  /**
   * Per-surface activity timestamps, populated when `hasDrafts` is true.
   * Null when there are no drafts. The pending-changes pill popover
   * renders these as relative times (e.g. "5 minutes ago").
   */
  readonly draftActivity: ModeDraftActivity | null;
}
