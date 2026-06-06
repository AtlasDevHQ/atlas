/**
 * Semantic layer — barrel export.
 *
 * Re-exports the public API from whitelist.ts (the original semantic.ts).
 * Other submodules are imported directly via their paths:
 *   - @atlas/api/lib/semantic/files   (YAML file discovery/parsing)
 *   - @atlas/api/lib/semantic/sync    (dual-write DB sync)
 *   - @atlas/api/lib/semantic/search  (pre-indexed semantic layer summary)
 *   - @atlas/api/lib/semantic/diff    (schema diffing)
 *   - @atlas/api/lib/semantic/entities (DB query helper)
 *
 * Test-only helpers (_resetPluginEntities, _resetOrgWhitelists,
 * _resetOrgSemanticIndexes) are exported from whitelist.ts directly.
 */

export {
  getWhitelistedTables,
  getCrossSourceJoins,
  registerPluginEntities,
  _resetWhitelists,
  loadOrgWhitelist,
  getOrgWhitelistedTables,
  invalidateOrgWhitelist,
  invalidateOrgSemanticIndex,
  getOrgSemanticIndex,
} from "./whitelist";
export type { CrossSourceJoin } from "./whitelist";

// The shared onboarding engine (issue #3233) is imported via its own paths —
// @atlas/api/lib/semantic/generate (mechanical) and
// @atlas/api/lib/semantic/enrich (LLM). It is intentionally NOT re-exported
// from this barrel: enrich pulls in the AI SDK + providers, and the barrel is
// imported broadly (sync, startup), so an eager re-export would force that
// heavy graph — and break providers-mocking tests — on every barrel consumer.
