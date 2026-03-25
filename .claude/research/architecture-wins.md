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
