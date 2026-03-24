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
