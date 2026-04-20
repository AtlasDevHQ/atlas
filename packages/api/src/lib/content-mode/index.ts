/**
 * Content mode registry — single source of truth for tables that
 * participate in Atlas's developer/published mode system (#1515).
 *
 * This module is the library surface that phase 2 of #1515 migrates
 * `mode.ts` (`GET /api/v1/mode`), `admin-publish.ts`, `prompts/scoping.ts`,
 * `admin-connections.ts`, and `admin-starter-prompts.ts` onto. Phase 1
 * ships the library + tests only; no call sites yet.
 *
 * Adding a new simple content table is a one-line change to
 * `CONTENT_MODE_TABLES` in `./tables.ts`. The derived `ModeDraftCounts`
 * wire type picks up the new segment automatically via `InferDraftCounts`.
 */

export {
  ContentModeRegistry,
  ContentModeRegistryLive,
  makeService,
  type ContentModeRegistryService,
} from "./registry";

export {
  type ContentModeEntry,
  type SimpleModeTable,
  type ExoticModeAdapter,
  type PromotionReport,
  ExoticReadFilterUnavailableError,
  PublishPhaseError,
  resolveStatusClause,
  UnknownTableError,
} from "./port";

export { CONTENT_MODE_TABLES } from "./tables";
export type { InferDraftCounts } from "./infer";
