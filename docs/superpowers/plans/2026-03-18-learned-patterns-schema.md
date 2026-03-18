# Learned Patterns Schema & CRUD API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `learned_patterns` table to the internal DB and CRUD admin endpoints for the 0.8.0 dynamic learning layer.

**Architecture:** New sub-router (`admin-learned-patterns.ts`) mounted in `admin.ts`, following the `admin-orgs.ts` precedent. Org-scoped with nullable `org_id` (semantic-org-style enforcement). Types exported from `@useatlas/types`. Config surface for confidence threshold via env var and `atlas.config.ts`.

**Tech Stack:** Hono, TypeScript, PostgreSQL (internal DB via `pg`), Zod (config validation), bun:test

**Spec:** `docs/superpowers/specs/2026-03-18-learned-patterns-schema-design.md`

**Branch:** `586-learned-patterns-schema` (create from `main`)

---

### Task 1: Create branch and types

**Files:**
- Create: `packages/types/src/learned-pattern.ts`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b 586-learned-patterns-schema main
```

- [ ] **Step 2: Create the types file**

Create `packages/types/src/learned-pattern.ts`:

```typescript
/** Learned query pattern types — wire format for the learned_patterns table. */

/** Status lifecycle for learned query patterns. */
export type LearnedPatternStatus = "pending" | "approved" | "rejected";

/** Who proposed the pattern. */
export type LearnedPatternSource = "agent" | "atlas-learn";

/** Wire format for the learned_patterns table. */
export interface LearnedPattern {
  id: string;
  orgId: string | null;
  patternSql: string;
  description: string | null;
  sourceEntity: string | null;
  sourceQueries: string[] | null;
  confidence: number;
  repetitionCount: number;
  status: LearnedPatternStatus;
  proposedBy: LearnedPatternSource | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}
```

- [ ] **Step 3: Add re-export to index.ts**

In `packages/types/src/index.ts`, add:

```typescript
export * from "./learned-pattern";
```

- [ ] **Step 4: Verify types compile**

Run: `bun run type`
Expected: PASS (no type errors)

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/learned-pattern.ts packages/types/src/index.ts
git commit -m "feat(types): add LearnedPattern types for dynamic learning layer (#586)"
```

---

### Task 2: Add DB schema

**Files:**
- Modify: `packages/api/src/lib/db/internal.ts` (append to `migrateInternalDB()`, around line 486)

- [ ] **Step 1: Add learned_patterns table to migrateInternalDB()**

Append before the final `log.info(...)` call in `migrateInternalDB()`:

```typescript
  // Learned query patterns (0.8.0 dynamic learning layer)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT,
      pattern_sql TEXT NOT NULL,
      description TEXT,
      source_entity TEXT,
      source_queries JSONB,
      confidence REAL NOT NULL DEFAULT 0.1,
      repetition_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      proposed_by TEXT,
      reviewed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_learned_patterns_org_status ON learned_patterns(org_id, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_learned_patterns_org_entity ON learned_patterns(org_id, source_entity);`);
```

- [ ] **Step 2: Update the migration log message**

Update the `log.info(...)` at the end of `migrateInternalDB()` to include `learned_patterns` in the table list.

- [ ] **Step 3: Verify types compile**

Run: `bun run type`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/lib/db/internal.ts
git commit -m "feat(db): add learned_patterns table schema and indexes (#586)"
```

---

### Task 3: Add config surface

**Files:**
- Modify: `packages/api/src/lib/config.ts`

Four changes:

1. **Zod schema** — add `learn` to `AtlasConfigSchema` (after `cache`, around line 347)
2. **ResolvedConfig** — add `learn?` field (after `cache?`, around line 394)
3. **configFromEnv()** — add env var parsing (after the cache IIFE block, around line 565)
4. **validateAndResolve()** — add `learn` spread (after `cache` spread, around line 914)

- [ ] **Step 1: Add learn to AtlasConfigSchema**

After the `cache` schema block (around line 347), add:

```typescript
  /**
   * Dynamic learning configuration. Controls how learned query patterns
   * are promoted and injected into agent context.
   */
  learn: z.object({
    /** Minimum confidence score for a pattern to be eligible for auto-promotion. Default: 0.7. */
    confidenceThreshold: z.number().min(0).max(1).default(0.7),
  }).optional(),
```

- [ ] **Step 2: Add learn to ResolvedConfig**

After the `cache?` field in the `ResolvedConfig` interface, add:

```typescript
  /** Dynamic learning configuration. */
  learn?: { confidenceThreshold: number };
```

- [ ] **Step 3: Add env var parsing to configFromEnv()**

After the cache IIFE block (around line 565), before `source: "env"`, add:

```typescript
    // Learn config from env vars
    ...((() => {
      const threshold = parseFloat(process.env.ATLAS_LEARN_CONFIDENCE_THRESHOLD ?? "");
      return {
        learn: {
          confidenceThreshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : 0.7,
        },
      };
    })()),
```

- [ ] **Step 4: Add learn spread to validateAndResolve()**

After the `cache` spread in `validateAndResolve()` (around line 914), add:

```typescript
    ...(config.learn ? { learn: config.learn } : {}),
```

- [ ] **Step 5: Verify types compile**

Run: `bun run type`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/config.ts
git commit -m "feat(config): add ATLAS_LEARN_CONFIDENCE_THRESHOLD config surface (#586)"
```

---

### Task 4: Write test file for admin learned-patterns routes

**Files:**
- Create: `packages/api/src/api/__tests__/admin-learned-patterns.test.ts`

This task creates the full test file. The test mocking pattern follows `admin-settings.test.ts` exactly — mock all exports from auth/middleware, auth/detect, startup, db/connection, semantic, and db/internal.

The test uses a mock `internalQuery` that stores an array of "rows" and returns them based on the SQL query string. This lets tests insert mock data and verify the routes read/write correctly.

- [ ] **Step 1: Create the test file with mock setup and auth tests**

Create `packages/api/src/api/__tests__/admin-learned-patterns.test.ts`.

Mock setup requirements (mock ALL named exports per CLAUDE.md):
- `@atlas/api/lib/auth/middleware`: `authenticateRequest`, `checkRateLimit`, `getClientIP`, `resetRateLimits`, `_stopCleanup`, `_setValidatorOverrides`
- `@atlas/api/lib/auth/detect`: `detectAuthMode`, `resetAuthModeCache`
- `@atlas/api/lib/startup`: `validateEnvironment`, `getStartupWarnings`
- `@atlas/api/lib/db/connection`: use `createConnectionMock()` from `@atlas/api/testing/connection`
- `@atlas/api/lib/semantic`: `getOrgWhitelistedTables`, `loadOrgWhitelist`, `invalidateOrgWhitelist`, `getOrgSemanticIndex`, `invalidateOrgSemanticIndex`, `_resetOrgWhitelists`, `_resetOrgSemanticIndexes`, `getWhitelistedTables`, `getCrossSourceJoins`, `_resetWhitelists`, `registerPluginEntities`, `_resetPluginEntities`
- `@atlas/api/lib/db/internal`: `hasInternalDB`, `internalQuery`, `internalExecute`, `getInternalDB`, `closeInternalDB`, `migrateInternalDB`, `loadSavedConnections`, `_resetPool`, `_resetCircuitBreaker`, `encryptUrl`, `decryptUrl`, `getEncryptionKey`, `isPlaintextUrl`, `_resetEncryptionKeyCache`

Also need temp semantic fixtures (same as admin-settings.test.ts):
```typescript
const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-lp-test-${Date.now()}`);
fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, "entities", "stub.yml"), "table: stub\ndescription: stub\ndimensions:\n  id:\n    type: integer\n");
fs.writeFileSync(path.join(tmpRoot, "catalog.yml"), "name: Test\n");
process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;
```

The `mockInternalQuery` should be a `Mock` that can be configured per-test to return different row sets. Use `mockInternalQuery.mockImplementation(...)` in tests.

Default auth mock returns:
```typescript
{
  authenticated: true,
  mode: "simple-key",
  user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
}
```

Import the app after all mocks:
```typescript
const { app } = await import("@atlas/api/api");
```

Helper to make requests:
```typescript
function req(method: string, path: string, body?: unknown) {
  const url = `http://localhost/api/v1/admin/learned-patterns${path}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}
```

Sample mock row factory:
```typescript
function mockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pat-1",
    org_id: "org-1",
    pattern_sql: "SELECT COUNT(*) FROM orders",
    description: "Order count",
    source_entity: "orders",
    source_queries: JSON.stringify(["audit-1"]),
    confidence: 0.8,
    repetition_count: 5,
    status: "pending",
    proposed_by: "agent",
    reviewed_by: null,
    created_at: "2026-03-18T00:00:00Z",
    updated_at: "2026-03-18T00:00:00Z",
    reviewed_at: null,
    ...overrides,
  };
}
```

Test groups to include:

**Auth gating:**
- `it("returns 403 for non-admin user")` — set mock auth to `role: "member"`, GET `/`, expect 403
- `it("returns 401 for unauthenticated")` — set mock auth to `{ authenticated: false, error: "Invalid token", status: 401 }`, GET `/`, expect 401

**No internal DB:**
- `it("returns 404 when no internal DB")` — set `mockHasInternalDB = false`, GET `/`, expect 404 with `not_available`

**Rate limiting:**
- `it("returns 429 when rate limited")` — set `checkRateLimit` to return `{ allowed: false, retryAfterMs: 60000 }`, GET `/`, expect 429 with `retryAfterSeconds`

**GET / (list):**
- `it("returns patterns with pagination")` — mock internalQuery to return count + rows, verify response shape `{ patterns, total, limit, offset }`
- `it("defaults limit to 50 and offset to 0")` — GET `/` without params, verify SQL uses LIMIT 50 OFFSET 0
- `it("caps limit at 200")` — GET `/?limit=500`, verify SQL uses LIMIT 200
- `it("applies status filter")` — GET `/?status=approved`, verify SQL includes `status = $N`
- `it("applies source_entity filter")` — GET `/?source_entity=orders`, verify SQL
- `it("applies confidence range")` — GET `/?min_confidence=0.5&max_confidence=0.9`, verify SQL
- `it("applies combined filters")` — GET `/?status=pending&source_entity=orders&min_confidence=0.5`, verify SQL

**GET /:id:**
- `it("returns single pattern")` — mock query returning one row, verify 200
- `it("returns 404 for missing pattern")` — mock query returning empty, verify 404

**PATCH /:id:**
- `it("updates description")` — PATCH with `{ description: "Updated" }`, verify UPDATE SQL
- `it("updates status with reviewed_by and reviewed_at")` — PATCH with `{ status: "approved" }`, verify SQL sets `reviewed_by`, `reviewed_at`
- `it("returns 400 for invalid status")` — PATCH with `{ status: "invalid" }`, expect 400
- `it("returns 404 for missing pattern")` — mock empty select, expect 404

**DELETE /:id:**
- `it("deletes pattern")` — DELETE, verify DELETE SQL
- `it("returns 404 for missing pattern")` — mock empty select on ownership check, expect 404

**POST /bulk:**
- `it("bulk approves patterns")` — POST with `{ ids: ["pat-1", "pat-2"], status: "approved" }`, verify updates
- `it("returns partial results for mixed ids")` — some IDs exist, some don't
- `it("returns 400 for empty ids")` — POST with `{ ids: [] }`, expect 400
- `it("returns 400 for too many ids")` — POST with 101 IDs, expect 400
- `it("returns 400 for invalid status")` — POST with `{ ids: ["pat-1"], status: "pending" }`, expect 400

**Org-scoping:**
- `it("filters by org_id from session")` — verify queries include `org_id = $N` with `org-1`
- `it("filters by org_id IS NULL in single-tenant")` — set `activeOrganizationId: undefined`, verify queries include `org_id IS NULL`

**Error handling:**
- `it("returns 500 with requestId on DB error")` — mock `internalQuery` to throw, verify response includes `{ error: "internal_error", requestId }` with a valid requestId string

- [ ] **Step 2: Verify test file compiles**

Run: `bun run type`
Expected: PASS

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/api/src/api/__tests__/admin-learned-patterns.test.ts`
Expected: FAIL — routes don't exist yet, expect 404s on all route calls

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/api/__tests__/admin-learned-patterns.test.ts
git commit -m "test: add learned-patterns admin route tests (#586)"
```

---

### Task 5: Implement admin-learned-patterns sub-router

**Files:**
- Create: `packages/api/src/api/routes/admin-learned-patterns.ts`
- Modify: `packages/api/src/api/routes/admin.ts` (2 lines: import + mount)

- [ ] **Step 1: Create the sub-router file**

Create `packages/api/src/api/routes/admin-learned-patterns.ts`.

Structure (follow `admin-orgs.ts` pattern):

```typescript
/**
 * Admin learned patterns routes.
 *
 * Mounted at /api/v1/admin/learned-patterns. All routes require admin role.
 * CRUD for learned query patterns — the foundation of the 0.8.0 dynamic
 * learning layer. Patterns are org-scoped (nullable org_id for single-tenant).
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { LearnedPattern } from "@useatlas/types";

const log = createLogger("admin-learned-patterns");
```

Key implementation details:

**`adminAuthPreamble()`** — copy from `admin.ts` (lines 51-115, NOT from `admin-orgs.ts`). Must include `EXPIRED_AUTH_ERRORS` set, `authErrorCode()` helper, and rate limiting. Uses `"forbidden_role"` error code (not `"forbidden"` as in `admin-orgs.ts`). Uses global `crypto.randomUUID()` for request IDs (no `crypto` import needed).

**`toLearnedPattern(row)`** — snake_case to camelCase mapper:
```typescript
function toLearnedPattern(row: Record<string, unknown>): LearnedPattern {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? null,
    patternSql: row.pattern_sql as string,
    description: (row.description as string) ?? null,
    sourceEntity: (row.source_entity as string) ?? null,
    sourceQueries: row.source_queries ? (typeof row.source_queries === "string" ? JSON.parse(row.source_queries) : row.source_queries) as string[] : null,
    confidence: row.confidence as number,
    repetitionCount: row.repetition_count as number,
    status: row.status as LearnedPattern["status"],
    proposedBy: (row.proposed_by as LearnedPattern["proposedBy"]) ?? null,
    reviewedBy: (row.reviewed_by as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  };
}
```

**Org filter helper:**
```typescript
/** Build the org_id WHERE clause fragment and push the param if needed. */
function orgFilter(orgId: string | null | undefined, params: unknown[], paramIdx: number): { clause: string; nextIdx: number } {
  if (orgId) {
    params.push(orgId);
    return { clause: `org_id = $${paramIdx}`, nextIdx: paramIdx + 1 };
  }
  return { clause: `org_id IS NULL`, nextIdx: paramIdx };
}
```

**Valid statuses:**
```typescript
const VALID_STATUSES = new Set(["pending", "approved", "rejected"]);
const BULK_STATUSES = new Set(["approved", "rejected"]);
```

**Endpoints** (each follows the preamble + hasInternalDB guard + withRequestContext pattern from admin.ts):

1. **GET `/`** — build dynamic WHERE from org_id + optional filters (status, source_entity, min_confidence, max_confidence). Two queries: COUNT for total, then SELECT with LIMIT/OFFSET.

2. **GET `/:id`** — SELECT by id + org_id filter. 404 if empty result.

3. **PATCH `/:id`** — Parse body. Validate status if present. Check pattern exists (SELECT id). Build dynamic UPDATE SET clauses. Always set `updated_at = now()`. If status changes, also set `reviewed_by` and `reviewed_at = now()`.

4. **DELETE `/:id`** — Check exists via `internalQuery` (SELECT id + org_id). DELETE via `internalQuery` (not `internalExecute` — need to confirm deletion). 404 if not found.

5. **POST `/bulk`** — Validate body: ids non-empty array, max 100, status in BULK_STATUSES. For each id: SELECT to check existence + org, UPDATE if found. Collect `updated` and `notFound` arrays.

All 500 responses include `requestId`:
```typescript
return c.json({ error: "internal_error", message: "Failed to query learned patterns.", requestId }, 500);
```

Export: `export { adminLearnedPatterns };`

- [ ] **Step 2: Mount the sub-router in admin.ts**

In `packages/api/src/api/routes/admin.ts`:

Add import (near line 46, after `admin-orgs` import):
```typescript
import { adminLearnedPatterns } from "./admin-learned-patterns";
```

Add mount (near line 65, after the organizations mount):
```typescript
admin.route("/learned-patterns", adminLearnedPatterns);
```

- [ ] **Step 3: Verify types compile**

Run: `bun run type`
Expected: PASS

- [ ] **Step 4: Run tests**

Run: `bun test packages/api/src/api/__tests__/admin-learned-patterns.test.ts`
Expected: PASS — all tests should pass now

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: PASS — no regressions

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/api/routes/admin-learned-patterns.ts packages/api/src/api/routes/admin.ts
git commit -m "feat(api): add learned-patterns admin CRUD sub-router (#586)"
```

---

### Task 6: CI gates and cleanup

**Files:** None new — verification only.

- [ ] **Step 1: Run lint**

Run: `bun run lint`
Expected: PASS

- [ ] **Step 2: Run type check**

Run: `bun run type`
Expected: PASS

- [ ] **Step 3: Run tests**

Run: `bun run test`
Expected: PASS

- [ ] **Step 4: Run syncpack**

Run: `bun x syncpack lint`
Expected: PASS

- [ ] **Step 5: Run template drift check**

Run: `SKIP_SYNCPACK=1 bash scripts/check-template-drift.sh`
Expected: PASS

- [ ] **Step 6: Update roadmap**

Update `apps/docs/content/docs/roadmap.mdx` — in the 0.8.0 section, add a note that the learned patterns schema has shipped. This is a lightweight update, not a full roadmap rewrite.

- [ ] **Step 7: Commit roadmap update**

```bash
git add apps/docs/content/docs/roadmap.mdx
git commit -m "docs: note learned_patterns schema shipped in 0.8.0 roadmap (#586)"
```

---

### File Map Summary

| File | Action | Task |
|------|--------|------|
| `packages/types/src/learned-pattern.ts` | Create | 1 |
| `packages/types/src/index.ts` | Modify (1 line) | 1 |
| `packages/api/src/lib/db/internal.ts` | Modify (append ~15 lines) | 2 |
| `packages/api/src/lib/config.ts` | Modify (4 insertions) | 3 |
| `packages/api/src/api/__tests__/admin-learned-patterns.test.ts` | Create | 4 |
| `packages/api/src/api/routes/admin-learned-patterns.ts` | Create | 5 |
| `packages/api/src/api/routes/admin.ts` | Modify (2 lines) | 5 |
| `apps/docs/content/docs/roadmap.mdx` | Modify (1-2 lines) | 6 |
