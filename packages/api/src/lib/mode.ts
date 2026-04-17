/**
 * Pure helpers for the 1.2.0 developer/published mode system.
 *
 * Kept free of auth / logger / middleware imports so low-level modules
 * (e.g. `lib/db/internal.ts`) can depend on mode semantics without
 * pulling the Hono route layer into their import graph.
 */

import type { AtlasMode } from "@useatlas/types/auth";

/**
 * Build the SQL status clause for a query over `connections`,
 * `prompt_collections`, or `query_suggestions`.
 *
 * - Published mode: `AND status = 'published'`
 * - Developer mode: `AND status IN ('published', 'draft')` — drafts overlay,
 *   archived rows always excluded
 *
 * Returns a leading-space string ready to concatenate into a WHERE clause.
 * Not used for `semantic_entities`; that table needs the full CTE overlay
 * (see `listEntitiesWithOverlay` in `lib/semantic/entities.ts`).
 */
export function buildUnionStatusClause(mode: AtlasMode | undefined): string {
  return mode === "developer"
    ? " AND status IN ('published', 'draft')"
    : " AND status = 'published'";
}
