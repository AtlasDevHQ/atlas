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
