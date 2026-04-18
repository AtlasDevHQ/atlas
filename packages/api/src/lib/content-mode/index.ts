/**
 * Content mode registry — single source of truth for tables that
 * participate in Atlas's developer/published mode system (#1515).
 *
 * Callers:
 * - `admin-publish.ts` yields `ContentModeRegistry` and calls
 *   `runPublishPhases(client, orgId)` inside its existing BEGIN/COMMIT.
 * - `mode.ts` (GET /api/v1/mode) calls `countAllDrafts(orgId)`.
 * - Read handlers call `readFilter(table, mode, alias)` for a
 *   WHERE-clause fragment.
 *
 * Adding a new simple content table is a one-line change to
 * `CONTENT_MODE_TABLES` in `./tables.ts`. The derived `ModeDraftCounts`
 * wire type picks up the new segment automatically.
 */

export {
  ContentModeRegistry,
  ContentModeRegistryLive,
  type ContentModeRegistryService,
} from "./registry";

export {
  type ContentModeEntry,
  type SimpleModeTable,
  type ExoticModeAdapter,
  type PromotionReport,
  PublishPhaseError,
  UnknownTableError,
} from "./port";

export { CONTENT_MODE_TABLES } from "./tables";
export type { InferDraftCounts } from "./infer";
