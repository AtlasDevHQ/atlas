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
