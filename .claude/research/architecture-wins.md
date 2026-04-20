# Architecture Wins

Tracking module-deepening refactors discovered by the `improve-codebase-architecture` skill. Each entry captures the before/after state and measurable impact.

---

## 1. Extract `useAdminMutation` hook

**Date:** 2026-03-23
**Issue:** #789
**PR:** #791
**Commit:** 8989f1d

**Problem:** A 15-line mutation pattern (useState for saving/error, fetch with credentials, error body extraction, refetch on success) was duplicated across 22 admin pages. Each page independently managed `saving`, `error`, and `clearError` state, read `apiUrl`/`credentials` from context, and handled response parsing. Dialog components needed `apiUrl` and `credentials` drilled as props.

**Solution:** Extracted `useAdminMutation` hook that absorbs the full mutation lifecycle. The hook provides `mutate()`, `saving`, `error`, `clearError`, `reset()`, and `isMutating(itemId)` for per-item loading states. Reads `AtlasUIContext` internally, eliminating prop drilling.

**Impact:**
- **-704 net lines** (1,614 removed, 910 added across 23 files)
- Eliminated prop drilling of `apiUrl` and `credentials` to dialog components
- Centralized error body extraction (JSON parse with requestId)
- Fixed multiple subtle bugs found during consolidation: stale closure reads, missing error resets, `onSuccess` outside try/catch
- Every admin page now uses two hooks: `useAdminFetch` (read) + `useAdminMutation` (write)

**Category:** Tightly-coupled modules consolidated into a deep module with a small interface.

---

## 2. Create shared EE test mock factory (`createEEMock`)

**Date:** 2026-03-24
**Issue:** #836
**PR:** #849
**Commit:** 44d8a5d

**Problem:** 9 EE test files copy-pasted ~40 lines of identical mock setup for `internalQuery`, `logger`, `requireEnterprise`, `hasInternalDB`, `encryptUrl`, and `decryptUrl`. Each file independently managed mock state, captured queries, and reset logic. Mocks also threw `new Error()` instead of `new EnterpriseError()`, creating test/production divergence (#829, #832).

**Solution:** Created `ee/src/__mocks__/internal.ts` with a `createEEMock()` factory following the `createConnectionMock()` precedent. Factory returns `enterpriseMock`, `internalDBMock`, `loggerMock` + helpers (`capturedQueries`, `setMockRows()`, `setEnterpriseEnabled()`, `reset()`). Imports and re-exports the real `EnterpriseError` class so `instanceof` checks work correctly.

**Impact:**
- **-299 net lines** (875 removed, 577 added across 10 files)
- 9 test files migrated from inline mocks to shared factory
- Fixed `EnterpriseError` vs `Error` divergence in all EE test mocks
- All mocks now export `EnterpriseError` (no partial mock violations)
- Single place to maintain mock setup — new EE test files get correct patterns for free

**Category:** Test infrastructure consolidated into shared factory, eliminating copy-paste duplication.

---

## 3. Extract shared pagination parser + ID validator (`parsePagination`, `isValidId`)

**Date:** 2026-03-24
**Issue:** #838
**PR:** #851
**Commit:** a067e68

**Problem:** 24 different limit/offset parsing implementations across 11 route files with inconsistent defaults (50, 100, 200, 500). 4 copies of identical `isValidId()` function across admin routes. No shared pagination Zod schema for OpenAPI routes.

**Solution:** Added `parsePagination(c, defaults?)`, `isValidId(id)`, and `PaginationQuerySchema` to `shared-schemas.ts`. All 11 paginated routes and 4 admin ID-validation routes now use the shared utilities. Consistent default limit (50) and max (200) across the API surface.

**Impact:**
- **-89 net lines** (89 removed, 227 added — includes new test file with 146 lines)
- Consistent pagination defaults across all 11 routes
- Eliminated 4 duplicate `isValidId()` functions
- Added `PaginationQuerySchema` for OpenAPI route definitions
- New test file (`shared-schemas.test.ts`) with 146 lines of boundary tests

**Category:** Scattered inline utilities consolidated into shared module with consistent API surface.

---

## 4. Extract shared enterprise admin route error handler (`throwIfEEError`)

**Date:** 2026-03-24
**Issue:** #835
**PR:** #852
**Commit:** a067e68

**Problem:** 9 enterprise admin route files each defined a local `throwIf*Error(err)` function (~15 lines) mapping `EnterpriseError → 403` and domain-specific errors → HTTP status codes. Each file also had a local `*_ERROR_STATUS` constant. ~270 lines of near-identical boilerplate.

**Solution:** Created `ee-error-handler.ts` with `throwIfEEError(err, domainErrorClass?, statusMap?)` — a single function that handles `EnterpriseError` + any domain-specific error class with its status code mapping. All 9 admin routes replaced their local functions with one-line calls.

**Impact:**
- **-341 net lines removed, +351 added** (includes 203-line test file)
- 9 local `throwIf*Error` functions eliminated
- 9 local `*_ERROR_STATUS` constants eliminated
- Error-to-status mappings now passed as parameters, not hardcoded per file
- New test file (`ee-error-handler.test.ts`) with comprehensive coverage
- Adding a new enterprise feature route now requires zero error-handling boilerplate

**Category:** Duplicated error-handling pattern consolidated into parameterized shared function.

---

## 5. Extract shared sandbox backends (`backends/`)

**Date:** 2026-03-24
**Issue:** #839
**PR:** #859

**Problem:** Explore and Python tools each implemented 3 sandbox backends (nsjail, Vercel sandbox, sidecar) as separate files with duplicated utility functions: `readLimited()`, `parsePositiveInt()`, `sandboxErrorDetail()`, `findNsjailBinary()`, and runtime detection logic. 6 parallel backend files with shared patterns. `SandboxExecBackend` interface manually mirrored from `ExploreBackend`.

**Solution:** Extracted shared utilities into `packages/api/src/lib/tools/backends/` with `nsjail.ts`, `shared.ts`, and barrel `index.ts`. Both explore and python backends now import from the shared module. `SandboxExecBackend` became a type alias for the canonical `ExploreBackend`. Added `tools/index.ts` barrel export for the entire tools directory.

**Impact:**
- **-370 deletions, +420 additions** across 14 files (net +50 due to barrel exports and shared module structure)
- Eliminated 5 duplicated utility functions between explore and python backends
- Single source of truth for nsjail binary detection and sandbox error formatting
- `tools/index.ts` barrel export added for cleaner imports
- All 10+ existing tool tests continue to pass without modification

**Category:** Parallel backend implementations consolidated into shared utilities with barrel exports.

---

## 6. Adopt react-hook-form + shadcn Form for admin dialogs

**Date:** 2026-03-24
**Issue:** #856
**PRs:** #862 (initial + 3 pages), #863 (batch 2, 6 pages), #864 (batch 3, 5 pages), #865 (batch 1 EE, 6 pages)

**Problem:** 26 admin pages managed form state via manual `useState` per field — ~230 total useState calls across all pages. Each form dialog (~26 total) repeated: individual field state (5-17 useState per form), manual validation in handleSubmit with string checks, manual form reset on dialog close, and manual error clearing. Top offenders: connections (21 useState), prompts (17), users (16), scheduled-tasks (14).

**Solution:** Installed `react-hook-form` + `@hookform/resolvers` + shadcn `form` component. Created `FormDialog<TValues>` component combining Dialog + useForm + Zod validation with automatic reset on open, field-level errors via shadcn Form primitives, and root-level error display. Used `z.ZodType<TValues, TValues>` generic to properly satisfy zodResolver's Zod 4 overload (avoids `any` cast). Migrated all 26 admin pages across 4 parallel batches.

**Impact:**
- **+1,682 additions, -1,159 deletions** across 4 PRs (26 admin pages + FormDialog component + shadcn form component)
- Eliminated ~70% of form-related useState calls
- Zod schemas now shared between API validation and form validation
- New admin dialogs: ~40-60 LOC instead of ~150 LOC
- Field-level validation for free (vs. manual string checks in handleSubmit)
- Automatic form reset on dialog close (was manual in every dialog)
- Discovered 2 bugs during migration: useAdminMutation 204 handling (#866, #867)

**Category:** Manual form state management replaced with composable hook + component pattern, leveraging existing ecosystem (react-hook-form + Zod + shadcn).

---

## 7. Extract AdminContentWrapper for admin page rendering

**Date:** 2026-03-24
**Issue:** #857

**Problem:** 33 admin page files repeated the same ~15-line conditional rendering chain: FeatureGate check (early return for 401/403/404), ErrorBanner with retry, LoadingState spinner, EmptyState (with/without filters), and finally children. 326 total occurrences of FeatureGate/ErrorBanner/LoadingState/EmptyState across the admin. Each page independently implemented the gate check, error display, and loading/empty state cascade.

**Solution:** Created `AdminContentWrapper` component (`packages/web/src/ui/components/admin-content-wrapper.tsx`) that encapsulates the full rendering decision tree. The component accepts `loading`, `error`, `feature`, `onRetry`, `emptyIcon`, `emptyTitle`, `emptyDescription`, `emptyAction`, `hasFilters`, `onClearFilters`, `isEmpty`, and `children`. Gate errors render `FeatureGate`, non-gate errors show `ErrorBanner`, loading shows `LoadingState`, empty states render appropriately with or without filters, and data renders children.

**Impact:**
- 8 admin pages migrated: sessions, roles, scim, sso, ip-allowlist, abuse, cache, scheduled-tasks
- Eliminated 8 FeatureGate early-return blocks (~10 lines each = ~80 lines)
- Eliminated 8 error/loading/empty conditional chains (~15 lines each = ~120 lines)
- Remaining ~25 admin pages can be migrated incrementally
- New admin pages get the correct rendering chain with a single component

**Category:** Repeated conditional rendering chain consolidated into a composable wrapper component.

---

## 8. Extract createAdminRouter factory + requireOrgContext middleware

**Date:** 2026-03-24
**Issue:** #858

**Problem:** 22 admin/platform route files repeated identical 4-line router setup boilerplate (`new OpenAPIHono<AuthEnv>({ defaultHook: validationHook })` + `.use(adminAuth)` + `.use(requestContext)` + `.onError(eeOnError)`). Additionally, ~85 handlers across these files repeated ~8 lines of org context extraction (`c.get("requestId")`, `c.get("authResult")`, `hasInternalDB()` check, `activeOrganizationId` extraction + null guard). One file (`admin-onboarding-emails`) still used the legacy `adminAuthPreamble` inline pattern.

**Solution:** Created `admin-router.ts` with three exports: `createAdminRouter()` (admin routes with validationHook + adminAuth + requestContext + eeOnError), `createPlatformRouter()` (platform routes with platformAdminAuth), and `requireOrgContext()` middleware (validates hasInternalDB + extracts orgId, sets typed `orgContext` variable). Migrated all 22 route files. Legacy preamble file fully migrated to middleware pattern.

**Impact:**
- **-630 net lines** (799 removed, 169 added across 24 files including new factory + tests)
- 22 route files migrated to factory pattern
- ~85 handlers simplified from ~8-line boilerplate to single destructure: `const { requestId, orgId } = c.get("orgContext")`
- 1 legacy preamble file (`admin-onboarding-emails`) migrated to middleware pattern
- Bug fix: `admin-roles` now gets `validationHook` (was missing from constructor)
- 5 tests for requireOrgContext middleware (404 no DB, 400 no org, 200 passthrough)

**Category:** Repeated router setup and per-handler boilerplate consolidated into factory functions and typed middleware.

---

## 9. Complete AdminContentWrapper adoption

**Date:** 2026-03-25
**Issue:** #891
**PR:** #899

**Problem:** AdminContentWrapper was extracted in PR #857 to encapsulate the 4-branch rendering chain (FeatureGate → ErrorBanner → LoadingState → EmptyState → children) that every admin page implements. However, only 8 of 30 applicable admin pages used it. The remaining 22 pages still manually implemented ~15 lines of identical branching logic each, including FeatureGate early returns, error/loading/empty ternaries, and filter-aware empty states.

**Solution:** Extended AdminContentWrapper with optional `feature`, `emptyIcon`, `emptyTitle`, and `isEmpty` props to support pages without FeatureGate (dashboards), pages without empty states (forms/config), and tabbed pages where only one tab needs the full flow. Migrated all 22 remaining applicable admin pages. Two dashboard pages (overview, platform admin) intentionally not migrated — they have no FeatureGate and use custom multi-section layouts.

**Impact:**
- **-302 net lines** (803 removed, 501 added across 24 files)
- 30 of 32 admin pages now use AdminContentWrapper (8 prior + 22 new)
- Eliminated ~330 lines of duplicated gate/error/loading/empty branching
- Every admin page with a FeatureGate now uses the wrapper — impossible to forget a gate status code
- Empty state with filters ("No matches" + "Clear filters") is automatic via `hasFilters` prop

**Category:** Shallow wrapper deepened with optional props, then adopted across all applicable pages to eliminate duplicated rendering logic.

---

## 10. Extract route handler error wrapper (`withErrorHandler`)

**Date:** 2026-03-25
**Issue:** #892
**PR:** #902

**Problem:** 155 route handlers across 33 files repeated a 6-8 line try-catch pattern: type-narrow error, extract requestId, log with structured object, return `{ error: "internal_error", message: "Failed to ...", requestId }` as 500 JSON. Some handlers forgot requestId, used inconsistent narrowing, or missed the log call. For EE routes, the pattern also included `throwIfEEError()` calls with domain error mappings. Total boilerplate: ~1,000+ lines.

**Solution:** Created `withErrorHandler(label, handler, ...domainErrors)` HOF in `packages/api/src/lib/routes/error-handler.ts`. The wrapper catches unexpected errors and returns a consistent 500 response with requestId. HTTPExceptions are re-thrown (preserving framework validation and `throwIfEEError` domain error mapping). Optional domain error mappings pass through to `throwIfEEError` for EE handlers. 11 tests cover success passthrough, error catch, type narrowing, HTTPException passthrough, domain error mapping, EnterpriseError handling, and type preservation.

**Impact:**
- **-852 net lines** across 33 route files + 1 new file + 1 test file
- 155 try-catch blocks eliminated (276 → 121 remaining — the 121 are intentionally non-standard: custom error codes, nested try-catch, utility functions)
- Consistent requestId inclusion on all 500 responses
- Consistent error type narrowing across all handlers
- EE domain error mappings now declarative (rest args) instead of inline catch-block calls

**Category:** Repeated per-handler error boilerplate consolidated into a single higher-order function.

---

## 11. Extract ResultCardBase for SQL and Python result cards

**Date:** 2026-03-25
**Issue:** #897
**PR:** #899
**Commit:** b44256d

**Problem:** `sql-result-card.tsx` (~170 lines) and `python-result-card.tsx` (~250 lines) duplicated the same collapsible card shell: header with badge + title + collapse arrow, expand/collapse state, border/background styling, and error boundary wrapping. Changes to card chrome required synchronized edits in both files.

**Solution:** Extracted `ResultCardBase` component and `ResultCardErrorBoundary` class into `result-card-base.tsx`. The base component accepts `badge`, `badgeClassName`, `title`, `headerExtra`, `children`, and `defaultOpen` props. Both SQL and Python cards now render their tool-specific content inside `ResultCardBase`, eliminating duplicated shell markup. Error boundary provides consistent crash recovery with component-level logging.

**Impact:**
- **+312 net lines** (468 added, 156 removed across 4 files — includes 248-line test file)
- Unified card chrome across SQL and Python result cards
- Shared error boundary with labeled crash messages
- New card types (future: chart, notebook) get consistent shell for free
- 248-line test file covers expand/collapse, error boundary, badge rendering, headerExtra

**Category:** Duplicated card shell extracted into shared component with error boundary.

---

## 12. Extract OpenAPI schema factories for admin routes

**Date:** 2026-03-25
**Issue:** #893
**PR:** #916

**Problem:** 10+ admin route files independently defined nearly identical Zod schemas for common OpenAPI patterns: ID path parameters (`z.object({ id: z.string().min(1).max(MAX_ID_LENGTH).openapi(...) })`), list response shapes (`{ items: T[], total }` with varying field names), deleted response schemas (`{ deleted: boolean }`), and success responses. Each file imported `MAX_ID_LENGTH` and hand-rolled the same boilerplate with inconsistent `.openapi()` metadata.

**Solution:** Added factory functions to `shared-schemas.ts`: `createIdParamSchema(example?)` for `id` params, `createParamSchema(name, example?)` for custom-named params (e.g. `userId`, `collectionId`), `createListResponseSchema(fieldName, itemSchema, extra?)` for list + total patterns, `createSuccessResponseSchema()`, `createErrorResponseSchema()`, and `DeletedResponseSchema` constant. Migrated 10 admin route files to use the factories.

**Impact:**
- **-107 lines removed, +290 added** across 13 files (includes 181-line test additions)
- Net route file reduction: **-107 lines** of duplicated schema boilerplate across 10 admin files
- Consistent `MAX_ID_LENGTH` validation via factory (no direct `MAX_ID_LENGTH` imports in admin routes)
- 48 tests covering all factories (boundary cases: empty string, max length, extra fields, missing fields)

**Category:** Duplicated OpenAPI schemas consolidated into factory functions with consistent validation.

---

## 13. Extract conversation fetch client (`createAtlasFetch`)

**Date:** 2026-03-25
**Issue:** #896
**PR:** #915

**Problem:** `use-conversations.ts` (300 lines) contained 10 separate `fetch()` calls, each repeating the same pattern: build URL from `apiUrl + path`, set headers via `getHeaders()`, set credentials via `getCredentials()`, check `res.ok`, `console.warn` on failure, throw `Error` with HTTP status. Changes to error behavior, auth scheme, or request configuration required updating 10 locations.

**Solution:** Extracted `createAtlasFetch(opts)` into `packages/web/src/ui/lib/fetch-client.ts`. Returns typed `{ get, post, patch, del, raw }` methods that handle URL construction, header injection, credential wiring, error logging, and JSON parsing. The `raw` method returns the bare `Response` for callers needing custom error handling (e.g., `fetchList` with its 404/not_available checks). All 10 fetch calls in `use-conversations.ts` migrated to the client.

**Impact:**
- **-26 net lines** production code (300 → 207 in hook, +67 in new client)
- **+221 lines** test coverage (17 tests for the fetch client)
- 10 duplicated fetch patterns consolidated into 5 typed methods
- Error handling (warn + throw) defined once, not 10 times
- Dependency arrays simplified: `[opts.apiUrl, opts.getHeaders, opts.getCredentials]` → `[api]`
- `starConversation` optimistic rollback simplified from double-guard to single catch

**Category:** Duplicated fetch boilerplate extracted into typed client with shared error handling.

---

## 14. ConnectionRegistry → Effect Layer/Service (P4)

**Date:** 2026-03-25
**Issue:** #907
**PR:** #923

**Problem:** `ConnectionRegistry` was a 1,265-line global singleton with manual lifecycle management: `setInterval` for health checks, `Date.now()` arithmetic for drain cooldown, `setTimeout` for circuit breaker recovery, and manual ordering in `shutdown()` (`stopHealthChecks → close pools → clear maps`). 36+ test files used `mock.module()` to replace it. The internal DB circuit breaker (42 lines, 4 global variables) used `setTimeout` for recovery with no backoff.

**Solution:** Converted lifecycle primitives to Effect.ts:
- Health checks: `setInterval` → `Effect.repeat` + `Schedule.spaced` + `Fiber` (auto-cancelled on shutdown)
- Drain cooldown: `Date.now() - lastDrainAt < DRAIN_COOLDOWN_MS` → `Set<string>` + `Effect.sleep(Duration.millis(DRAIN_COOLDOWN_MS))`
- Circuit breaker: `setTimeout(60_000)` → `Effect.sleep(30s)` + `Effect.retry(Schedule.exponential(30s))` (5 retries, capped at 5 min)
- Shutdown: manual ordering → `Fiber.interrupt` + `Effect.addFinalizer` via `Layer.scoped`
- Defined `ConnectionRegistry` as `Context.Tag("ConnectionRegistry")` with `ConnectionRegistryShape` interface
- Live layer (`makeConnectionRegistryLive`) wraps the class with scope-managed health checks and drain cooldown
- `createTestLayer()` proxy-based helper for Layer-based test setup (replaces `mock.module`)
- `createConnectionTestLayer()` in mock factory for incremental migration

**Impact:**
- **+320 lines** new (services.ts), **+196 net lines** modified (connection.ts +50, internal.ts +63, mock +83)
- Eliminated `setInterval`, `clearInterval`, `Date.now()` arithmetic, and `setTimeout` from lifecycle management
- Circuit breaker now has exponential backoff (30s → 60s → 120s → 240s → 300s) instead of fixed 60s
- 6 new test files (26 tests) covering Effect service, Layer lifecycle, drain cooldown, bridge, health fiber, and circuit breaker
- All 166 existing API tests continue to pass (backward-compatible bridge)
- Unblocks P5–P9 (plugin lifecycle, server startup, route handlers, auth context)

**Category:** Global singleton with imperative lifecycle replaced by Effect-managed scoped service.

## 15. Route handlers → Effect boundaries (P7)

**Date:** 2026-03-25
**Issue:** #910
**PR:** #925

**Problem:** 166 route handlers across 33 files used `withErrorHandler` HOF to wrap try-catch blocks. The HOF caught errors, called `throwIfEEError` to map enterprise/domain errors to HTTP status codes, and returned 500 with requestId for unknowns. Error-to-HTTP mapping was split across three modules: `error-handler.ts` (96 lines, HOF + `DomainErrorMapping` type), `ee-error-handler.ts` (79 lines, `throwIfEEError` + `eeOnError`), and the `mapTaggedError` switch in `hono.ts`. Every route handler was wrapped in a HOF that hid the error-to-HTTP mapping.

**Solution:** Centralized all error-to-HTTP mapping in the Effect bridge (`lib/effect/hono.ts`):
- Added `classifyError` function: HTTPException passthrough → EnterpriseError → 403 → domain error mappings → AtlasError `mapTaggedError` — one function, all error categories
- Added `runHandler` convenience wrapper: `runEffect` + `Effect.tryPromise` for handlers still using async/await
- Migrated all 166 handlers from `withErrorHandler("label", async (c) => { ... })` to `async (c) => runHandler(c, "label", async () => { ... })`
- Handler bodies unchanged — same async/await, same response shapes
- Deleted `error-handler.ts` (96 lines) and its test (280 lines)
- Removed `throwIfEEError` from `ee-error-handler.ts` (kept `eeOnError` for router-level JSON error formatting)

**Impact:**
- **-437 net lines** (409 added, 846 removed across 39 files)
- Error-to-HTTP mapping consolidated from 3 modules into 1 (`classifyError` in `hono.ts`)
- `withErrorHandler` HOF eliminated (166 call sites)
- `throwIfEEError` eliminated — domain errors handled automatically by the bridge
- `error-handler.ts` + test deleted (376 lines)
- All 25 test suites pass, all 5 CI gates green
- Handler bodies unchanged — zero behavioral changes, backwards compatible

**Category:** Per-handler HOF error wrapping replaced by centralized Effect bridge with typed error classification.

---

## 16. PluginRegistry → Effect Layer/Service (P5)

**Date:** 2026-03-25
**Issue:** #908
**PR:** #926

**Problem:** `PluginRegistry` (289 lines) and plugin wiring (`wiring.ts`, 397 lines) managed a sequential init/teardown lifecycle with implicit ordering assumptions. Plugins had to init after connections, tools after plugins, etc. — but nothing enforced this at the type level. Teardown was manual LIFO with no per-plugin timeout. Health checks ran only on-demand via the admin API, not periodically.

**Solution:** Converted plugin lifecycle to Effect Layer composition:
- `PluginRegistry` as `Context.Tag("PluginRegistry")` with `PluginRegistryShape` interface
- Health checks: on-demand-only → `Effect.repeat` + `Schedule.spaced(60s)` + `Fiber` (auto-cancelled on shutdown)
- Teardown: manual LIFO → `Effect.addFinalizer` (delegates to class LIFO teardown, scope-managed)
- `makePluginRegistryLive()` wraps the class with scope-managed health checks and teardown
- `makeWiredPluginRegistryLive(config)` declares `ConnectionRegistry` as a type-level dependency — plugin datasource wiring can't happen before connections are available
- `createPluginTestLayer()` proxy-based helper for Layer-based test setup
- Shared `buildPluginService()` helper eliminates duplication between basic and wired layers
- Backward-compatible: existing `PluginRegistry` class, `plugins` singleton, and wiring functions unchanged

**Impact:**
- **+324 lines** new in services.ts (PluginRegistryShape, Tag, Live Layer, Wired Layer, test helper)
- **+8 lines** in index.ts (barrel exports)
- **+343 lines** new test file (14 tests covering service creation, teardown via finalizer, wired layer, test layer)
- Plugin health checks now run periodically (60s) instead of on-demand only
- Dependency ordering (plugins → connections) enforced at the type level via Layer composition
- All existing plugin tests (164 tests across 7 files) continue to pass unchanged
- Unblocks P6 (server startup → Effect Layer DAG)

**Category:** Plugin lifecycle with implicit ordering replaced by Effect Layer composition with type-safe dependencies.

---

## 17. Extract shared semantic entity scanner

**Date:** 2026-04-03
**Issue:** #1207
**PR:** #1211

**Problem:** Three modules in `packages/api/src/lib/semantic/` (files.ts, whitelist.ts, search.ts) each independently implemented directory traversal and YAML parsing to load entity files. `RESERVED_DIRS` was defined 5 times (3× in files.ts, 1× in whitelist.ts, 1× inline in search.ts). The scanning pattern — discover `entities/` dir, iterate per-source subdirectories, list `.yml` files, parse YAML — was duplicated in 5 functions.

**Solution:** Extracted `scanner.ts` with four shared primitives: `RESERVED_DIRS` constant, `getEntityDirs(root)` for directory discovery, `readEntityYaml(filePath)` for consistent YAML parsing, and `scanEntities(root)` for full scan returning `{ filePath, sourceName, raw }[]`. Each consumer was migrated to use the scanner and project what it needs from the raw YAML. Whitelist's Zod validation and cross-source join parsing remain in whitelist.ts since they're specific to that module.

**Impact:**
- **-170 net lines** (248 added in scanner.ts + simplified consumers, 251 removed)
- Single `RESERVED_DIRS` definition (includes `.orgs` — previously missing from files.ts copies)
- All 50+ semantic/whitelist tests pass unchanged
- `findEntityFile()` reduced from 20 lines to 5

**Category:** Three parallel implementations consolidated into a shared scanner with caller-specific projection.

---

## 18. Unified API test mock factory

**Date:** 2026-04-03
**Issue:** #1206
**PR:** #1226

**Problem:** Every API route test file (~41 files) copy-pastes 150–300 lines of identical `mock.module()` calls for ~30 modules (auth middleware, auth detect, startup, db/connection, db/internal, semantic, cache, plugins, conversations, etc.) before importing the Hono app. The existing `createConnectionMock()` proved the factory pattern works but only covered one module.

**Solution:** Created `createApiTestMocks()` in `packages/api/src/__mocks__/api-test-mocks.ts` that calls `mock.module()` for all ~30 standard modules with sensible defaults. Returns typed handles to commonly customized mocks (`mockAuthenticateRequest`, `mockInternalQuery`, `hasInternalDB` getter/setter, role helpers). Tests pass overrides for custom behavior; can also call `mock.module()` after the factory for fully custom modules.

**Impact:**
- **-1,338 net lines** (2,250 removed, 912 added including 596-line factory) across 10 migrated test files
- ~31 more test files can be migrated in follow-up work
- Module API changes (e.g. adding a new export to `db/internal`) now update in one place instead of 41
- Factory handles temp semantic directory setup/cleanup, reducing boilerplate further

**Category:** Duplicated test infrastructure consolidated into a shared factory with override API.

---

## 19. CLI command extraction Phase 1

**Date:** 2026-04-03
**Issue:** #1208
**PR:** #1225

**Problem:** `packages/cli/bin/atlas.ts` was a 4,583-line monolith containing 13 command handlers, 50+ helper functions, and duplicated DB connection testing between `init` and `diff` (~230 lines of parallel try/catch chains for MySQL, ClickHouse, Snowflake, Salesforce, PostgreSQL). Command handlers were untestable in isolation.

**Solution:** Extracted the 6 largest handlers into `packages/cli/src/commands/` (query, diff, export, learn, import, migrate-import). Created 3 shared modules in `packages/cli/lib/`: `cli-utils.ts` (getFlag, detectDBType, validateSchemaName, etc.), `output.ts` (renderTable, CSV formatting), and `test-connection.ts` (consolidated DB connection testing for all 6 DB types). Main router uses dynamic imports for code-splitting.

**Impact:**
- **-1,231 lines** from atlas.ts (4,583 → 3,352)
- Duplicated connection testing (~230 lines) consolidated into single `testDatabaseConnection()` function
- 6 command handlers independently importable and testable
- Re-exports preserve backward compatibility for all existing tests

**Category:** Monolithic CLI entry point decomposed into focused command handlers with shared utilities.

---

## 20. CLI command extraction Phase 2

**Date:** 2026-04-03
**Issue:** #1227
**PR:** #1228

**Problem:** After Phase 1, `atlas.ts` was still 3,352 lines with DB profilers (~1,000 lines), diff logic (~200 lines), plugin commands (~400 lines), init handler (~400 lines), migrate handler (~120 lines), and help system (~300 lines) all inline. `commands/diff.ts` had a circular dynamic import back to `atlas.ts` for profiler functions.

**Solution:** Extracted all remaining code into focused modules:
- `lib/profilers/` — ClickHouse, Snowflake, Salesforce, DuckDB profilers (one file per DB type + barrel export)
- `lib/diff.ts` — EntitySnapshot, parseEntityYAML, computeDiff, formatDiff
- `lib/help.ts` — SUBCOMMAND_HELP, printOverviewHelp, wantsHelp
- `src/commands/plugin.ts` — handlePlugin, scaffold templates
- `src/commands/init.ts` — handleInit, profileDatasource, demo seeding
- `src/commands/migrate.ts` — handleMigrate

**Impact:**
- **-2,970 lines** from atlas.ts (3,352 → 382)
- Combined with Phase 1: **4,583 → 382 lines (92% reduction)**
- Circular dependency (diff.ts → atlas.ts) fully eliminated
- 10 new focused modules, each independently navigable
- All re-exports for test backward compatibility preserved

**Category:** Monolithic CLI entry point fully decomposed — atlas.ts is now a thin router + re-export shim.

---

## 21. Extract shared EEError base class

**Date:** 2026-04-03
**Issue:** #1231
**PR:** #1234
**Commit:** 9cf0bf7e

**Problem:** 14 EE error class definitions across 13 files repeated the same constructor boilerplate: `extends Error`, `constructor(message, code) { super(message); this.name = "ClassName"; }`. Every EE module independently defined this pattern — RoleError, SCIMError, SSOError, SSOEnforcementError, IPAllowlistError, RetentionError, DomainError, ModelConfigError, ResidencyError, ApprovalError, ComplianceError, ReportError, BrandingError, and EnterpriseError.

**Solution:** Created `ee/src/lib/errors.ts` with an abstract `EEError<TCode extends string>` base class that handles the `message`/`code` constructor and enforces `abstract readonly name`. All 14 error classes migrated to one-liner subclasses (e.g., `export class RoleError extends EEError<RoleErrorCode> { readonly name = "RoleError"; }`). EnterpriseError uses a custom constructor for its default message.

**Impact:**
- **-49 net lines** (118 added including base class + 52-line test file, 69 removed across 15 files)
- All 14 error classes migrated to the shared base
- `instanceof` checks preserved (Error, EEError, specific subclass)
- Compile-time enforcement via `abstract readonly name`
- 6 tests covering name/code/message, instanceof chains, cross-class isolation, stack traces

**Category:** 14 duplicated error class constructors replaced by a single abstract base class.

---

## 22. Extract shared hasInternalDB guard helpers

**Date:** 2026-04-03
**Issue:** #1232
**PR:** #1233
**Commit:** b0bdd33c

**Problem:** 75 call sites across 18 EE files repeated `if (!hasInternalDB()) { ... }` with 7 different return-value patterns. The write-path guards (33 throw sites) were the most inconsistent — some threw plain `Error`, some threw domain-specific errors (DomainError, ResidencyError, ApprovalError, ReportError), and error messages varied. No shared guard helper existed.

**Solution:** Created `ee/src/lib/db-guard.ts` with `requireInternalDB(label, errorFactory?)`. Replaced all 33 write-path throw guards across 16 files with the shared helper. Domain-specific error classes preserved via optional error factory parameter. Read-path one-liners (`if (!hasInternalDB()) return []`) intentionally left as-is — they're already terse and correct.

**Impact:**
- **-63 net lines** (59 added, 122 removed across 18 files)
- 16 EE module files touched, all 434+ EE tests pass
- Consistent `"Internal database required for ${label}."` message on all write paths
- Domain errors (DomainError, ResidencyError, ApprovalError, ReportError) preserved via error factory
- 5 new tests for the guard helper

**Category:** Repetitive inline guard pattern consolidated into a shared helper with a small, typed interface.

---

## 23. Type-safe exhaustive DomainErrorMapping via `domainError()` helper

**Date:** 2026-04-04
**Issue:** #1235
**PR:** #1236
**Commit:** 9f95f8fb

**Problem:** 13 route files mapped EE domain errors to HTTP status codes via untyped `_ERROR_STATUS` Record constants. Adding a new error code to an EE error class (e.g., `ApprovalErrorCode`) produced no compile error when the route's status map was incomplete — the missing code silently fell through to a generic 500 at runtime. The `DomainErrorMapping` type was a plain tuple `[errorClass, statusMap]` with `Record<string, number>`, no exhaustiveness enforcement.

**Solution:** Created `domainError<TCode>()` generic helper that infers `TCode` from the error class's `code` property and requires `Record<TCode, ContentfulStatusCode>` — the compiler errors if any code is missing. Added `unique symbol` brand to `DomainErrorMapping` to prevent bypassing the helper with raw tuples. Migrated all 13 route files. Also: 5xx domain errors now get messages sanitized to prevent leaking infrastructure details (Railway URLs, project IDs); unmapped codes default to 500 (server bug) not 400 (client error); extracted `shared-residency.ts` for DRY residency error mapping.

**Impact:**
- **13 route files** migrated from untyped `_ERROR_STATUS` to `domainError()`
- Compile-time exhaustiveness: omitting a code from any mapping is now a type error
- Branded type prevents bypassing `domainError()` with raw tuples
- 5xx message sanitization prevents infrastructure detail leakage
- `shared-residency.ts` extracted (DRY with `shared-domains.ts` pattern)
- 57 hono bridge tests (was 54), 4 new `requireInternalDBEffect` tests

**Category:** Untyped status maps replaced with a compile-time exhaustive, branded factory function.

---

## 24. TanStack Query migration — frontend data fetching

**Date:** 2026-04-04
**Issue:** #1212
**PRs:** #1239, #1240, #1241, #1242, #1243, #1244, #1245

**Problem:** All frontend data fetching used two custom hooks (`useAdminFetch`, `useAdminMutation`) that managed loading/error state manually via `useState` + `useEffect`. No request deduplication — multiple components fetching the same endpoint made separate HTTP requests. No stale-while-revalidate, no cache-aware mutations, no window-focus refetch. Health polling in `IncidentBanner` and password status checks were duplicated across components.

**Solution:** Migrated all data fetching to TanStack Query across `packages/web` and `packages/react`. Built query key factory (`atlasKeys`) for hierarchical cache management. Replaced `useAdminFetch` → `useQuery`, `useAdminMutation` → `useMutation`. Added `QueryProvider` with devtools. Optimistic updates for conversation star/delete. Consolidated health polling into `useHealthQuery`, password checks into `usePasswordStatus`.

**Impact:**
- Automatic request deduplication across all admin pages and chat UI
- Stale-while-revalidate for snappier perceived performance
- Cache-aware mutations with automatic invalidation via `queryClient.invalidateQueries`
- Window-focus refetch replaces manual polling intervals
- Health polling consolidated into single `useHealthQuery` hook
- Password status deduplicated via shared `usePasswordStatus` hook
- Legacy `useAdminFetch` and `useAdminMutation` hooks removed
- 11 sub-issues (#1213–#1224) shipped across 7 PRs
- `@useatlas/react` fully adopted with `QueryClientProvider` + `useHealthQuery`

**Category:** Custom fetch-and-state hooks replaced with library that provides deep module behavior (caching, deduplication, lifecycle management) behind a simple `useQuery`/`useMutation` interface.

---

## 25. Consolidate starter-prompts fetch discipline into shared SDK helper

**Date:** 2026-04-17
**Issue:** #1505
**PR:** #1511

**Problem:** Two TanStack hooks — one in `packages/web/src/ui/hooks/use-starter-prompts-query.ts` (90 lines) and one in `packages/react/src/hooks/use-starter-prompts-query.ts` (83 lines) — duplicated verbatim the same starter-prompts fetch discipline: 5xx→[] soft-fail, 4xx→throw with `requestId` extraction, network-error wrapping with `cause` preservation, `Array.isArray` guard on the response body. Any bug fix in one would silently miss the other, and a PR-review pass surfaced a silent-failure bug (unwrapped `res.json()` on the 200 path that threw bare `SyntaxError` on malformed bodies) that existed in both hooks. The drift risk was compounding: #1504 had just migrated chat to one of the hooks, #1480 had added a notebook surface, and #1479 had added a widget surface — four consumers of the same policy.

**Solution:** Extracted `fetchStarterPrompts(config)` as a pure helper in `@useatlas/sdk` alongside the existing typed `atlas.getStarterPrompts()` method (which throws on all non-2xx — correct for typed-error SDK consumers; the new helper soft-fails 5xx — correct for empty-state UX). Both hooks collapsed into thin `useQuery` wrappers that only differ in how they source `apiUrl` / `credentials` / `headers` from their respective contexts. Five-agent PR review caught the `res.json()` silent-failure and an AbortError-noise issue; both fixed in the same PR before merge.

**Impact:**
- **-125 net lines in the hooks** (173 combined → 88 combined). The 82 lines added to the SDK replace policy that used to exist twice.
- **Web hook: 90 → 47 lines. React hook: 83 → 41 lines.** Both are now pure transport plumbing.
- **18 unit tests** in the SDK (up from 13 during PR review) covering 5xx soft-fail, 4xx throw with `requestId`, malformed JSON on 200, AbortError-quiet, JSON-primitive bodies, empty `statusText` fallback, `headers` default, `limit` default, credentials/headers/signal forwarding, and network-error `cause` preservation.
- **Bug fix shipped inline:** `res.json()` on 200 path now wrapped — malformed bodies soft-fail to `[]` + warn instead of throwing `SyntaxError`.
- **AbortError silencing:** React Query cancellation / component unmount no longer spams dev consoles while still propagating the abort for correct classification.
- **Single policy location** for any future starter-prompts fetch tuning (retry, auth, timeout) — both surfaces automatically inherit.
- Follows 1.2.1's shared `<StarterPromptList>` component pattern (#1480) at the data-access layer.

**Category:** Duplicated policy across sibling modules absorbed into a deep module with a narrow interface (`FetchStarterPromptsConfig` → `Promise<StarterPrompt[]>`). The asymmetry with `atlas.getStarterPrompts()` is deliberate and documented inline: two fetch surfaces serving two distinct consumer shapes.

---

## 26. ContentModeRegistry — deepen draft/published mode wiring

**Date:** 2026-04-18
**Issue:** #1515
**PRs:** #1517 (phase 1 + review fixes), #1525 (2a), #1526 (#1524 test hygiene), #1527 (2b), #1528 (2c), #1529 (2d), #1530 (2e)

**Problem:** The 1.2.0 developer/published mode system worked but was shallow. Four content tables participated — `connections`, `prompt_collections`, `query_suggestions`, `semantic_entities` — via **three different read-filter styles** (`buildUnionStatusClause()` helper, inline `statusClauseFor()` in `lib/prompts/scoping.ts`, and `listEntitiesWithOverlay()` CTE). The `/api/v1/mode` endpoint emitted a hand-written 6-branch `UNION ALL` in `routes/mode.ts`. The atomic publish endpoint (`admin-publish.ts` phases 1–3) ran four parallel UPDATEs plus `applyTombstones` + `promoteDraftEntities` inline. The `ModeDraftCounts` wire type in `@useatlas/types/mode` had to stay in lockstep with all three surfaces by hand. A contributor adding a fifth content table (the natural next step: `dashboards`) would have to coordinate edits across 6+ files with no compile-time enforcement — a well-intentioned omission of the publish UPDATE would leave orphan drafts forever. CLAUDE.md's Content Mode System section documented the contract as prose; nothing enforced it.

**Solution:** Introduced `packages/api/src/lib/content-mode/` — a static `as const satisfies ReadonlyArray<ContentModeEntry>` tuple (`tables.ts`) paired with a compile-time `InferDraftCounts<T>` mapped type (`infer.ts`) that derives the exact shape of `ModeDraftCounts` from the tuple. A discriminated `SimpleModeTable` | `ExoticModeAdapter` port captures the split: three of the four existing tables are "simple" (one status column, default UPDATE + COUNT), `semantic_entities` is "exotic" because of its tombstones and overlay CTE. The Effect `ContentModeRegistry` service (`registry.ts`) exposes three methods — `readFilter(table, mode, alias)`, `countAllDrafts(orgId)`, `runPublishPhases(tx, orgId)` — that every caller migrates onto in phase 2. Phase 1 (#1517) shipped the library + tests only. Phase 2 migrated each caller in its own PR — `mode.ts` (#1525), `prompts/scoping.ts` (#1527), `admin-connections.ts` (#1528), the real `semantic_entities` adapter (#1529), and finally `admin-publish.ts` (#1530). An incidental cross-cutting test-mock hygiene PR (#1526) added `MockInternalDB` + `makeMockInternalDBShimLayer` to the shared factory so any route that transitively loads `content-mode` doesn't break tests that partially mock `lib/db/internal`.

**Impact:**
- **One-line change to add a new mode-participating table.** `{ kind: "simple", key: "dashboards" }` at the end of `CONTENT_MODE_TABLES` automatically extends `ModeDraftCounts`, the `/api/v1/mode` response, the publish transaction, and any read handler calling `registry.readFilter("dashboards", ...)`. No `admin-publish.ts` edit. No `mode.ts` edit. No `@useatlas/types/mode.ts` edit.
- **Compile-time drift detection.** An `Equal<ModeDraftCounts, InferDraftCounts<typeof CONTENT_MODE_TABLES>>` assertion in the test suite fails at CI time if anyone adds a key to one side without the other. Exhaustiveness on `kind` is enforced via `assertNever(entry)` at every `switch` site — a new variant fails to compile.
- **Phase 1 review hardened the library.** The five-agent review caught a silent `semantic_entities` `readFilter` fallthrough (now `ExoticReadFilterUnavailableError`), a silent-success stub that would have let `{ promoted: 0 }` reach production under a premature wiring (now fails loudly), and silent `Number(n) || 0` masking in `countAllDrafts` (now fails on NaN / negative / unknown-key rows with `PublishPhaseError`). Three bare `else` branches became exhaustive switches. Duplicate-key guards run at `makeService` construction.
- **`PublishPhaseError` / `UnknownTableError` / `ExoticReadFilterUnavailableError`** fold into `AtlasError` union + `ATLAS_ERROR_TAG_LIST` + `mapTaggedError`. The "count" phase gets a neutral message (`"Failed to count pending drafts"`) so read-endpoint failures don't surface publish-workflow language.
- **Line counts:** library + phase 1 review fixes = ~800 lines added under `content-mode/` + ~135 test lines. Phase 2 migrations net `-200`+ lines by collapsing hand-written SQL: `mode.ts` dropped `DRAFT_COUNTS_SQL` + `rowsToCounts` + `ZERO_COUNTS` constants (~60 lines); `admin-publish.ts` collapsed four inline UPDATEs + two helper calls into one `runPublishPhases` call.
- **Test coverage:** 21 registry boundary tests (`__tests__/registry.test.ts`) + 4 adapter boundary tests (`adapters/__tests__/semantic-entities.test.ts`). The registry test mounts throwaway tuples via `makeService(tables)` to exercise exotic-`readFilter` dispatch and failing-exotic-adapter paths the production tuple doesn't currently hit.
- **Last remaining caller** — `getPopularSuggestions` in `lib/db/internal.ts` — tracked in #1531. It can't import `content-mode` directly because of a circular-import risk (`content-mode/registry` imports `InternalDB` from `internal.ts`). Resolution options documented in the issue.

**Category:** Textbook module deepening — a set of shallow, parallel policies (three read-filter styles, hand-written `UNION ALL`, four hand-written UPDATEs) consolidated into a deep module with a narrow three-method interface. The single source of truth is the static tuple; the wire type is derived from it; every caller reads the same dispatch logic. Adding a new participating table exercises the narrow interface once instead of six times.

---

## 27. Queue/moderation primitives — `@/ui/components/admin/queue/`

**Date:** 2026-04-19
**Issue:** #1596
**PR:** #1600
**Tracker:** #1588 (bucket-1)

**Problem:** Three admin queue/moderation pages — `/admin/actions` (PR #1592), `/admin/learned-patterns` (PR #1594), `/admin/approval` (this PR) — had independently grown the same vocabulary: button-row filter chips with inline bulk-action bar, short relative-timestamp with absolute tooltip, compliance-grade reason-on-deny dialog, optimistic single-row update with revert-on-failure, and summarizers for the two bulk-result shapes (client fan-out via `Promise.allSettled` and server partial-success `{ updated, notFound, errors? }`). PR #1592 shipped the pattern with `DenyActionDialog` + local helpers; PR #1594 re-implemented the same helpers because it needed the partial-success shape; PR #1600 would have been the third to copy the dialog, the timestamp, the filter row, and the optimistic-revert hook. Classic #1551 extract-on-3rd-adopter territory.

**Solution:** Landed the `/admin/approval` structural revamp alongside the extraction. New module `packages/web/src/ui/components/admin/queue/`:

- `QueueFilterRow<T>` — status chips with `aria-pressed` + optional `trailing` slot (callers own their bulk-action UI).
- `RelativeTimestamp` — short Intl.RelativeTimeFormat label with absolute `<time dateTime>` tooltip.
- `ReasonDialog` — generalized from `DenyActionDialog`; takes `title` / `context` / `confirmLabel` / `required`. **Never substitutes a hardcoded placeholder reason** — the audit log receives exactly what the operator typed (whitespace-trimmed), including the empty string. Regression test `reason-dialog.test.tsx` pins the compliance contract the hardcode-bug closure in PR #1592 had no test for.
- `useQueueRow<Row>({ rows, setRows, getId })` — optimistic single-row update with revert-on-failure. Snapshots `original` synchronously from a rows-ref **before** calling `setRows` because React defers setState updaters past `await` boundaries under test `act()` batching (reading `prev.find(...)` inside the updater leaves `original === undefined` in tests). Safe for single-row because callers gate concurrent actions via `inProgress.has(id)`. When the row is absent at mutation time (refetched away), emits a `console.debug` instead of silently no-opping so the operator's stuck optimistic state is at least traceable.
- `bulkFailureSummary` / `bulkPartialSummary` / `failedIdsFrom` — pure helpers.

**Impact:**
- **+1055 net lines** (1808 added, 753 removed across 14 files). The new module is ~470 lines; the back-migrations netted `-150`+ lines across the two sibling pages (removed two copies of `RelativeTimestamp`, two copies of the bulk summarizer helpers, one copy of the dialog and the relevant formatters). The rest is the structural /admin/approval rewrite (+540 lines replacing a Tabs-as-pages + always-visible review form with CompactRow inline-expand + QueueFilterRow + bulk + ReasonDialog) and new tests.
- **Four-agent review found 6 HIGH-severity issues that would have shipped otherwise** — fix commit addressed them all:
  - Shared `reviewMutation` between approve+deny leaked the approve error into the deny-dialog open on a later row (code-reviewer #1); split into two mutations.
  - `FetchError` was being flattened to a string and losing `status` / `code` for `friendlyError` branching (silent-failure-hunter #3); now stored typed and rendered via `friendlyError`.
  - `useQueueRow` silently no-opped on `original === undefined` (silent-failure-hunter #1); now logs a debug message.
  - No `invalidates` on approve/deny mutations meant a failure left stale optimistic state with no refetch (silent-failure-hunter #6); now wired on both mutations.
  - Missing compliance-contract tests for `ReasonDialog` (test-analyzer #1); added 8 cases covering empty / whitespace / required-gating / close-blocked-while-loading / thrown-onConfirm.
  - Test title `"captures the snapshot inside the setRows updater"` contradicted the actual implementation (comment-analyzer #1); renamed.
- **Three follow-ups filed during review:** #1602 (bulk-summary groups lose aggregation when requestIds are embedded — extract to a `(IDs: …)` trailing slot), #1603 (rollback non-string-warning handling, pre-existing from PR #1592), #1604 (e2e browser test for approval flow gated on EE in test harness).
- **Test coverage added:** 22 unit tests across 3 files — `queue-bulk-summary.test.ts` (10 cases, pure helpers), `use-queue-row.test.tsx` (5 cases including concurrency and id-absent), `reason-dialog.test.tsx` (8 cases, compliance contract).
- **Call-site convergence:** three sibling queue pages now share one filter-row primitive, one dialog primitive, one timestamp primitive, one optimistic hook, and the same bulk-result vocabulary. A fourth adopter costs essentially nothing.

**Category:** Extract-on-3rd-adopter applied to UI primitives. Textbook module deepening: three parallel, slightly-diverged implementations consolidated into a narrow-interface shared module with compliance contracts codified as regression tests. The snapshot-via-ref rationale in `use-queue-row.ts` and the "never fabricate a reason" rationale in `reason-dialog.tsx` are exactly the kind of non-obvious invariants that belong in the code (not the PR description).

---

## 28. CompactRow / Shell / useDisclosure — `@/ui/components/admin/compact.tsx`

**Date:** 2026-04-19 (retroactive — extraction shipped during the admin-console revamp wave that closed #1551)
**Issue:** #1551
**Module:** `packages/web/src/ui/components/admin/compact.tsx`

**Problem:** The admin-console revamp wave (14 pages: `/admin/integrations`, `/admin/email-provider`, `/admin/billing`, `/admin/branding`, `/admin/custom-domain`, `/admin/sandbox`, `/admin/residency`, `/admin/starter-prompts`, `/admin/settings`, `/admin/model-config`, `/admin/plugins`, `/admin/sso`, `/admin/connections`, `/admin/scim`, `/admin/ip-allowlist`, `/admin/api-keys`) all converged on the same progressive-disclosure vocabulary: a thin `CompactRow` with status dot + title + action that expands into a full `Shell` with icon, status pill, body (`DetailList` + `DetailRow`), and footer actions. Focus management on expand/collapse needed identical handling across every adopter. The extraction rule (#1551) said third adopter — the revamp wave blew past that.

**Solution:** `compact.tsx` consolidates the vocabulary. Exports:

- `StatusKind` — union of 6 kinds (`connected`, `disconnected`, `unavailable`, `ready`, `transitioning`, `unhealthy`) — widest across callers, per-caller subset is fine.
- `StatusDot` — 1.5×1.5 dot with kind-specific color + halo. Connected adds a motion-safe ping.
- `CompactRow` — collapsed-state row. Icon slot, title, status dot, action slot.
- `Shell` — expanded-state card. Icon slot (status-tinted), title (+ optional `titleBadge`), description, `trailing` ornament (defaults to Live/Unhealthy pill), collapse X, body children, footer `actions`. `titleText` prop for aria-label when `title` is JSX.
- `DetailList` / `DetailRow` — bordered key/value spec sheet. `mono` + `truncate` props.
- `InlineError` / `SectionHeading` — per-item error surface + section eyebrow.
- `useDisclosure({ onCollapseCleanup, collapseOn })` — the heart of the extraction. Returns `{ expanded, setExpanded, collapse, triggerRef, panelRef, panelId }` and handles:
  1. expand/collapse state + stable panel id
  2. focus into first form field on expand
  3. return focus to trigger button on collapse
  4. caller-provided cleanup (mutation error reset) on collapse
  5. auto-collapse when an external signal flips (e.g. `connected` after a successful BYOT flow) so a later disconnect doesn't re-open a stale `expanded=true` panel

**Impact:**
- **14 pages converged on one vocabulary** during the revamp wave (PRs #1538, #1540, #1544, #1548, #1549, #1550, #1552, #1553, #1554, #1556, and others).
- **Focus-management bugs that would have been 14 regressions became 1 fix.** The plugins page initially dropped the X close button when `trailing` was customized (#1560) — caught once, fixed in `Shell`, the fix propagated to all 14 adopters.
- **aria-controls-on-unmounted-panel class bug (#1545, fixed PR #1547)** was also a single-fix-propagates across all adopters because every page read the panel id from `useDisclosure`.
- **`CompactRow` + `Shell` as one module** (rather than two separate files) was the right call — they share `StatusKind` and `STATUS_LABEL`, and callers frequently render both forms side-by-side (connected Shell, other items collapsed CompactRow).
- **`statusLabel` override** on both `Shell` and `CompactRow` lets callers with different status semantics (plugins use "Enabled"/"Disabled" rather than "Connected"/"Not connected") reuse the primitive without forking.

**Category:** Progressive-disclosure UI pattern consolidated from 14 inline duplications into one shared module. `useDisclosure` is the cleanest win — five concerns (state, focus in, focus out, cleanup, auto-collapse) bundled behind six return values. Compare with the starter state of most revamped pages, which had three or four of the five concerns wired by hand and the fifth missing entirely (stale `expanded=true` after a successful mutation was a recurring bug).

---

## 29. Structured-error passthrough across admin mutations (`useAdminMutation`)

**Date:** 2026-04-19
**Issue:** #1595
**PR:** #1614
**Commit:** a3cc16a9

**Problem:** `useAdminMutation.mutate()` resolved to `{ ok: false, error: string }` — a flattened string built from `extractFetchError()`. The structured fields `status`, `requestId`, and `code` (the machine-readable `enterprise_required` signal from the API) were dropped at the hook boundary. Two downstream consumers silently degraded:

- `friendlyError()` branches on `status` to translate 401/403/404/503 into admin-appropriate copy; with the status gone, every mutation failure rendered raw `"HTTP 403 (Request ID: …)"` instead of `"Access denied. Admin role required to view this page."`.
- `AdminContentWrapper`'s `isEnterpriseRequired()` branches on `code === "enterprise_required"`; with the code gone, an EE-gated mutation failure rendered a generic `ErrorBanner` instead of the `EnterpriseUpsell` component — non-EE admins saw "something went wrong" with no path to the upgrade CTA.

The problem was silent — surfaced during the 4-agent review on #1594 when the silent-failure-hunter noticed `result.error` was a string but `friendlyError` expected a `FetchError`. The #1594 page applied a minimal local mitigation (`setError({ message: result.error })`); full fix moved up to the hook.

**Solution:** `MutateResult.error: string` → `FetchError`. The hook smuggles the structured error across the throw boundary via `Object.assign(new Error(msg), { fetchError })` — TanStack's own log still gets a human-readable `Error.message`, but the catch in `mutate()` can recover the `FetchError` attachment. Non-HTTP failures (network errors) fall back to a minimal `{ message }` `FetchError` preserving the `FetchError` interface contract. All 13 caller sites that read `result.error` migrated in the same PR (breaking shape change, atomic migration required — a two-PR split would have left `main` with a broken intermediate commit):

- **String-typed state:** pipes through `friendlyError(result.error)` (canonical wrap; fires translations, appends requestId).
- **`FetchError | null` state** (`/admin/learned-patterns`): passes the error straight through to `setError()` so `AdminContentWrapper` can branch on `.code` and `.status`.
- **Zero remaining `{ message: result.error }` wraps** (grep-verified post-merge).

The hook's own `error: string | null` state is explicitly unchanged — out of scope per the issue (follow-up in #1615).

**Impact:**
- **+244 net lines** (273 added, 29 removed across 15 files). Most of the delta is the new integration test file (`admin-mutation-error-passthrough.test.tsx`, +188 lines) that drives the full flow through `AdminContentWrapper`. The hook itself changed by ~14 useful lines; the 13 caller migrations averaged 2 lines each.
- **Four-agent review surfaced only sub-threshold findings, no CRITICAL/HIGH.** Comment-analyzer flagged `#1595` references that would rot on close and one comment that restated obvious code (fixed in a second commit). Code-reviewer and silent-failure-hunter both flagged unreachable `|| "Failed to…"` fallbacks on top of `friendlyError()` (which always returns a non-empty string) — dead code, removed in the same follow-up commit. Three follow-ups filed: **#1615** (hook-level `mutation.error` still flattens for the ~15 callers that read it directly — same class of bug, different surface), **#1616** (ESLint guard against re-introducing the `{ message: result.error }` wrap), **#1617** (invalidates() callback throws conflated with mutation errors — pre-existing, surfaced during silent-failure review).
- **Test coverage added:** `use-admin-mutation.test.ts` gets a regression guard asserting `code/status/requestId` survive the catch (the exact regression that would re-introduce #1595). The new `admin-mutation-error-passthrough.test.tsx` drives five distinct error paths through `AdminContentWrapper` — 403+`enterprise_required` → `EnterpriseUpsell`, plain 403 → `FeatureGate` access-denied copy, 401/404/503 → `FeatureGate` copy. Every test also asserts the raw `"HTTP 4xx"` string does **not** render, so a future re-flatten would fail both directions.
- **`AdminContentWrapper` invariant codified in a test.** Pre-PR, the wrapper's `isEnterpriseRequired(error)` / `FeatureGate status={…}` branching was reachable only from `useAdminFetch` (read path); mutations bypassed it because the error was a string. Post-PR, mutations reach the same branches and there's an integration test pinning the contract both pages and wrapper need to uphold.

**Category:** Data-structure preservation across a hook boundary. The hook had been deepening the wrong way — adding convenience (auto-invalidate, per-item loading, onSuccess outside try/catch) while narrowing the error surface. Widening `MutateResult.error` back to the full `FetchError` cost ~14 lines of hook and unlocked two already-built downstream features (`friendlyError`, `EnterpriseUpsell`) that had been quietly half-dead on the mutation path. The pattern generalizes — any hook boundary that flattens structured-error shape to a string is a silent-failure candidate, and `Object.assign(new Error(msg), { structured })` is a cheap way to thread it through whatever library throws for you (here TanStack's `useMutation`).


---

## 30. Structured-error passthrough at the hook level — completes win #29

**Date:** 2026-04-19
**Issue:** #1615 (primary), #1617, #1616
**PR:** TBD

**Problem:** #1614 (win #29) widened `MutateResult.error` from `string` to `FetchError` so mutation *callbacks* could branch on `code === "enterprise_required"` and feed structured errors into `AdminContentWrapper`. The hook-level `error: string | null` state was explicitly out-of-scope and stayed flat. ~40 admin pages (api-keys, scheduled-tasks, ip-allowlist, connections, platform/plugins, sandbox, approval, plugins, branding, roles, settings, residency, users, prompts, scim, sso, sessions, billing, compliance, cache, email-provider, integrations, model-config, semantic editor, custom-domain, audit retention, platform/*, dashboards, starter-prompts, scheduled-task dialog, version history, SSO dialogs, etc.) read `mutation.error` directly — for those pages, EE-gated endpoints 403ing with `enterprise_required` rendered a generic banner instead of `EnterpriseUpsell`, and `requestId` was dropped from banner copy. Same #1595 class, different surface.

A pre-existing bug also hid in the hook: `invalidates()` callbacks ran inside the same `try/catch` as `mutateAsync`, so a throwing refetch (stale closure, setState on unmounted component) surfaced as a mutation failure even though the network call succeeded. Surfaced during silent-failure review of #1614, filed as #1617.

**Solution:** Three-in-one refactor (#1615 + #1617 + #1616):

1. **Hook-level error: `string | null` → `FetchError | null`.** Same `Object.assign(new Error(msg), { fetchError })` smuggling used by win #29 now populates the hook's own state, not just the resolved `MutateResult`. Every admin page that read `.error` migrated atomically — 42 files, split roughly three ways: `ErrorBanner message={friendlyError(e)}` (the common case; fires 401/403/404/503 translations + appends requestId), `serverError={friendlyErrorOrNull(e)}` (FormDialog-style props that accept `string | null`), and raw JSX `{friendlyError(e)}` inside dialog bodies. Added `friendlyErrorOrNull()` helper to keep call sites terse and typed — `mutation.error ? friendlyError(mutation.error) : null` collapses to a single function call at 30+ sites.

2. **`invalidates()` callbacks moved outside the try/catch (#1617).** The catch returns early, so control only falls through to the callback block on a truly-successful fetch — reaching there implies `data` is populated. Each `invalidates` fn runs in its own nested `try/catch` with a `console.debug()` on throw so one stale refetch can't starve the rest, and `onSuccess` gets the same isolation (was already pseudo-isolated via comment-only convention). Three new regression tests: throwing invalidates → `result.ok` still `true`, hook `error` still `null`, debug log emitted; multiple invalidates where one throws — the others still run; throwing `onSuccess` doesn't flip `result.ok`.

3. **ESLint guard against the re-flatten (#1616).** A `no-restricted-syntax` rule in `eslint.config.mjs` scoped to `packages/web/**/*.{ts,tsx}` matches `{ message: X.error }` single-property objects — the exact shape the pre-#1614 `setError({ message: result.error })` mitigation used, which would silently destroy structured fields if re-introduced. Verified firing on a deliberately-introduced probe, then removed.

4. **`combineMutationErrors` widened to `FetchError | null | undefined[] → FetchError | null`.** Four multi-mutation pages (`/admin/residency`, `/admin/sandbox`, `/admin/custom-domain`, `/admin/email-provider`) chain errors from several mutations into one banner. Pre-PR the helper collapsed strings; post-PR it preserves the structured fields from the *first distinct* error so `AdminContentWrapper` branching still routes to `EnterpriseUpsell` / `FeatureGate` when a 403 is in the concurrent set. Message dedup + `(+N more)` suffix still applies.

**Impact:**
- **~+150 net lines** (mostly test additions — 4 new test blocks in `use-admin-mutation.test.ts`, 1 new test in `admin-mutation-error-passthrough.test.tsx`, widened `mutation-errors.test.ts` to assert structured-field preservation). Hook itself shrank by ~5 lines (the `succeeded` flag was replaced by "catch returns early, so fall-through implies success").
- **42 files migrated atomically.** TypeScript flagged 151 errors after the hook signature change; fixes ranged from a single `friendlyError()` wrap to replacing a local string-based `mutationError = a ?? b ?? c` chain with `combineMutationErrors([a, b, c])` + one `friendlyError()` at the banner. No cross-package API breaks — `@useatlas/types` / `@useatlas/sdk` / `@useatlas/react` untouched; `FetchError` and `friendlyError` stay web-package-internal.
- **EE 403 → EnterpriseUpsell now reaches every admin mutation path.** Before, a non-EE admin clicking "Enable SSO enforcement" or "Add custom domain" on a workspace without the enterprise plan saw a generic "Access denied. Admin role required." — the wrong message, because they *are* an admin; they just aren't on the right plan. Post-PR the structured `code` field reaches `AdminContentWrapper`, which routes to `EnterpriseUpsell` with the feature-specific upsell copy and pricing link.
- **`requestId` visible on hook-level banners.** 30+ banners went from `"Something failed"` → `"Access denied. Admin role required. (Request ID: req-abc-123)"`, closing the log-correlation gap that #1614 fixed only for the callback-level path.
- **ESLint guard prevents re-introduction.** A future copy-paste from an older branch or from `useAdminFetch` patterns (which *do* have a legitimate `{ message }` shape for manual errors) would type-check but fail lint. Verified firing; the rule message points at `friendlyError` / `friendlyErrorOrNull` as the remediation.
- **Follow-up filed: #1621** (pre-existing `demo/page.tsx` type error using stale `chatEndpoint`/`conversationsEndpoint` props on `<AtlasChat>` — surfaced by `tsgo --noEmit -p packages/web/tsconfig.json` when auditing web-package type-check output; unrelated to this PR but noticed during the review).

**Category:** Completion pass on a two-phase data-structure migration. Win #29 unblocked the primary code path (`result.error`); win #30 sweeps the ~40 pages that read the *secondary* hook-level surface the first pass left flattened, plus adds ESLint enforcement so the invariant survives churn. The #1617 callback-isolation fix rides along because silent-failure-hunter flagged it during #1614 review — cheap to fix atomically with the hook widening, since both touch the same `mutate()` body. Generalizes: when you're partway through a migration and the follow-up is "same class of bug, different surface," do the full sweep plus a lint rule; the ESLint `no-restricted-syntax` AST selector is a cheap safety net for any `X.something` shape you need to prevent callers from re-flattening.

---

## 31. `<MutationErrorSurface>` — write-path parity with `AdminContentWrapper` feature-gate routing

**Date:** 2026-04-19
**Issue:** #1624
**PR:** TBD (phase 1 of 2 — 5 admin pages migrated, follow-up issue tracks the remaining ~35)

**Problem:** Wins #29 and #30 widened `MutateResult.error` and `mutation.error` to `FetchError`, preserving `code` / `status` / `requestId` across the hook boundary. But `AdminContentWrapper`'s `isEnterpriseRequired()` + `FeatureGate` decision tree — the code that routes `403 + code: "enterprise_required"` to `EnterpriseUpsell` and known status codes to `FeatureGate` — was still only reachable from the read path (`useAdminFetch`). Admin pages rendering mutation errors wrote `<ErrorBanner message={friendlyError(mutation.error)} />` at their render boundary, which flattens the structured `FetchError` to a string *again* before any gating can fire. A non-EE admin clicking "Enable SSO enforcement" on a gated workspace saw the translated 403 copy ("Access denied. Admin role required.") — wrong message, wrong CTA, no path to the upsell.

Same as the #1595 / #1614 pattern but at the render boundary instead of the hook boundary: structured error survives the transport layer, gets flattened one step later because the UI primitive accepts a `string`, not a `FetchError`.

**Solution:** `<MutationErrorSurface>` in `packages/web/src/ui/components/admin/mutation-error-surface.tsx` accepts `FetchError | null` and encapsulates the same decision tree `AdminContentWrapper` applies to fetch errors — moved up a level from the wrapper into a dedicated component so the write path doesn't have to thread its errors back through `AdminContentWrapper`'s fetch-oriented API.

Two variants:
- **`variant="banner"` (default)** — mirrors `AdminContentWrapper` exactly: `enterprise_required` → `<EnterpriseUpsell>`, status in {401, 403, 404, 503} → `<FeatureGate>`, else → `<ErrorBanner>` with `friendlyError` copy + retry.
- **`variant="inline"`** — for compact rows and dialog bodies that can't host a full-page upsell card. `enterprise_required` routes to a condensed `<InlineError>` that keeps the enterprise link ("… requires Enterprise. Learn more →") so the routing win isn't lost; other errors render as `<InlineError>` with an optional bold prefix ("Save failed." etc.). Inline variant intentionally does *not* route other 401/403/404/503 through `<FeatureGate>` — replacing a tiny row-level error slot with a full-page gate would be more disruptive than useful, and the page-level wrapper still handles those on refresh.

Phase 1 migration (this PR) covers 5 highest-value pages — the ones called out explicitly in #1624 as the surfaces where the gap is most visible:
- `/admin/sso` — 3 `ErrorBanner` sites (enforcement, toggle, verify) + 1 in the enforce-confirmation dialog.
- `/admin/scim` — 1 page-level `ErrorBanner`. Per-row `InlineError` (with synthesized "Revoke failed —" prefix) stays as-is — that's a different concern (last-wins row pinning) punted to phase 2.
- `/admin/branding` — 2 `InlineError` sites (save + reset).
- `/admin/billing` — 2 `InlineError` sites (model change + BYOT toggle). `PlanShell.combinedError` deliberately skipped — blends a mutation error with local `portalError` state; phase 2.
- `/admin/ip-allowlist` — inline div in delete dialog.

**Impact:**
- **One component, five pages, ~35 remaining.** Component itself is small — most of it is the docstring explaining the decision tree and why the inline variant opts out of FeatureGate routing. Each call site dropped 3–5 lines — `{err && <ErrorBanner … />}` → `<MutationErrorSurface error={err} feature="…" />` plus the null-render handling moves into the component.
- **10 component tests, full branch coverage.** Enterprise_required (banner + inline), all 4 FeatureGate status codes, plain error with requestId, retry button wiring, inline prefix rendering, null → null. Inline + `enterprise_required` asserts the compact upsell link is present AND the full `EnterpriseUpsell` button is *not* — guards the variant separation.
- **Phase 2 is mechanical.** ~35 admin pages still write `<ErrorBanner message={friendlyError(mutation.error)} />` or the equivalent. Follow-up issue enumerates the full list so the second PR can sweep them in one pass without re-analysis.

**Category:** Render-boundary completion of the structured-error migration line (wins #29 → #30 → #31). Each win moves the invariant one step further through the stack: hook result → hook state → render output. The pattern generalizes — if a UI primitive accepts a flattened type (`string`, `number`) where the caller has a structured type (`FetchError`, `Money`, `Duration`), the decision tree *on* the structured fields belongs in a dedicated component, not at every call site. Call sites otherwise drop the structure before gating can fire.

---

## 32. `@useatlas/schemas` — shared Zod wire-format package (AbuseDetail first)

**Date:** 2026-04-19
**Issue:** #1642
**PR:** TBD

**Problem:** Type-design-analyzer review of PR #1641 surfaced parallel Zod schemas describing the same wire shapes — one inside the API route (for `@hono/zod-openapi` response validation) and one inside the web admin client (for `useAdminFetch` runtime parsing). A field rename on either side type-checked cleanly while the other kept the old key, so drift went undetected until a runtime response arrived shaped differently than the parser expected. The abuse surface alone had six duplicated schemas (`AbuseEvent`, `AbuseStatus`, `AbuseThresholdConfig`, `AbuseCounters`, `AbuseInstance`, `AbuseDetail`); the issue mapped 15+ comparable pairs across the admin surface (approval, custom-domain, integrations, billing, SLA, backups, regions, audit analytics).

The two Zod copies weren't even *behaviorally* equivalent: the route used `z.enum(ABUSE_LEVELS)` (tight — imported the tuple from `@useatlas/types`), while the web used `z.string()` with a `z.ZodType<AbuseStatus>` cast (loose — deliberately weakened so "API adds a new level" wouldn't break the web parser). In practice the API and web read the *same* tuple via `@useatlas/types`, so the looseness was a comment-only justification, not a real forward-compatibility story.

**Solution:** New workspace package `@useatlas/schemas` that owns the wire-format Zod validators. First migrated schema: the six abuse shapes. Both API (`packages/api/src/api/routes/admin-abuse.ts`) and web (`packages/web/src/ui/lib/admin-schemas.ts`) import from it.

Structure:
- `packages/schemas/package.json` — `@useatlas/schemas`, `private: true`, depends on `@useatlas/types` + `zod`. Subpath exports: `"."` → `./src/index.ts`, `"./abuse"` → `./src/abuse.ts`.
- `packages/schemas/src/abuse.ts` — single source with `satisfies z.ZodType<AbuseEvent>` / `AbuseStatus` / etc., so a TS union rename in `@useatlas/types` breaks the schema file at compile time. `AbuseDetailSchema` uses `AbuseStatusSchema.omit({ events: true }).extend({...})` to structurally mirror the TS `AbuseDetail extends Omit<AbuseStatus, "events">` relationship; identity-field drift between status and detail is caught at the Zod layer.
- Plain `zod` (not `@hono/zod-openapi`'s `z`) — compatible with both sides since `@hono/zod-openapi` just adds `.openapi()` helpers; the OpenAPI spec diff was zero (verified by `scripts/check-openapi-drift.sh`).
- Exports point at `./src/*.ts` directly — no build step, same convention as `@atlas/api`. When we eventually publish for the SDK/react external consumers, we'll add a `build` script mirroring `@useatlas/types`.

Dependency direction enforced by README **and** ESLint `no-restricted-imports`:

```
@useatlas/types      (pure TS, zero runtime — ABUSE_LEVELS / ABUSE_TRIGGERS tuples)
        ↓
@useatlas/schemas    (Zod validators; re-exports type tuples)
        ↓
@atlas/api    @atlas/web
```

`@useatlas/schemas` cannot depend on `@atlas/api` / `@atlas/web` / `@atlas/ee` — the `no-restricted-imports` rule in `eslint.config.mjs` scoped to `packages/schemas/**` fails lint on the first upward import. Verified with a probe file before shipping. `@useatlas/types` must stay Zod-free (pulling Zod in would bloat the SDK surface for consumers that only want the types).

Route-level changes:
- Deleted `AbuseEventSchema` / `AbuseStatusSchema` / `AbuseCountersSchema` / `AbuseInstanceSchema` / `AbuseDetailResponseSchema` / `ConfigResponseSchema` (renamed from `ConfigResponseSchema` → `AbuseThresholdConfigSchema` via shared import).
- Kept `ListResponseSchema` local (it wraps the shared `AbuseStatusSchema` via `createListResponseSchema("workspaces", ...)` — route-envelope concern, not a wire shape).
- Kept `ReinstateResponseSchema` local (route-only, not shared with web).

Web-level changes:
- Deleted local `AbuseEventSchema` / `AbuseCountersSchema` / `AbuseInstanceSchema`, plus tightened `AbuseStatusSchema` / `AbuseThresholdConfigSchema` / `AbuseDetailSchema` by re-exporting from `@useatlas/schemas`.
- Web callers (`detail-panel.tsx`, `page.tsx`, existing `useAdminFetch` sites) keep using `AbuseStatusSchema` / `AbuseDetailSchema` by name — the re-export preserves the import path so no caller needed touching.
- Tightening note: the shared schema uses `z.enum(ABUSE_LEVELS)` where the web copy used `z.string()`. Safe because both sides read the *same* `@useatlas/types` tuple as a workspace dep — but silent-failure-hunter review flagged that `abuse_events.level` / `trigger_type` are unconstrained `TEXT` DB columns (no `CHECK`), and the server casts `r.level as AbuseLevel` without validation. Attempted fix: `.catch("none")` / `.catch("manual")` fallbacks on the enum wrappers so drifted rows degrade to safe defaults. Abandoned: the `@hono/zod-openapi` extractor throws `UnknownZodTypeError` on `ZodCatch` wrappers and refuses to generate the spec. Shipped shape: strict enums. Real hardening deferred to #1653 where it belongs — DB `CHECK` constraint on `abuse_events.level` + `trigger_type` so drift can't reach the admin page in the first place, plus server-side coercion in `getAbuseEvents` / `restoreAbuseState` with `log.warn` for already-persisted drift. Strict enums match the TS type exactly and match the OpenAPI spec's documented `enum` values — drift surfaces as a loud `schema_mismatch` banner in `useAdminFetch` rather than silent rendering. In practice, reaching this failure mode requires a manual DB INSERT or an out-of-band tuple rename; both are caught earlier than the admin-page boundary.

**Impact:**
- **~+250 net lines after all review passes** (new package scaffold + parse-boundary test suite + ESLint boundary rule). Route + web migration alone was net −30 lines; the test (~150 lines) and ESLint rule (~20 lines) are additive safety rails, not shape-echoing code.
- **Abuse surface drift window closed.** A future rename like `errorRatePct → errorRatePercent` now has to happen in one place; the other import site fails `tsc` via `satisfies z.ZodType<AbuseCounters>`. Identity-field drift between `AbuseStatus` and `AbuseDetail` is also caught via `.omit().extend()`.
- **OpenAPI spec diff: zero bytes.** `scripts/check-openapi-drift.sh` re-generated the 72-tag `apps/docs/openapi.json` without producing a change, confirming plain-zod interoperates identically with `@hono/zod-openapi`.
- **Template drift: zero.** `scripts/check-template-drift.sh` passes — the new package isn't being synced into the nextjs-standalone or docker templates (both templates only bundle runtime-required packages).
- **15/15 abuse route tests + 14/14 new schema parse-boundary tests pass.** Full API suite: 242/242 files green. Web suite: 70/70 files green. Syncpack clean (zod version already aligned at `^4.3.6` across the workspace).
- **Enforcement beyond documentation.** The ESLint boundary rule converts the README's dependency-direction invariant from doctrine into a build failure. Verified firing via temporary probe before shipping.
- **Strict enum drift detection.** `z.enum(ABUSE_LEVELS)` + OpenAPI spec describing the exact union means drift surfaces as a loud `schema_mismatch` banner, not silent rendering. `@hono/zod-openapi` refuses `ZodCatch` wrappers so the graceful-degradation alternative was abandoned; #1653 tracks the real hardening (DB `CHECK` + server-side coercion).
- **Follow-up map recorded in README + issue #1648.** Next drift-prone schemas (ApprovalRule, CustomDomain, IntegrationStatus, PlatformWorkspace family) to migrate one PR at a time so each OpenAPI diff is inspectable at merge.

**Category:** Cross-package consolidation of duplicated runtime validators. This is the "extract a shared interface" move in its API-boundary form: when two packages independently encode the same wire shape, pull both encodings into a third package the others depend on. The `satisfies z.ZodType<T>` pattern marries Zod's runtime check to TypeScript's compile-time check without the loose `as` cast; if `@useatlas/types` renames a field, the schema file fails to compile *before* the drift hits production. Generalizes: for any project with an admin surface mirror-typed across API and client, a shared schemas package pays for itself after the second wire shape and scales cleanly through the first dozen.

---

## 33. `@useatlas/schemas` — phase 2–3 follow-on migrations (Approval, CustomDomain, IntegrationStatus, BillingStatus, Backup, Platform family)

**Date:** 2026-04-19
**Issue:** #1648
**PRs:** #1654 (ApprovalRule + CustomDomain), #1669 (IntegrationStatus family), #1678 (BillingStatus + Backup + Platform family)

**Problem:** Win #32 shipped the package scaffold with abuse as the first consumer, but 15+ duplicated wire shapes remained across the admin surface. Each iteration pair (route-level Zod schema + web-level Zod schema) independently described the same response, and the web copies had all silently relaxed enums to `z.string()` so new API values wouldn't fail the web parse. The looseness was comment-only justification: both sides read the same tuples from `@useatlas/types` as a workspace dep, so "forward compatibility" wasn't actually buying anything — it was just hiding drift. The longer the backlog sat, the more admin pages accumulated relaxed parsers that wouldn't notice when a tuple gained a value.

**Solution:** Three back-to-back migrations in drift-risk order. Each PR moved one schema family to `packages/schemas/src/<topic>.ts` using the same pattern established in #1647:

- **#1654 — ApprovalRule + CustomDomain.** `approval.ts` moved 4 schemas (`ApprovalRule`, `ApprovalRequest`, and their nested-condition / action shapes); `custom-domain.ts` moved `CustomDomain` with all three status enums pinned (`DOMAIN_STATUSES`, `CERTIFICATE_STATUSES`, `DOMAIN_VERIFICATION_STATUSES`). Web previously relaxed `status` and `certificateStatus` to `z.string()` while keeping `domainVerificationStatus` strict; this PR generalized the tight treatment.
- **#1669 — IntegrationStatus family.** `integrations.ts` moved 11 schemas (one per platform — Slack / Teams / Discord / Telegram / GChat / GitHub / Linear / WhatsApp / Email / Webhooks — plus the top-level `IntegrationStatus`). The DeployMode literal union and the DELIVERY_CHANNELS tuple both come from `@useatlas/types`.
- **#1678 — BillingStatus + Backup + Platform family.** `backup.ts` moved `BackupEntry` + `BackupConfig` (web had relaxed `status` to `z.string()`); `platform.ts` moved `PlatformStats` + `PlatformWorkspace` + `PlatformWorkspaceUser` + `NoisyNeighbor` (four enums tightened: `WORKSPACE_STATUSES`, `PLAN_TIERS`, `NOISY_NEIGHBOR_METRICS`, `ATLAS_ROLES`); `billing.ts` moved `BillingStatus` + 6 nested interfaces, replacing the route's prior `z.record(z.string(), z.unknown())` response schema with a strict typed shape — the OpenAPI spec for `GET /api/v1/billing` went from "any object" (`additionalProperties: {}`) to a fully-described 3-level nested schema.

Three subtleties surfaced during phase 3 that are worth recording:

1. **Version-skew trap.** Scaffold smoke tests (`Scaffold (docker)` / `Scaffold (vercel)`) build a standalone project against `@useatlas/types` from **npm** (currently `0.0.11`), not the workspace version. My first `BillingStatus` draft added `OVERAGE_STATUSES` tuple + `BillingStatus` family to `@useatlas/types` and imported them from `@useatlas/schemas`. That broke CI because `packages/schemas/src/billing.ts` is synced into `create-atlas/templates/*/src/schemas/` and those templates resolve `@useatlas/types` from the registry. Fix: define the wire-only interfaces (`BillingStatus` and nested) **inside `@useatlas/schemas`** itself, keep the shared type-only `OverageStatus` union in `@useatlas/types@0.0.11`, and use a locally-defined `OVERAGE_STATUSES` tuple guarded by `satisfies z.ZodType<OverageStatus>` against the published union. The guard still fails the build if the union ever drifts. Generalizes to: **anything new that schemas needs from types must be in the published version of types**. Schema-only types belong in schemas; types used by enforcement / metering / other runtime code belong in types.

2. **Request validation belongs in the route, response validation belongs in schemas.** `platform-backups.ts` had `.openapi({description, example, min, max})` annotations that were doing double duty — describing the RESPONSE shape in the OpenAPI spec (nice-to-have docs) and enforcing REQUEST constraints (cron-regex, retentionDays range). Moving the schema to `@useatlas/schemas` lost the response-side docs annotations because shared schemas depend on plain `zod`, not `@hono/zod-openapi`. Request validation still lives in the route (`UpdateConfigSchema`) with its own `.openapi({...})` annotations and refine() guards. Accepted the minor docs regression; the shape is still fully described.

3. **Reality testing the "bundled" billing interface.** Before #1678, `BillingStatusSchema` on the web had `seats` / `connections` / `currentModel` / `overagePerMillionTokens` as `.optional()` — defensive, but the route always emits them. Tightening to required matched reality and caught a real bug during review: `PLAN_MRR` in `platform-admin.ts` still keyed on `team` / `enterprise` plan names that were renamed to `starter` / `pro` / `business` back in migration 0020. The MRR on `/api/v1/platform/stats` had been silently `0` for every workspace. Filed #1680. Also filed #1679 (`backups.status` needs a DB CHECK constraint to match the new strict enum). Both surfaced because the migration forced a second read of each shape.

**Impact:**
- **3 PRs, 10 schemas migrated, ~50 new parse-boundary tests.** Schemas package test count: 14 → 113 across the phase; total after #1678 specifically: 75 → 113.
- **8 enum columns tightened on the web side** in the #1678 batch alone (plus all the enum tightening in #1654 / #1669). Every drift-prone column on the covered surfaces now fails parse loudly instead of rendering as untyped text.
- **OpenAPI spec of `GET /api/v1/billing` went from undocumented (`additionalProperties: {}`) to fully typed** — 3 levels deep, every required field listed, enums pinned. Consumers finally see the real contract.
- **Zero OpenAPI drift on the other 9 schemas** — the strict schemas in `packages/schemas/` produce identical JSON to what `@hono/zod-openapi` was emitting for the route-level copies. Verified via `scripts/check-openapi-drift.sh` on each PR.
- **Incidental findings filed, not fixed inline** (#1679 DB hardening, #1680 MRR bug) — keeps each PR focused on the migration.
- **Roughly 10 schemas remain** (SLA family, Region family, PIIColumnClassification, SemanticDiffResponse, Branding, ModelConfig, ConnectionInfo/Health, audit analytics, token usage/trends, UsageSummary). Tracker #1648 remains open with the punch list.

**Category:** Continuation of win #32's cross-package consolidation. The interesting meta-lesson here is about **where wire-only types live**. `@useatlas/types` is published and consumed by scaffolds that track the last published version; `@useatlas/schemas` is workspace-internal and syncs into the monorepo copies. A type that only exists on the wire (like `BillingStatus`) belongs in `@useatlas/schemas` — putting it in `@useatlas/types` creates a version-skew failure mode that the scaffold tests catch but that's easy to miss locally. A type that crosses the wire boundary (like `OverageStatus`, used by enforcement) belongs in `@useatlas/types` and stays forward-compatible via `satisfies` at the schema layer. This boundary is now documented by the scaffold-tests failure mode; future schema migrations should default to "define the type in schemas unless something outside the wire needs it."

---

## 34. `createAbuseInstance` factory — narrowed constructor for `AbuseInstance` invariants

**Date:** 2026-04-19
**Issue:** #1644 (primary architecture label) + #1638 + #1639
**PR:** #1681

**Problem:** `AbuseInstance` is the admin detail panel's core grouping object — each instance represents one continuous stretch of non-"none" activity for a workspace, with three derived fields (`startedAt`, `endedAt`, `peakLevel`) that must agree with the underlying events. Before this change the single construction site (`makeInstance` inside `abuse-instances.ts`) was a private helper, which meant nothing prevented a fresh caller inside the abuse engine from hand-rolling `{ startedAt: ..., endedAt: ..., peakLevel: ..., events: ... }` inline. The invariants were implicit: you could produce a type-checking `AbuseInstance` with a mismatched `peakLevel` (lower rank than some event in `events`), a non-null `endedAt` on an open instance, or a `startedAt` that didn't match `events[0].createdAt`.

A second, adjacent smell in the same module: the error-rate percentage calculation used by `getAbuseDetail` was inlined as `(w.errorCount / queryCount) * 100` with the divide-by-zero guard implicit in the surrounding `queryCount >= 10` branch. The arithmetic was untestable without standing up the whole engine, and a future caller that wanted the same percentage (e.g. the SLA surface, which does a structurally-identical calculation) would copy the formula rather than reuse it.

**Solution:** Promoted `makeInstance` → exported `createAbuseInstance(events)` as the narrowed constructor for `AbuseInstance` within the abuse engine. The factory encodes all four invariants in one place:

```ts
export function createAbuseInstance(eventsChrono: AbuseEvent[]): AbuseInstance {
  if (eventsChrono.length === 0) {
    return { startedAt: "", endedAt: null, peakLevel: "none", events: [] };
  }
  const last = eventsChrono[eventsChrono.length - 1]!;
  const endedAt = isReinstatement(last) ? last.createdAt : null;
  let peak: AbuseLevel = "none";
  for (const e of eventsChrono) {
    if (LEVEL_RANK[e.level] > LEVEL_RANK[peak]) peak = e.level;
  }
  return {
    startedAt: eventsChrono[0]!.createdAt,
    endedAt,
    peakLevel: peak,
    events: eventsChrono,
  };
}
```

`splitIntoInstances` now calls `createAbuseInstance` for both the closed and current-instance branches. Unit tests pin each invariant: empty → sentinel, startedAt from events[0], endedAt null on open, endedAt non-null only on manual "none" reinstatement, system-generated "none" is not a close boundary, peakLevel by rank not chronology, peakLevel "none" for all-reinstatement input, events aliased verbatim (no defensive copy — documented precondition so future refactors to a copy are deliberate), insertion order preserved when input is non-chronological.

Also extracted `errorRatePct(errorCount, totalCount): number` as a pure counter helper alongside the factory. Tests cover zero denominator (returns 0 without NaN/Infinity), real baselines, threshold-boundary precision at 2 decimals, 100% cap on caller-bug inputs (`errorCount > totalCount`), large-count precision, and explicit throws on non-finite / negative inputs rather than silent propagation. `getAbuseDetail` now delegates the arithmetic to the helper while keeping the "baseline < 10 queries → null" display-policy decision at the call site (the helper is arithmetic; the null baseline is UI semantics).

**Impact:**
- Small module-shaped growth: the factory + helper add a handful of lines to `abuse-instances.ts`, the call site in `abuse.ts` is unchanged in shape (inlined arithmetic swapped for a helper call). The material growth is in tests — roughly 400 lines of behavior-pinning coverage across the factory's invariants, the helper's arithmetic edges, and the `getAbuseDetail` integration path.
- `AbuseInstance` has a narrowed constructor within `packages/api/src/lib/security/**`. The type is still a structurally-typed interface exported from `@useatlas/types`, so route-layer test fixtures and the Zod wire-format parser can still produce the shape directly — the factory is advisory at the language level, load-bearing only inside the abuse engine. Upgrading to a branded type (phantom-symbol brand on `AbuseInstance` that only the factory can mint) is tracked as a follow-up; doing it in this PR would have touched every test fixture site.
- `errorRatePct` is now reusable. The SLA surface (`ee/src/sla/metrics.ts`) does a structurally identical calculation with its own `Math.round(…) / 100` formula — not consolidated here, but flagged as a follow-up candidate since the helper is now importable.
- **6 new integration tests** for `getAbuseDetail` against real in-memory state (seeded via `recordQueryEvent` + DB fixtures): existing-instance returns full counters + thresholds + open current instance, missing workspace returns null without a DB hit (proven by a `queryInvoked` flag, not just the null return), post-reinstate (level=none) returns null with DB still untouched, under-baseline queryCount surfaces `errorRatePct: null`, re-flagged workspace preserves prior closed instance with reinstatement boundary, DB load failure degrades to empty events rather than throwing (the log warning is explicitly asserted to fire, guarding against the silent-swallow pattern).
- **Wire-format change: 2-decimal rounding.** `errorRatePct` now rounds to 2 decimals where it was unrounded before. The UI card in `detail-panel.tsx` displays via `.toFixed(0)` so the visible integer is unchanged, but a sibling usage in the same file computes a derived "over threshold" flag via `counters.errorRatePct / 100 > thresholds.errorRateThreshold`. Rounding to 1 decimal (the initial implementation) would have silently flipped that flag off within ±0.05% of the threshold while the engine itself still escalated on the unrounded fraction — so the UI and engine would have disagreed at boundary values. 2 decimals matches the SLA surface convention and keeps the boundary comparison faithful to 0.01%, which is well below any meaningful display resolution.

**Category:** Module-deepening refactor that promotes an internal helper to a narrowed public factory. The factory pattern fits the "deep module with small interface" mold: callers pass one argument (the events array), the factory derives everything else. The caveat — and the follow-up — is that without a branded or nominal type, the factory is a convention, not a boundary. Generalizes: whenever a type has N derived fields that must agree, a single constructor function beats N scattered call sites hand-assembling the object, but the real enforcement wants a brand, a discriminated union, or a class-with-private-constructor on top.

---

## 35. Nominally-branded `AbuseInstance` — closes the factory's enforcement gap

**Date:** 2026-04-19
**Issue:** #1684
**PR:** refactor/abuse-hardening-bundle

**Problem:** Win #34 promoted `createAbuseInstance` to a narrowed exported factory that encodes the `AbuseInstance` invariants (peakLevel ≡ max of event levels, endedAt non-null iff last event is a manual "none" reinstatement, startedAt ≡ events[0].createdAt). The factory docstring already flagged the caveat: "`AbuseInstance` is still a structurally-typed interface, so the factory is an advisory boundary — tests and wire-format parsers can still produce the shape directly." Route-layer test fixtures in `admin-abuse.test.ts` did exactly that (lines 268–273, 295, 333 in the pre-bundle state), hand-rolling the object inline and compiling fine. A fresh call site inside `packages/api/src/lib/security/**` could produce a `peakLevel: "warning"` literal over events containing `"suspended"` and the compiler would let it through.

Type-design-analyzer rated the factory at encapsulation 1/5, invariant-expression 2/5, enforcement 2/5. The factory was advisory, not nominal — exactly the shape-vs-identity distinction this codebase keeps running into.

**Solution:** Added a phantom `unique symbol` brand to `AbuseInstance` in `@useatlas/types/abuse.ts`:

```ts
declare const abuseInstanceBrand: unique symbol;
export interface AbuseInstance {
  readonly [abuseInstanceBrand]: never;
  startedAt: string;
  endedAt: string | null;
  peakLevel: AbuseLevel;
  events: readonly AbuseEvent[];
}
```

The required `[brand]: never` key is impossible to satisfy with a plain object literal — the key type is a module-private `unique symbol` no external caller can reference, and its value type is `never`. Only two escape hatches remain:

1. `createAbuseInstance` in `abuse-instances.ts` localizes the `as unknown as AbuseInstance` cast inside the factory. The factory's documented contract (the invariants in #34) is what grants the cast its authority.
2. `AbuseInstanceSchema` in `@useatlas/schemas/abuse.ts` adds a `.transform((v) => v as unknown as AbuseInstance)` so the wire-boundary Zod parser can mint a branded value. `satisfies z.ZodType<AbuseInstance, unknown>` (widened input) keeps the structural drift guard — a field rename in `@useatlas/types` still breaks the schema file at compile time.

Also: `events: readonly AbuseEvent[]` (was mutable `AbuseEvent[]`). Mutating the array post-construction would silently invalidate the cached `peakLevel` and `endedAt` invariants — `readonly` is free and forces such mutations through an explicit copy.

Migrated four hand-rolled `currentInstance: {...}` fixtures in `admin-abuse.test.ts` to `createAbuseInstance([])` and tightened the mock signature from `Promise<unknown | null>` to `Promise<AbuseDetail | null>` so inline literals now fail typecheck immediately. A new `@ts-expect-error` regression test pins that hand-rolling an `AbuseInstance` literal fails — if a future refactor relaxes the brand, the directive stops being "expected" and the build fails, flagging the regression.

**Impact:**
- The factory is now the *only* call site that can produce an `AbuseInstance` — the compiler enforces that, not a convention. Type-design rating moves from 1–2/5 → 5/5 on encapsulation + enforcement.
- Zero runtime cost. The brand is a phantom type; emitted JS is a plain object.
- Closes the exact enforcement gap #34 identified. The follow-up on #34 is retired.
- Incidentally fixed an aliasing smell: `events: readonly AbuseEvent[]` — callers can't accidentally mutate the array after construction.

**Category:** Type-level encapsulation. Brand-via-unique-symbol is a zero-runtime way to convert structural types into nominal ones. Generalizes: any time a factory encodes invariants that a plain object literal can bypass, brand the resulting type. The factory + schema then become the two privileged mint sites; every other path through the type system is a compile-time error.

---

## 36. `Percentage` / `Ratio` branded numerics — `errorRatePct` convention collision resolved at the type layer

**Date:** 2026-04-19
**Issue:** #1685
**PR:** refactor/abuse-hardening-bundle

**Problem:** `errorRatePct` appeared in four positions across the codebase with two incompatible scale conventions and nothing in the type system distinguishing them:

- `AbuseCounters.errorRatePct` on 0–100 (percentage).
- `AbuseThresholdConfig.errorRateThreshold` on 0–1 (ratio).
- `WorkspaceSLASummary.errorRatePct` / `SLAThresholds.errorRatePct` on 0–100 (opposite scale from the abuse threshold but same field name as the abuse counter).
- `ee/src/sla/metrics.ts` and `alerting.ts` computed / compared these with a mix of `Math.round(… / … * 10000) / 100`, raw `/ 100`, and direct comparisons.

Plain `number` was identical at every position. Type-design-analyzer flagged this as the classic "same name, two scales" pattern that the type system is supposed to catch — and PR #1681 nearly shipped exactly the regression the analyzer warned about: 1-decimal rounding of a 50.04% rate silently flipped `counters.errorRatePct / 100 > thresholds.errorRateThreshold` off while `checkThresholds` kept escalating on the unrounded fraction.

The specific failure mode was a boundary bug in the admin detail panel: `counters.errorRatePct / 100 > thresholds.errorRateThreshold`. Drop the `/ 100` and you're comparing a 50.04 to a 0.5 — wrong in either direction depending on the scale assumed. Nothing in the types told you which scale either side was on.

**Solution:** New `packages/types/src/percentage.ts` introduces two nominally-branded numeric types via phantom `unique symbol`:

```ts
declare const percentageBrand: unique symbol;
declare const ratioBrand: unique symbol;
export type Percentage = number & { readonly [percentageBrand]: never };
export type Ratio = number & { readonly [ratioBrand]: never };
export function asPercentage(n: number): Percentage { return n as Percentage; }
export function asRatio(n: number): Ratio { return n as Ratio; }
export function percentageToRatio(p: Percentage): Ratio { return (p / 100) as Ratio; }
export function ratioToPercentage(r: Ratio): Percentage { return (r * 100) as Percentage; }
```

The brands are zero-runtime — emitted JS is plain `number`. Only the four constructors can mint branded values; any plain-number expression fails typecheck in a branded position. Cross-scale comparison (`Percentage > Ratio`) fails typecheck without an explicit `percentageToRatio` / `ratioToPercentage` call.

Applied the brands through the entire stack:
- `@useatlas/types`: `AbuseCounters.errorRatePct: Percentage | null`, `AbuseThresholdConfig.errorRateThreshold: Ratio`, `WorkspaceSLASummary.errorRatePct / uptimePct: Percentage`, `SLAThresholds.errorRatePct: Percentage`.
- `errorRatePct()` helper (from win #34) returns `Percentage`.
- `getAbuseConfig()` wraps `envFloat("ATLAS_ABUSE_ERROR_RATE")` in `asRatio` at the env-var boundary.
- `detail-panel.tsx` uses `percentageToRatio(counters.errorRatePct) > thresholds.errorRateThreshold` instead of raw `/ 100`. Threshold display uses `ratioToPercentage`.
- Zod schemas transform-cast at the wire boundary: `z.number().transform((n): Percentage => asPercentage(n))` and similar for `Ratio`. `satisfies z.ZodType<…, unknown>` widens input so the schema stays drift-guarded while accepting plain-number input.
- SLA surfaces (ee/src/sla/{metrics,alerting}.ts) wrap DB-aggregated values in `asPercentage` at the point of construction.
- Platform SLA route brands the Zod-validated request body before calling the service layer.
- Web admin SLA dialog brands `parseFloat(e.target.value)` on the user-input side so `editThresholds: SLAThresholds` stays typed.

Tests cover both layers: runtime conversions (asPercentage / asRatio identity, percentageToRatio / ratioToPercentage math, round-trip precision at the 50.04% boundary that nearly regressed PR #1681) and compile-time invariants via `@ts-expect-error` directives for every cross-assignment that should fail (plain number → Percentage, plain number → Ratio, Percentage → Ratio without conversion, Ratio → Percentage without conversion). Any future refactor that erases the brand makes the directives stop being "expected" and the build fails.

**Impact:**
- The `errorRatePct / 100` footgun is now a compile-time error. A caller who forgets the conversion or applies it twice fails typecheck at the expression, not at runtime boundary rounding.
- Zero runtime cost. JS output is pure `number`; the brand erases.
- Abuse and SLA surfaces now share one vocabulary (`Percentage` = 0–100, `Ratio` = 0–1) — future code can't accidentally compare a Percentage to a Ratio the way PR #1681 nearly did.
- One new module (`percentage.ts`) with two types + four constructors. Ten production sites updated. The convention-collision problem is resolved at the type layer, not by adding comments ("this is 0–100" vs "this is 0–1") that rot.

**Category:** Type-level boundary enforcement for numeric units. Brand-via-unique-symbol converts structural `number` into nominal scale-specific types without runtime overhead. Generalizes to *any* unit-mixup risk: milliseconds vs seconds, bytes vs KB, basis points vs percentage, UTC vs local timestamps. Whenever the same primitive type means two incompatible things in different positions and the compiler silently lets you mix them, brand them. The explicit conversion call is the feature — it's where the bug would have been.
