/**
 * OpenAPI Datasource primitive (v0.0.2 — REST Datasources).
 *
 * Two foundational deep modules, siblings to the SQL Datasource layer
 * (`lib/db/connection.ts`) — never folded into it (PRD #2868 "Option B").
 *
 *  - `openapi-spec` (`spec.ts`): `buildOperationGraph(doc)` — pure normalizer
 *    from an OpenAPI 3.x document to the {@link OperationGraph} (the shared
 *    shape every downstream consumer reads).
 *  - `openapi-client` (`client.ts`): `executeOperation(graph, id, params, auth)`
 *    — executes a single operation over HTTP. Transport primitive only.
 *
 *  - `openapi-paginator` (`paginator.ts` + `strategies/`): a pluggable strategy
 *    registry + driver so a multi-page response is followed transparently and
 *    the agent loop sees ONE merged result. `executeOperationPaged` (in
 *    `client.ts`) composes the primitive over it (slice 4, #2928).
 *
 * Deferred to later slices (clean extension points left in place): semantic-YAML
 * generation (1b), `validateRestOperation` (5), networkPolicy threading (3),
 * catalog/install surface (2).
 */
export { buildOperationGraph } from "./spec";
export { executeOperation, executeOperationPaged, parseRetryAfterMs } from "./client";
export type { PagedExecuteOptions } from "./client";

// Slice-1 consumers (#2924) — the prompt-context representation (Path A) and the
// sandbox-Python client preamble. Pure functions over the slice-0 graph; the
// transitional env-driven `datasource.ts` resolver imports the logger and stays
// out of this barrel (slice 2's install registry replaces it).
export {
  buildAgentRepresentation,
  REPRESENTATION_MODES,
  RepresentationNotImplementedError,
} from "./representation";
export type {
  AgentRepresentation,
  BuildRepresentationOptions,
  RepresentationMode,
} from "./representation";
export { buildRestClientPreamble } from "./python-preamble";
export type { PreambleOptions } from "./python-preamble";

export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  HTTP_METHODS,
  OpenApiClientError,
  OpenApiSpecError,
} from "./types";

export type {
  ExecuteOptions,
  HttpMethod,
  OpenApiClientErrorReason,
  OpenApiSchema,
  OpenApiSpecErrorReason,
  Operation,
  OperationGraph,
  OperationParameter,
  OperationParams,
  OperationRequestBody,
  OperationResponse,
  OperationResult,
  ParameterLocation,
  ResolvedAuth,
  SecurityScheme,
  SecuritySchemeKind,
  ServerInfo,
  SpecInfo,
} from "./types";

// Slice-1b (#2931) — the semantic-model generator (Path B of the representation
// bake-off). `representation.ts` consumes it directly for `semantic-yaml` mode;
// these re-exports let slice 2 reach the model + YAML serializations for the
// per-tenant `workspace_plugins.config.openapi_snapshot` cache.
export {
  generateSemanticModel,
  renderEntityYaml,
  renderModelYaml,
} from "./semantic-generator";
export type {
  GeneratedColumn,
  GeneratedEntity,
  GeneratedEntityOperation,
  GeneratedJoin,
  GeneratedQueryPattern,
  OpenApiSemanticModel,
  OperationKind,
} from "./semantic-generator";

// ── openapi-paginator (slice 4, #2928) ───────────────────────────────────────
// The registry + driver + page cache, and the default registry assembled from
// the four built-in strategy files. Pagination types live in `paginator.ts`
// (NOT `types.ts`) so this barrel + the slice-1b parse contract stay decoupled.
export {
  paginate,
  PaginatorRegistry,
  PaginationConfigError,
  InMemoryPageCacheStore,
  invalidateInstallCache,
  derivePageCacheKey,
  installCacheKey,
  isPageFresh,
  detectPaginationConfig,
  extractItems,
  dotGet,
  withQuery,
  PAGE_DONE,
  continueWith,
  pageError,
  PAGINATION_EXTENSION_KEY,
  DEFAULT_PAGE_CACHE_TTL_MS,
  DEFAULT_MAX_PAGES,
} from "./paginator";
export type {
  PageRequest,
  PageDecision,
  PaginationStrategy,
  PaginationStrategyFactory,
  PaginationConfig,
  PaginateOptions,
  MergedPages,
  TruncationReason,
  CachedPage,
  PageCacheStore,
  PageCacheBinding,
  PageCacheIdentity,
} from "./paginator";
export { defaultPaginatorRegistry, BUILT_IN_STRATEGIES } from "./strategies";

// ── Data candidates + vendor quirks (slice 6a, #3028) ────────────────────────
// Thin pre-wired vendor `*-data` datasource wrappers (Stripe; Notion/GitHub
// next) over the generic primitive, plus the declarative vendor-quirk descriptor
// the client applies through its header/query seams. The pattern 6b/6c extend.
export {
  DATA_CANDIDATES,
  DATA_CANDIDATE_CATALOG_IDS,
  DATA_CANDIDATE_CONFIG_SCHEMA,
  STRIPE_DATA_CANDIDATE,
  NOTION_DATA_CANDIDATE,
  findDataCandidateByCatalogId,
  findDataCandidateBySlug,
} from "./data-candidates";
export type { DataCandidate } from "./data-candidates";
export { applyQuirkHeaders, applyQuirkQueryShaping } from "./vendor-quirk";
export type { VendorQuirk, QueryParamShapeRule } from "./vendor-quirk";
export { seedDataCandidateCatalog } from "./data-candidate-seed";
export type { DataCandidateCatalogSeedResult } from "./data-candidate-seed";

// ── Shared cross-workspace spec/graph cache (#2970) ──────────────────────────
// Generalizes the per-install in-process graph cache into a cross-workspace
// cache for PUBLIC catalog specs (credential-withheld, workspace-independent):
// download + normalize once per canonical spec identity, reused by every
// workspace. Generic admin-supplied installs stay strictly per-workspace.
export {
  isShareableSpec,
  sharedGraphFromSnapshot,
  probeShared,
  refreshSharedSpecsCycle,
  invalidateSharedSpec,
  canonicalSpecKey,
  contentHashOf,
  sharedSpecCacheStats,
  __resetSharedSpecCacheForTests,
} from "./shared-spec-cache";
export type {
  SharedSpecIdentity,
  SharedSpecEntry,
  SharedProbeResult,
  SharedProbeSource,
  ProbeSharedParams,
  ConditionalProbeFn,
  RefreshCycleOptions,
  SharedRefreshCycleResult,
  SharedRefreshOutcome,
} from "./shared-spec-cache";
