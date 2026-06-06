/**
 * Shared mechanical generator — Phase 1 of semantic-layer onboarding.
 *
 * One engine, two callers: the CLI (`atlas init`) and the web wizard
 * (`api/routes/wizard.ts`) both analyze profiles and emit YAML through this
 * module, so "what the CLI produces" and "what the wizard produces" can never
 * drift. Pure + deterministic — no LLM, no DB access (that is the enrichment
 * phase, see ../enrich). See docs/design/semantic-onboarding.md (§ D, § F).
 *
 * Relocated from `lib/profiler.ts` (issue #3233). `lib/profiler.ts` re-exports
 * this surface for backward compatibility with existing consumers.
 */

export {
  isView,
  isMatView,
  mapSalesforceFieldType,
  inferForeignKeys,
  detectAbandonedTables,
  detectEnumInconsistency,
  detectDenormalizedTables,
  analyzeTableProfiles,
} from "./analyze";

export {
  generateEntityYAML,
  generateCatalogYAML,
  generateMetricYAML,
  generateGlossaryYAML,
} from "./yaml";
