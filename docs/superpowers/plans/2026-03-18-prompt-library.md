# Prompt Library + LRU Eviction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix unbounded pattern cache growth (#601) and add curated per-industry prompt collections with admin CRUD, user-facing API, and chat UI integration (#590).

**Architecture:** Bug fix first (LRU eviction in pattern-cache.ts), then layered prompt library: shared types → DB schema + seed → user-facing API routes → admin CRUD routes → admin UI page → chat Sheet component. Each layer builds on the previous and is independently testable.

**Tech Stack:** TypeScript, Hono, PostgreSQL (internal DB), Next.js, shadcn/ui (Sheet, Accordion, Dialog, DataTable), nuqs (URL state), Lucide icons.

**Spec:** `docs/superpowers/specs/2026-03-18-prompt-library-design.md`

---

### Task 1: LRU eviction for pattern cache (#601)

**Files:**
- Modify: `packages/api/src/lib/learn/pattern-cache.ts`
- Create: `packages/api/src/lib/__tests__/pattern-cache.test.ts`

- [ ] **Step 1: Write the eviction test**

Create `packages/api/src/lib/__tests__/pattern-cache.test.ts`. The test file needs the same mock setup as `pattern-injection.test.ts` (mock `@atlas/api/lib/db/internal`, `@atlas/api/lib/config`, `@atlas/api/lib/db/connection`, `@atlas/api/lib/logger`). Copy the mock block from `packages/api/src/lib/__tests__/pattern-injection.test.ts` lines 1–79.

Add a test that:
1. Sets `mockApprovedPatterns` to a single pattern with keyword `"revenue"` and confidence 0.9
2. Populates the cache for 501 distinct org keys (`org:0` through `org:500`) by calling `getRelevantPatterns("org:N", "revenue")` for each
3. Verifies the cache evicted at least one entry by calling `getRelevantPatterns("org:0", "revenue")` again — which should re-fetch (the mock can track call count via `getApprovedPatterns`)
4. Verifies a recently accessed org (e.g. `org:500`) still returns cached data without re-fetching

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mock state ---
let mockApprovedPatterns: Array<{
  id: string;
  org_id: string | null;
  pattern_sql: string;
  description: string | null;
  source_entity: string | null;
  confidence: number;
}> = [];

let mockConfigLearn: { confidenceThreshold: number } | undefined = {
  confidenceThreshold: 0.7,
};

let getApprovedPatternsCallCount = 0;

// --- Mocks (all named exports) ---

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: async () => ({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: async () => [],
  internalExecute: () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  migrateInternalDB: async () => {},
  closeInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  getEncryptionKey: () => null,
  _resetEncryptionKeyCache: () => {},
  encryptUrl: (v: string) => v,
  decryptUrl: (v: string) => v,
  isPlaintextUrl: () => true,
  getApprovedPatterns: async () => {
    getApprovedPatternsCallCount++;
    return mockApprovedPatterns;
  },
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  incrementPatternCount: () => {},
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({
    learn: mockConfigLearn,
    semanticIndex: { enabled: false },
  }),
  loadConfig: async () => ({}),
  configFromEnv: () => ({}),
  defineConfig: (c: unknown) => c,
  applyDatasources: async () => {},
  validateToolConfig: async () => {},
  initializeConfig: async () => ({}),
  _resetConfig: () => {},
  _setConfigForTest: () => {},
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock(),
);

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

const {
  getRelevantPatterns,
  _resetPatternCache,
} = await import("@atlas/api/lib/learn/pattern-cache");

describe("pattern cache LRU eviction", () => {
  beforeEach(() => {
    _resetPatternCache();
    mockApprovedPatterns = [{
      id: "1",
      org_id: null,
      pattern_sql: "SELECT SUM(revenue) FROM companies",
      description: "Total revenue",
      source_entity: "companies",
      confidence: 0.9,
    }];
    mockConfigLearn = { confidenceThreshold: 0.7 };
    getApprovedPatternsCallCount = 0;
  });

  test("evicts oldest entry when cache exceeds MAX_ENTRIES", async () => {
    // Fill cache with 501 org entries (MAX_ENTRIES = 500)
    for (let i = 0; i <= 500; i++) {
      await getRelevantPatterns(`org:${i}`, "revenue");
    }

    // All 501 calls should have hit the DB
    expect(getApprovedPatternsCallCount).toBe(501);

    // org:0 should have been evicted (oldest) — fetching again hits DB
    const countBefore = getApprovedPatternsCallCount;
    await getRelevantPatterns("org:0", "revenue");
    expect(getApprovedPatternsCallCount).toBe(countBefore + 1);

    // org:500 should still be cached — fetching again does NOT hit DB
    const countBefore2 = getApprovedPatternsCallCount;
    await getRelevantPatterns("org:500", "revenue");
    expect(getApprovedPatternsCallCount).toBe(countBefore2);
  });

  test("updates lastAccessedAt on cache hit to prevent eviction", async () => {
    // Fill 499 entries
    for (let i = 0; i < 499; i++) {
      await getRelevantPatterns(`org:${i}`, "revenue");
    }

    // Access org:0 again (refreshes lastAccessedAt)
    await getRelevantPatterns("org:0", "revenue");

    // Fill 2 more to trigger eviction (total 501)
    await getRelevantPatterns("org:499", "revenue");
    await getRelevantPatterns("org:500", "revenue");

    // org:0 was recently accessed, so it should still be cached
    const countBefore = getApprovedPatternsCallCount;
    await getRelevantPatterns("org:0", "revenue");
    expect(getApprovedPatternsCallCount).toBe(countBefore);

    // org:1 was NOT accessed again, so it should have been evicted
    const countBefore2 = getApprovedPatternsCallCount;
    await getRelevantPatterns("org:1", "revenue");
    expect(getApprovedPatternsCallCount).toBe(countBefore2 + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/api/src/lib/__tests__/pattern-cache.test.ts`
Expected: FAIL — cache never evicts, so org:0 stays cached even after 501 entries.

- [ ] **Step 3: Implement LRU eviction**

In `packages/api/src/lib/learn/pattern-cache.ts`:

1. Add `MAX_ENTRIES` constant after `DEFAULT_TTL_MS`:
```typescript
const MAX_ENTRIES = 500;
```

2. Add `lastAccessedAt` to `CacheEntry`:
```typescript
interface CacheEntry {
  patterns: ApprovedPatternRow[];
  expiresAt: number;
  lastAccessedAt: number;
}
```

3. In `getCachedPatterns`, update `lastAccessedAt` on cache hit (around line 39):
```typescript
  if (entry && Date.now() < entry.expiresAt) {
    entry.lastAccessedAt = Date.now();
    return entry.patterns;
  }
```

4. In `getCachedPatterns`, add eviction before `cache.set()` (around line 45):
```typescript
    const patterns = await getApprovedPatterns(orgId);
    // Evict oldest entry if cache is at capacity
    if (cache.size >= MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of cache) {
        if (v.lastAccessedAt < oldestTime) {
          oldestTime = v.lastAccessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) cache.delete(oldestKey);
    }
    const now = Date.now();
    cache.set(key, { patterns, expiresAt: now + DEFAULT_TTL_MS, lastAccessedAt: now });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/api/src/lib/__tests__/pattern-cache.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing pattern-injection tests to ensure no regressions**

Run: `bun test packages/api/src/lib/__tests__/pattern-injection.test.ts`
Expected: PASS — all existing tests should still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/learn/pattern-cache.ts packages/api/src/lib/__tests__/pattern-cache.test.ts
git commit -m "fix: add LRU eviction to learned pattern cache (#601)

Cap in-memory pattern cache at 500 entries with lastAccessedAt-based
eviction. Prevents unbounded growth in multi-tenant deployments."
```

---

### Task 2: Prompt types in @useatlas/types

**Files:**
- Create: `packages/types/src/prompt.ts`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Create prompt types**

Create `packages/types/src/prompt.ts`:

```typescript
/** Prompt library types — wire format for prompt_collections and prompt_items tables. */

/** All valid prompt industries for built-in collections. */
export const PROMPT_INDUSTRIES = ["saas", "ecommerce", "cybersecurity"] as const;
export type PromptIndustry = (typeof PROMPT_INDUSTRIES)[number];

/** Wire format for the prompt_collections table. */
export interface PromptCollection {
  id: string;
  orgId: string | null;
  name: string;
  industry: string;
  description: string;
  isBuiltin: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Wire format for the prompt_items table. */
export interface PromptItem {
  id: string;
  collectionId: string;
  question: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Export from index**

Add to `packages/types/src/index.ts`:
```typescript
export * from "./prompt";
```

- [ ] **Step 3: Re-export from web types**

Add to `packages/web/src/ui/lib/types.ts` in the `export type { ... } from "@useatlas/types"` block:
```typescript
  PromptCollection,
  PromptItem,
  PromptIndustry,
```

And add to the `export { ... } from "@useatlas/types"` values block:
```typescript
export { AUTH_MODES, DB_TYPES, SHARE_EXPIRY_OPTIONS, PROMPT_INDUSTRIES } from "@useatlas/types";
```

- [ ] **Step 4: Verify types compile**

Run: `bun run type`
Expected: PASS (or only pre-existing errors).

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/prompt.ts packages/types/src/index.ts packages/web/src/ui/lib/types.ts
git commit -m "feat(types): add PromptCollection and PromptItem types (#590)"
```

---

### Task 3: DB schema + seed data

**Files:**
- Modify: `packages/api/src/lib/db/internal.ts`

- [ ] **Step 1: Add prompt tables to migrateInternalDB()**

In `packages/api/src/lib/db/internal.ts`, add the following after the `learned_patterns` table creation (before the `log.info("Internal DB migration complete ...")` line):

```typescript
  // Prompt library (0.8.0)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_collections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT,
      name TEXT NOT NULL,
      industry TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_builtin BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_collections_org ON prompt_collections(org_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_collections_builtin ON prompt_collections(is_builtin) WHERE is_builtin = true;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      collection_id UUID NOT NULL REFERENCES prompt_collections(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      description TEXT,
      category TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_items_collection ON prompt_items(collection_id);`);

  // Seed built-in prompt collections
  await seedPromptLibrary(pool);
```

Update the `log.info` message to include `prompt_collections, prompt_items`.

- [ ] **Step 2: Add seedPromptLibrary() function**

Add below `migrateInternalDB()` in the same file. The function is idempotent per-collection (checks by name):

```typescript
/** Seed built-in prompt collections. Idempotent — checks each collection by name. */
async function seedPromptLibrary(pool: InternalPool): Promise<void> {
  const collections: Array<{
    name: string;
    industry: string;
    description: string;
    items: Array<{ question: string; description: string; category: string }>;
  }> = [
    {
      name: "SaaS Metrics",
      industry: "saas",
      description: "Key metrics for SaaS businesses including revenue, churn, and growth indicators.",
      items: [
        { question: "What is our current MRR and how has it trended over the last 12 months?", description: "Monthly recurring revenue trend", category: "Revenue" },
        { question: "What is our monthly churn rate by plan type?", description: "Customer churn segmented by subscription tier", category: "Churn" },
        { question: "What is the average customer lifetime value (LTV) by acquisition channel?", description: "LTV breakdown by how customers were acquired", category: "Revenue" },
        { question: "What is our customer acquisition cost (CAC) by channel?", description: "Cost to acquire customers across marketing channels", category: "Growth" },
        { question: "What is the LTV to CAC ratio by plan type?", description: "Unit economics health check", category: "Revenue" },
        { question: "What is our net revenue retention rate?", description: "Expansion revenue minus churn and contraction", category: "Retention" },
        { question: "What is the average revenue per user (ARPU) trend?", description: "Revenue per user over time", category: "Revenue" },
        { question: "How many trials converted to paid subscriptions this month?", description: "Trial-to-paid conversion rate", category: "Growth" },
        { question: "What is the expansion revenue from upsells and cross-sells?", description: "Revenue growth from existing customers", category: "Revenue" },
        { question: "What are the top reasons for customer cancellation?", description: "Churn reason analysis", category: "Churn" },
        { question: "What is our monthly active user (MAU) trend?", description: "Product engagement over time", category: "Engagement" },
        { question: "What is the average time to first value for new customers?", description: "Onboarding speed metric", category: "Engagement" },
      ],
    },
    {
      name: "E-commerce KPIs",
      industry: "ecommerce",
      description: "Essential KPIs for e-commerce businesses covering sales, conversion, and inventory.",
      items: [
        { question: "What is our gross merchandise volume (GMV) this month vs last month?", description: "Total sales volume comparison", category: "Sales" },
        { question: "What is our average order value (AOV) by product category?", description: "AOV segmented by category", category: "Sales" },
        { question: "What is our cart abandonment rate and at which step do most users drop off?", description: "Checkout funnel analysis", category: "Conversion" },
        { question: "What are the top 10 products by revenue this quarter?", description: "Best-selling products ranked by revenue", category: "Products" },
        { question: "What is our conversion rate from visit to purchase by traffic source?", description: "Conversion funnel by acquisition channel", category: "Conversion" },
        { question: "What is the return rate by product category?", description: "Product return analysis", category: "Operations" },
        { question: "What is the average delivery time by region?", description: "Fulfillment speed by geography", category: "Operations" },
        { question: "What is the customer repeat purchase rate?", description: "Percentage of customers who buy again", category: "Retention" },
        { question: "Which product categories have the highest profit margins?", description: "Margin analysis by category", category: "Profitability" },
        { question: "What is the inventory turnover rate by product?", description: "How quickly inventory sells", category: "Inventory" },
        { question: "What is the customer satisfaction score (CSAT) trend?", description: "Customer satisfaction over time", category: "Experience" },
        { question: "What are the peak sales hours and days of the week?", description: "Sales timing patterns", category: "Sales" },
      ],
    },
    {
      name: "Cybersecurity Compliance",
      industry: "cybersecurity",
      description: "Security and compliance metrics for cybersecurity monitoring and reporting.",
      items: [
        { question: "How many open vulnerabilities do we have by severity level?", description: "Vulnerability count by critical/high/medium/low", category: "Vulnerabilities" },
        { question: "What is our average time to patch critical vulnerabilities?", description: "Mean time to remediate critical findings", category: "Vulnerabilities" },
        { question: "What is the compliance score across our security frameworks?", description: "Overall compliance posture", category: "Compliance" },
        { question: "How many security incidents occurred this month by type?", description: "Incident count segmented by category", category: "Incidents" },
        { question: "What is our mean time to detect (MTTD) and mean time to respond (MTTR)?", description: "Incident response speed metrics", category: "Incidents" },
        { question: "What percentage of endpoints have up-to-date security agents?", description: "Endpoint protection coverage", category: "Assets" },
        { question: "What is the phishing simulation click rate trend?", description: "Security awareness training effectiveness", category: "Training" },
        { question: "How many failed login attempts occurred by user and region?", description: "Brute force and credential stuffing detection", category: "Access" },
        { question: "What is the status of our third-party vendor risk assessments?", description: "Vendor security review completion", category: "Compliance" },
        { question: "What percentage of systems are compliant with our patching policy?", description: "Patch compliance rate", category: "Vulnerabilities" },
        { question: "What are the top firewall-blocked threats this week?", description: "Network threat intelligence summary", category: "Network" },
        { question: "What is the data classification breakdown across our storage systems?", description: "Sensitive data inventory", category: "Data" },
      ],
    },
  ];

  for (let ci = 0; ci < collections.length; ci++) {
    const collection = collections[ci];
    // Check if this collection already exists
    const existing = await pool.query(
      `SELECT id FROM prompt_collections WHERE name = $1 AND is_builtin = true`,
      [collection.name],
    );
    if (existing.rows.length > 0) continue;

    // Insert collection
    const result = await pool.query(
      `INSERT INTO prompt_collections (name, industry, description, is_builtin, sort_order)
       VALUES ($1, $2, $3, true, $4) RETURNING id`,
      [collection.name, collection.industry, collection.description, ci],
    );
    const collectionId = (result.rows[0] as Record<string, unknown>).id as string;

    // Insert items
    for (let i = 0; i < collection.items.length; i++) {
      const item = collection.items[i];
      await pool.query(
        `INSERT INTO prompt_items (collection_id, question, description, category, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [collectionId, item.question, item.description, item.category, i],
      );
    }
  }
}
```

- [ ] **Step 3: Verify types compile**

Run: `bun run type`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/lib/db/internal.ts
git commit -m "feat(api): add prompt_collections and prompt_items schema with seed data (#590)

Three built-in collections (SaaS, e-commerce, cybersecurity) with 12
prompts each. Idempotent per-collection seeding."
```

---

### Task 4: User-facing prompt API routes

**Files:**
- Create: `packages/api/src/api/routes/prompts.ts`
- Modify: `packages/api/src/api/index.ts`

- [ ] **Step 1: Create user-facing prompt routes**

Create `packages/api/src/api/routes/prompts.ts`. Follow the pattern from `semantic.ts` — use `authPreamble`, `withRequestContext`, `hasInternalDB()` guard, `requestId` on 500s:

```typescript
/**
 * User-facing prompt library routes.
 *
 * Mounted at /api/v1/prompts. Available to all authenticated users.
 * Returns built-in prompt collections plus the user's org-specific collections.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { PromptCollection, PromptItem } from "@useatlas/types";
import { authPreamble } from "./auth-preamble";

const log = createLogger("prompt-routes");

export const prompts = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPromptCollection(row: Record<string, unknown>): PromptCollection {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? null,
    name: row.name as string,
    industry: row.industry as string,
    description: (row.description as string) ?? "",
    isBuiltin: row.is_builtin as boolean,
    sortOrder: row.sort_order as number,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPromptItem(row: Record<string, unknown>): PromptItem {
  return {
    id: row.id as string,
    collectionId: row.collection_id as string,
    question: row.question as string,
    description: (row.description as string) ?? null,
    category: (row.category as string) ?? null,
    sortOrder: row.sort_order as number,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// GET / — list collections
// ---------------------------------------------------------------------------

prompts.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ collections: [] });
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const orgId = authResult.user?.activeOrganizationId;
      const rows = orgId
        ? await internalQuery<Record<string, unknown>>(
            `SELECT * FROM prompt_collections WHERE org_id IS NULL OR org_id = $1 ORDER BY sort_order ASC, created_at ASC`,
            [orgId],
          )
        : await internalQuery<Record<string, unknown>>(
            `SELECT * FROM prompt_collections WHERE org_id IS NULL ORDER BY sort_order ASC, created_at ASC`,
          );

      return c.json({ collections: rows.map(toPromptCollection) });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list prompt collections");
      return c.json({ error: "internal_error", message: "Failed to list prompt collections.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id — collection detail with items
// ---------------------------------------------------------------------------

prompts.get("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const id = c.req.param("id");
      const orgId = authResult.user?.activeOrganizationId;

      // Org-scoped lookup — user can only see built-in (org_id IS NULL) or their org's collections
      const collectionRows = orgId
        ? await internalQuery<Record<string, unknown>>(
            `SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`,
            [id, orgId],
          )
        : await internalQuery<Record<string, unknown>>(
            `SELECT * FROM prompt_collections WHERE id = $1 AND org_id IS NULL`,
            [id],
          );

      if (collectionRows.length === 0) {
        return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
      }

      const items = await internalQuery<Record<string, unknown>>(
        `SELECT * FROM prompt_items WHERE collection_id = $1 ORDER BY sort_order ASC, created_at ASC`,
        [id],
      );

      return c.json({
        collection: toPromptCollection(collectionRows[0]),
        items: items.map(toPromptItem),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to get prompt collection");
      return c.json({ error: "internal_error", message: "Failed to get prompt collection.", requestId }, 500);
    }
  });
});
```

- [ ] **Step 2: Mount in api/index.ts**

In `packages/api/src/api/index.ts`, add import (after the `validateSqlRoute` import around line 29):
```typescript
import { prompts } from "./routes/prompts";
```

Add mounting (after `app.route("/api/v1/validate-sql", validateSqlRoute);` around line 111):
```typescript
app.route("/api/v1/prompts", prompts);
```

- [ ] **Step 3: Verify types compile**

Run: `bun run type`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/api/routes/prompts.ts packages/api/src/api/index.ts
git commit -m "feat(api): add user-facing prompt library routes (#590)

GET /api/v1/prompts — list collections (built-in + org)
GET /api/v1/prompts/:id — collection detail with items
Both org-scoped and guarded by hasInternalDB()."
```

---

### Task 5: Admin prompt CRUD routes

**Files:**
- Create: `packages/api/src/api/routes/admin-prompts.ts`
- Modify: `packages/api/src/api/routes/admin.ts`

- [ ] **Step 1: Create admin CRUD routes**

Create `packages/api/src/api/routes/admin-prompts.ts`. Follow the pattern from `admin-learned-patterns.ts` — use `adminAuthPreamble`, `hasInternalDB()` guard, `withRequestContext`, `requestId` on 500s, `orgFilter` helper. Re-use the `toPromptCollection` and `toPromptItem` helpers (define them locally as in the learned patterns file).

Implement these endpoints:
- `GET /` — list all collections (admin view: `WHERE org_id IS NULL OR org_id = $orgId` — includes built-in + own org)
- `POST /` — create collection (sets org_id to admin's activeOrganizationId)
- `PATCH /:id` — update collection (reject built-in → 403, verify org ownership)
- `DELETE /:id` — delete collection (reject built-in → 403, verify org ownership, cascade deletes items)
- `POST /:id/items` — add item (verify collection exists, reject built-in → 403, verify org ownership)
- `PATCH /:collectionId/items/:itemId` — update item (reject built-in → 403, verify collection ownership)
- `DELETE /:collectionId/items/:itemId` — delete item (reject built-in → 403, verify collection ownership)
- `PUT /:id/reorder` — reorder items (body: `{ itemIds: string[] }`, verify all IDs match collection, set sort_order = array index)

Key security checks on every mutation:
1. `hasInternalDB()` → 404 if no internal DB
2. Collection exists and belongs to admin's org (org_id = activeOrganizationId)
3. Collection is NOT built-in — if `is_builtin = true`, return **403** with `{ error: "forbidden", message: "Built-in collections cannot be modified." }`

**Important:** The admin GET list route uses `WHERE org_id IS NULL OR org_id = $orgId` (NOT strict `orgFilter()` like learned-patterns) so admins can see both built-in and their own custom collections.

For reorder: verify `itemIds` contains exactly the items belonging to the collection. Wrap the UPDATE loop in `BEGIN`/`COMMIT` with `ROLLBACK` on error for atomicity. Return 400 if IDs don't match.

```typescript
/**
 * Admin prompt collection CRUD routes.
 *
 * Mounted under /api/v1/admin/prompts. All routes require admin role.
 * Provides full CRUD for prompt collections and items.
 * Built-in collections (is_builtin = true) cannot be modified or deleted.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { PromptCollection, PromptItem } from "@useatlas/types";
import { adminAuthPreamble } from "./admin-auth";

const log = createLogger("admin-prompts");

// --- Helpers (same as prompts.ts — intentionally duplicated to keep files independent) ---

function toPromptCollection(row: Record<string, unknown>): PromptCollection {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? null,
    name: row.name as string,
    industry: row.industry as string,
    description: (row.description as string) ?? "",
    isBuiltin: row.is_builtin as boolean,
    sortOrder: row.sort_order as number,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPromptItem(row: Record<string, unknown>): PromptItem {
  return {
    id: row.id as string,
    collectionId: row.collection_id as string,
    question: row.question as string,
    description: (row.description as string) ?? null,
    category: (row.category as string) ?? null,
    sortOrder: row.sort_order as number,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const adminPrompts = new Hono();

// ... implement GET /, POST /, PATCH /:id, DELETE /:id,
// POST /:id/items, PATCH /:collectionId/items/:itemId,
// DELETE /:collectionId/items/:itemId, PUT /:id/reorder
// following the admin-learned-patterns.ts pattern exactly.

export { adminPrompts };
```

The implementer should write out the full route handlers following the patterns shown in `admin-learned-patterns.ts`. Each handler:
1. Gets `requestId` via `crypto.randomUUID()`
2. Calls `adminAuthPreamble(req, requestId)` and returns error if `"error" in preamble`
3. Checks `hasInternalDB()` → 404
4. Wraps work in `withRequestContext`
5. Uses try/catch with `log.error` + 500 response including `requestId`
6. For mutations: parses JSON body with try/catch (400 on parse failure)
7. Validates org ownership and built-in protection before mutations

- [ ] **Step 2: Mount in admin.ts**

In `packages/api/src/api/routes/admin.ts`:

Add import (after the `adminLearnedPatterns` import):
```typescript
import { adminPrompts } from "./admin-prompts";
```

Add mounting (after the `admin.route("/learned-patterns/", adminLearnedPatterns);` line):
```typescript
admin.route("/prompts", adminPrompts);
admin.route("/prompts/", adminPrompts);
```

- [ ] **Step 3: Verify types compile**

Run: `bun run type`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/api/routes/admin-prompts.ts packages/api/src/api/routes/admin.ts
git commit -m "feat(api): add admin prompt library CRUD routes (#590)

Full CRUD for collections and items under /api/v1/admin/prompts.
Built-in collections are read-only. All mutations org-scoped."
```

---

### Task 6: API tests

**Files:**
- Create: `packages/api/src/api/__tests__/prompts.test.ts`

- [ ] **Step 1: Write prompt API tests**

Create `packages/api/src/api/__tests__/prompts.test.ts`. Copy the mock setup from `packages/api/src/api/__tests__/admin-learned-patterns.test.ts` (the full mock block from lines 1–225). Then add a mock for `seedPromptLibrary` behavior — the `mockInternalQuery` needs to handle seed-related queries.

**Important mock detail:** The `mock.module("@atlas/api/lib/db/internal", ...)` block must also export `seedPromptLibrary` (or the internal module mock must not break when `migrateInternalDB` calls it). Since tests mock `migrateInternalDB` as `async () => {}`, this is already handled.

Test groups to implement:

```typescript
describe("user-facing prompt routes", () => {
  // GET /api/v1/prompts
  describe("GET /api/v1/prompts", () => {
    it("returns collections for authenticated user");
    it("returns empty array when no internal DB");
    it("returns 401 for unauthenticated");
    it("filters by org — returns built-in + own org collections");
  });

  // GET /api/v1/prompts/:id
  describe("GET /api/v1/prompts/:id", () => {
    it("returns collection with items");
    it("returns 404 for missing collection");
    it("returns 404 for collection belonging to other org");
  });
});

describe("admin prompt routes", () => {
  // Auth gating
  describe("auth gating", () => {
    it("returns 403 for non-admin user");
    it("returns 401 for unauthenticated");
    it("returns 429 when rate limited");
    it("returns 404 when no internal DB");
  });

  // POST /api/v1/admin/prompts (create collection)
  describe("POST /admin/prompts", () => {
    it("creates collection with org_id from session");
    it("returns 400 for missing name");
  });

  // PATCH /api/v1/admin/prompts/:id (update)
  describe("PATCH /admin/prompts/:id", () => {
    it("updates collection name and description");
    it("returns 403 for built-in collection");
    it("returns 404 for missing collection");
  });

  // DELETE /api/v1/admin/prompts/:id
  describe("DELETE /admin/prompts/:id", () => {
    it("deletes custom collection");
    it("returns 403 for built-in collection");
    it("returns 404 for missing collection");
  });

  // POST /api/v1/admin/prompts/:id/items
  describe("POST /admin/prompts/:id/items", () => {
    it("adds item to collection");
    it("returns 403 for built-in collection");
    it("returns 400 for missing question");
  });

  // PATCH items
  describe("PATCH /admin/prompts/:collectionId/items/:itemId", () => {
    it("updates item question and description");
    it("returns 404 for missing item");
  });

  // DELETE items
  describe("DELETE /admin/prompts/:collectionId/items/:itemId", () => {
    it("deletes item");
    it("returns 404 for missing item");
  });

  // PUT reorder
  describe("PUT /admin/prompts/:id/reorder", () => {
    it("reorders items by setting sort_order to array index");
    it("returns 400 when itemIds don't match collection items");
  });
});
```

For each test, use `mockInternalQuery.mockImplementation()` to return appropriate mock rows, following the pattern in `admin-learned-patterns.test.ts`. Use helper functions like:

```typescript
function userReq(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/prompts${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

function adminReq(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/admin/prompts${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

function mockCollectionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "col-1",
    org_id: "org-1",
    name: "My Collection",
    industry: "saas",
    description: "Test collection",
    is_builtin: false,
    sort_order: 0,
    created_at: "2026-03-18T00:00:00Z",
    updated_at: "2026-03-18T00:00:00Z",
    ...overrides,
  };
}

function mockItemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-1",
    collection_id: "col-1",
    question: "What is MRR?",
    description: "Monthly recurring revenue",
    category: "Revenue",
    sort_order: 0,
    created_at: "2026-03-18T00:00:00Z",
    updated_at: "2026-03-18T00:00:00Z",
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests**

Run: `bun test packages/api/src/api/__tests__/prompts.test.ts`
Expected: PASS — all tests should pass against the routes from Tasks 4 and 5.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/api/__tests__/prompts.test.ts
git commit -m "test(api): add prompt library API tests (#590)

Tests for user-facing GET routes, admin CRUD, built-in protection,
org isolation, reorder, and error handling."
```

---

### Task 7: Admin UI — Prompt Library page

**Files:**
- Create: `packages/web/src/app/admin/prompts/page.tsx`
- Create: `packages/web/src/app/admin/prompts/columns.tsx`
- Create: `packages/web/src/app/admin/prompts/search-params.ts`
- Modify: `packages/web/src/ui/components/admin/admin-sidebar.tsx`

- [ ] **Step 1: Create search params**

Create `packages/web/src/app/admin/prompts/search-params.ts`:

```typescript
import { parseAsString, parseAsInteger } from "nuqs";

export const promptsSearchParams = {
  industry: parseAsString.withDefault(""),
  page: parseAsInteger.withDefault(1),
};
```

- [ ] **Step 2: Create columns**

Create `packages/web/src/app/admin/prompts/columns.tsx`. Follow the pattern from `admin/learned-patterns/columns.tsx`. Define columns for: name, industry (badge), description (truncated), item count, builtin badge, created date.

```typescript
"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { PromptCollection } from "@/ui/lib/types";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import {
  FileText,
  Tag,
  Hash,
  Calendar,
  Shield,
} from "lucide-react";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const industryBadge: Record<string, { className: string; label: string }> = {
  saas: { className: "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400", label: "SaaS" },
  ecommerce: { className: "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400", label: "E-commerce" },
  cybersecurity: { className: "border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400", label: "Cybersecurity" },
};

export function getPromptCollectionColumns(itemCounts: Map<string, number>): ColumnDef<PromptCollection>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{row.getValue<string>("name")}</span>
          {row.original.isBuiltin && (
            <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 text-[10px]">
              Built-in
            </Badge>
          )}
        </div>
      ),
      meta: { label: "Name", icon: FileText },
      size: 250,
    },
    {
      id: "industry",
      accessorKey: "industry",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Industry" />,
      cell: ({ row }) => {
        const industry = row.getValue<string>("industry");
        const badge = industryBadge[industry] ?? { className: "border-zinc-300 text-zinc-700", label: industry };
        return <Badge variant="outline" className={badge.className}>{badge.label}</Badge>;
      },
      meta: { label: "Industry", icon: Tag },
      enableSorting: false,
      size: 120,
    },
    {
      id: "description",
      accessorKey: "description",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Description" />,
      cell: ({ row }) => {
        const desc = row.getValue<string>("description");
        const truncated = desc.length > 60 ? desc.slice(0, 60) + "\u2026" : desc;
        return <span className="text-sm text-muted-foreground truncate max-w-[300px] block" title={desc}>{truncated}</span>;
      },
      meta: { label: "Description", icon: FileText },
      enableSorting: false,
      size: 320,
    },
    {
      id: "itemCount",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Items" />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground tabular-nums">
          {itemCounts.get(row.original.id) ?? 0}
        </span>
      ),
      meta: { label: "Items", icon: Hash },
      enableSorting: false,
      size: 72,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Created" />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDate(row.getValue<string>("createdAt"))}
        </span>
      ),
      meta: { label: "Created", icon: Calendar },
      size: 120,
    },
  ];
}
```

- [ ] **Step 3: Create the admin page**

Create `packages/web/src/app/admin/prompts/page.tsx`. Follow the learned-patterns page pattern. This is a large component — implement:

1. Fetch collections from `GET /api/v1/admin/prompts`
2. Display in DataTable using columns from step 2
3. Click row → open Sheet with collection details and item list
4. "Create Collection" button → Dialog with name, industry (Select from PROMPT_INDUSTRIES), description fields
5. Edit collection (PATCH) and delete collection (DELETE) — disabled for built-in
6. Within collection detail Sheet: list items, add item form, edit/delete item actions
7. Industry filter tabs (All, SaaS, E-commerce, Cybersecurity)
8. FeatureGate for 401/403/404
9. EmptyState when no collections exist

Key imports to use (from learned-patterns page):
- `useAtlasConfig`, `useQueryStates`, `useDataTable`
- `DataTable`, `DataTableToolbar`, `DataTableSortList`
- `Button`, `Badge`, `Sheet`, `Dialog`, `Select`, `Tabs`, `Input`, `Textarea`
- `StatCard`, `EmptyState`, `ErrorBanner`, `LoadingState`, `FeatureGate`
- `useInProgressSet`, `friendlyError`

- [ ] **Step 4: Add to admin sidebar**

In `packages/web/src/ui/components/admin/admin-sidebar.tsx`:

Add import:
```typescript
import { BookOpen } from "lucide-react";
```

Add to `navItems` array (after the `learned-patterns` entry):
```typescript
  { href: "/admin/prompts", label: "Prompt Library", icon: BookOpen },
```

- [ ] **Step 5: Verify types compile and lint**

Run: `bun run type && bun run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/admin/prompts/ packages/web/src/ui/components/admin/admin-sidebar.tsx
git commit -m "feat(web): add prompt library admin page (#590)

Collection management with DataTable, Sheet detail, create/edit/delete
dialogs, item management, and industry filtering. Built-in collections
are read-only."
```

---

### Task 8: Chat prompt library Sheet

**Files:**
- Create: `packages/web/src/ui/components/chat/prompt-library.tsx`
- Modify: `packages/web/src/ui/components/atlas-chat.tsx`

- [ ] **Step 1: Create PromptLibrary component**

Create `packages/web/src/ui/components/chat/prompt-library.tsx`. Follow the `schema-explorer.tsx` pattern — Sheet, fetch on open, search filter, accordion sections:

```typescript
"use client";

import { useEffect, useState } from "react";
import { useAtlasConfig } from "../../context";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Search, Loader2, BookOpen, MessageSquare } from "lucide-react";
import type { PromptCollection, PromptItem } from "../../lib/types";

interface CollectionWithItems extends PromptCollection {
  items: PromptItem[];
}

export function PromptLibrary({
  open,
  onOpenChange,
  onSendPrompt,
  getHeaders,
  getCredentials,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSendPrompt: (text: string) => void;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
}) {
  const { apiUrl } = useAtlasConfig();
  const [collections, setCollections] = useState<CollectionWithItems[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fetched, setFetched] = useState(false);

  // Fetch collections + items when Sheet opens (cached in state)
  useEffect(() => {
    if (!open || fetched) return;
    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/prompts`, {
          headers: getHeaders(),
          credentials: getCredentials(),
        });
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load prompt library`);
          return;
        }
        const data = await res.json();
        const cols: PromptCollection[] = data.collections ?? [];

        // Fetch items for each collection in parallel
        const withItems = await Promise.all(
          cols.map(async (col) => {
            try {
              const itemRes = await fetch(`${apiUrl}/api/v1/prompts/${col.id}`, {
                headers: getHeaders(),
                credentials: getCredentials(),
              });
              if (!itemRes.ok) return { ...col, items: [] };
              const itemData = await itemRes.json();
              return { ...col, items: (itemData.items ?? []) as PromptItem[] };
            } catch {
              return { ...col, items: [] };
            }
          }),
        );

        if (!cancelled) {
          setCollections(withItems);
          setFetched(true);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load prompt library");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [open, fetched, apiUrl, getHeaders, getCredentials]);

  function handleSelectPrompt(question: string) {
    onOpenChange(false);
    onSendPrompt(question);
  }

  // Filter collections and items by search
  const filtered = search.trim()
    ? collections
        .map((col) => ({
          ...col,
          items: col.items.filter(
            (item) =>
              item.question.toLowerCase().includes(search.toLowerCase()) ||
              (item.description?.toLowerCase().includes(search.toLowerCase()) ?? false),
          ),
        }))
        .filter((col) => col.items.length > 0 || col.name.toLowerCase().includes(search.toLowerCase()))
    : collections;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <BookOpen className="size-5" />
            Prompt Library
          </SheetTitle>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search prompts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="p-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="text-center py-12">
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button variant="link" size="sm" onClick={() => setFetched(false)} className="mt-2">
                  Retry
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-12">
                <BookOpen className="mx-auto size-8 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {search ? "No prompts match your search" : "No prompt collections available"}
                </p>
              </div>
            ) : (
              <Accordion type="multiple" defaultValue={filtered.map((c) => c.id)}>
                {filtered.map((col) => (
                  <AccordionItem key={col.id} value={col.id}>
                    <AccordionTrigger className="hover:no-underline py-3">
                      <div className="flex items-center gap-2 text-left">
                        <span className="text-sm font-medium">{col.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {col.items.length}
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-1 pb-2">
                        {col.items.map((item) => (
                          <button
                            key={item.id}
                            onClick={() => handleSelectPrompt(item.question)}
                            className="w-full text-left rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-accent group"
                          >
                            <div className="flex items-start gap-2">
                              <MessageSquare className="size-3.5 mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                              <div className="min-w-0">
                                <p className="text-sm leading-snug">{item.question}</p>
                                {item.description && (
                                  <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                                )}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Integrate into atlas-chat.tsx**

In `packages/web/src/ui/components/atlas-chat.tsx`:

Add import (near the SchemaExplorer import):
```typescript
import { PromptLibrary } from "./chat/prompt-library";
```

Add `BookOpen` to the Lucide imports.

Add state (near `schemaExplorerOpen`):
```typescript
const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
```

Add button in the header (next to the schema explorer button, around line 411):
```typescript
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-8 text-zinc-500 dark:text-zinc-400"
                    onClick={() => setPromptLibraryOpen(true)}
                    aria-label="Open prompt library"
                  >
                    <BookOpen className="size-4" />
                  </Button>
```

Add the component (near the SchemaExplorer component, around line 642):
```typescript
      <PromptLibrary
        open={promptLibraryOpen}
        onOpenChange={setPromptLibraryOpen}
        onSendPrompt={handleSend}
        getHeaders={getHeaders}
        getCredentials={getCredentials}
      />
```

Add "Browse prompt library" link in the empty state (after the STARTER_PROMPTS grid, around line 489):
```typescript
                      <Button
                        variant="link"
                        onClick={() => setPromptLibraryOpen(true)}
                        className="text-xs text-zinc-400 dark:text-zinc-500"
                      >
                        <BookOpen className="mr-1.5 size-3.5" />
                        Browse prompt library
                      </Button>
```

- [ ] **Step 3: Install Accordion component**

The Accordion component is not yet installed. Run:

```bash
cd packages/web && bun x shadcn@latest add accordion
```

This will create `packages/web/src/components/ui/accordion.tsx` and may update `packages/web/package.json` + `bun.lock`.

- [ ] **Step 4: Verify types compile and lint**

Run: `bun run type && bun run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/ui/components/chat/prompt-library.tsx packages/web/src/ui/components/atlas-chat.tsx packages/web/src/components/ui/accordion.tsx
# If package.json or bun.lock changed from accordion install, add them too:
git add packages/web/package.json bun.lock 2>/dev/null; true
git commit -m "feat(web): add prompt library Sheet in chat UI (#590)

Accordion-based collection browser in a Sheet drawer. Click a prompt to
send immediately. Search filter across all collections. Browse link in
empty state."
```

---

### Task 9: Docs + ROADMAP updates

**Files:**
- Modify: `apps/docs/content/docs/guides/admin-console.mdx`
- Modify: `.claude/research/ROADMAP.md`

- [ ] **Step 1: Update admin console docs**

In `apps/docs/content/docs/guides/admin-console.mdx`, add a new section for Prompt Library (following the pattern of existing sections). Place it after the Learned Patterns section:

```markdown
## Prompt Library

The Prompt Library page lets you manage curated prompt collections — pre-written questions organized by industry that help users get started with common analyses.

### Built-in Collections

Atlas ships with three built-in collections:
- **SaaS Metrics** — MRR, churn, LTV, CAC, and growth indicators
- **E-commerce KPIs** — GMV, AOV, conversion rates, and inventory metrics
- **Cybersecurity Compliance** — vulnerability tracking, incident response, and compliance scores

Built-in collections are read-only and visible to all users.

### Custom Collections

Admins can create custom prompt collections scoped to their organization:
1. Click **Create Collection** and fill in the name, industry, and description
2. Add prompt items with questions, descriptions, and categories
3. Reorder items by dragging or using the reorder controls

Custom collections are only visible to members of the admin's organization.

### Chat Integration

Users can access the prompt library from the chat interface via the book icon in the header. Clicking a prompt immediately sends it as a question.
```

- [ ] **Step 2: Update ROADMAP**

In `.claude/research/ROADMAP.md`, find the line for `#590` and mark it complete:
```
- [x] #590 Prompt library — curated per-industry question collections (PR #TBD)
```

Replace `#TBD` with the actual PR number once created.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/content/docs/guides/admin-console.mdx .claude/research/ROADMAP.md
git commit -m "docs: add prompt library to admin console guide and update ROADMAP (#590)"
```

---

### Task 10: CI gates + PR

- [ ] **Step 1: Run lint**

Run: `bun run lint`
Expected: PASS. Fix any issues before continuing.

- [ ] **Step 2: Run type check**

Run: `bun run type`
Expected: PASS. Fix any issues before continuing.

- [ ] **Step 3: Run full tests**

Run: `bun run test`
Expected: PASS. Fix any issues before continuing.

- [ ] **Step 4: Run syncpack**

Run: `bun x syncpack lint`
Expected: PASS.

- [ ] **Step 5: Run template drift check**

Run: `SKIP_SYNCPACK=1 bash scripts/check-template-drift.sh`
Expected: PASS.

- [ ] **Step 6: Create PR**

Use the `/pr` skill to create the PR. Branch: `feat/prompt-library`. Title should reference both issues. PR body should list all changes grouped by issue.
