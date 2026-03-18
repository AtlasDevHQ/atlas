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

let mockGetApprovedPatternsError: Error | null = null;

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
    if (mockGetApprovedPatternsError) throw mockGetApprovedPatternsError;
    return mockApprovedPatterns;
  },
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
  buildLearnedPatternsSection,
  extractKeywords,
  invalidatePatternCache,
  _resetPatternCache,
} = await import("@atlas/api/lib/learn/pattern-cache");

describe("extractKeywords", () => {
  test("extracts meaningful words, excludes stop words", () => {
    const kw = extractKeywords("What is the total revenue by company?");
    expect(kw.has("total")).toBe(true);
    expect(kw.has("revenue")).toBe(true);
    expect(kw.has("company")).toBe(true);
    expect(kw.has("the")).toBe(false);
    expect(kw.has("is")).toBe(false);
    expect(kw.has("what")).toBe(false);
  });

  test("handles SQL keywords in pattern text", () => {
    const kw = extractKeywords("SELECT revenue FROM companies WHERE active = true");
    expect(kw.has("revenue")).toBe(true);
    expect(kw.has("companies")).toBe(true);
    expect(kw.has("active")).toBe(true);
    expect(kw.has("select")).toBe(false);
    expect(kw.has("from")).toBe(false);
    expect(kw.has("where")).toBe(false);
  });

  test("lowercases and deduplicates", () => {
    const kw = extractKeywords("Revenue revenue REVENUE");
    expect(kw.size).toBe(1);
    expect(kw.has("revenue")).toBe(true);
  });

  test("handles underscored identifiers", () => {
    const kw = extractKeywords("total_revenue company_name");
    expect(kw.has("total_revenue")).toBe(true);
    expect(kw.has("company_name")).toBe(true);
  });
});

describe("getRelevantPatterns", () => {
  beforeEach(() => {
    _resetPatternCache();
    mockApprovedPatterns = [];
    mockConfigLearn = { confidenceThreshold: 0.7 };
    mockGetApprovedPatternsError = null;
  });

  test("returns patterns matching question keywords", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Total company revenue",
        source_entity: "companies",
        confidence: 0.9,
      },
      {
        id: "2",
        org_id: null,
        pattern_sql: "SELECT COUNT(*) FROM tickets WHERE status = 'open'",
        description: "Open ticket count",
        source_entity: "tickets",
        confidence: 0.8,
      },
    ];

    const results = await getRelevantPatterns(null, "What is the total revenue?");
    expect(results.length).toBe(1);
    expect(results[0].sourceEntity).toBe("companies");
    expect(results[0].patternSql).toContain("revenue");
  });

  test("filters patterns below confidence threshold", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Total revenue",
        source_entity: "companies",
        confidence: 0.5, // below default 0.7
      },
    ];

    const results = await getRelevantPatterns(null, "What is the total revenue?");
    expect(results.length).toBe(0);
  });

  test("respects custom confidence threshold", async () => {
    mockConfigLearn = { confidenceThreshold: 0.3 };
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Total revenue",
        source_entity: "companies",
        confidence: 0.5,
      },
    ];

    const results = await getRelevantPatterns(null, "What is the total revenue?");
    expect(results.length).toBe(1);
  });

  test("limits results to maxPatterns", async () => {
    mockApprovedPatterns = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      org_id: null,
      pattern_sql: `SELECT revenue FROM companies_${i}`,
      description: `Revenue query ${i}`,
      source_entity: "companies",
      confidence: 0.9,
    }));

    const results = await getRelevantPatterns(null, "Show me revenue", 5);
    expect(results.length).toBe(5);
  });

  test("returns empty for empty question", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT 1",
        description: "Test",
        source_entity: "test",
        confidence: 0.9,
      },
    ];

    const results = await getRelevantPatterns(null, "");
    expect(results.length).toBe(0);
  });

  test("returns empty when no patterns match keywords", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Total revenue",
        source_entity: "companies",
        confidence: 0.9,
      },
    ];

    const results = await getRelevantPatterns(null, "How many tickets are open?");
    expect(results.length).toBe(0);
  });

  test("sorts by relevance score then confidence", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT revenue FROM companies",
        description: "Company revenue report",
        source_entity: "companies",
        confidence: 0.8,
      },
      {
        id: "2",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) AS total_revenue FROM companies GROUP BY region",
        description: "Revenue by region for companies",
        source_entity: "companies",
        confidence: 0.95,
      },
    ];

    const results = await getRelevantPatterns(null, "revenue by region for companies");
    expect(results.length).toBe(2);
    // Pattern 2 has more keyword overlap (revenue, region, companies)
    expect(results[0].patternSql).toContain("region");
  });
});

describe("buildLearnedPatternsSection", () => {
  beforeEach(() => {
    _resetPatternCache();
    mockApprovedPatterns = [];
    mockConfigLearn = { confidenceThreshold: 0.7 };
    mockGetApprovedPatternsError = null;
  });

  test("returns formatted section when patterns match", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Total company revenue",
        source_entity: "companies",
        confidence: 0.9,
      },
    ];

    const section = await buildLearnedPatternsSection(null, "What is the total revenue?");
    expect(section).toContain("## Previously successful query patterns");
    expect(section).toContain("semantic layer definitions above take precedence");
    expect(section).toContain("[companies]: Total company revenue");
    expect(section).toContain("SQL: SELECT SUM(revenue) FROM companies");
  });

  test("returns empty string when no patterns match", async () => {
    mockApprovedPatterns = [];
    const section = await buildLearnedPatternsSection(null, "What is the total revenue?");
    expect(section).toBe("");
  });

  test("uses [general] label when source_entity is null", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Revenue total",
        source_entity: null,
        confidence: 0.9,
      },
    ];

    const section = await buildLearnedPatternsSection(null, "What is the total revenue?");
    expect(section).toContain("[general]: Revenue total");
  });

  test("falls back to 'Query pattern' when description is null", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: null,
        source_entity: "companies",
        confidence: 0.9,
      },
    ];

    const section = await buildLearnedPatternsSection(null, "What is the total revenue?");
    expect(section).toContain("[companies]: Query pattern");
  });
});

describe("pattern cache invalidation", () => {
  beforeEach(() => {
    _resetPatternCache();
    mockApprovedPatterns = [];
    mockConfigLearn = { confidenceThreshold: 0.7 };
    mockGetApprovedPatternsError = null;
  });

  test("cache serves stale data until invalidated", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Revenue query",
        source_entity: "companies",
        confidence: 0.9,
      },
    ];

    // First call populates cache
    const first = await getRelevantPatterns(null, "What is the revenue?");
    expect(first.length).toBe(1);

    // Change the underlying data
    mockApprovedPatterns = [];

    // Cache still returns old data
    const cached = await getRelevantPatterns(null, "What is the revenue?");
    expect(cached.length).toBe(1);

    // Invalidate cache
    invalidatePatternCache(null);

    // Now returns fresh (empty) data
    const fresh = await getRelevantPatterns(null, "What is the revenue?");
    expect(fresh.length).toBe(0);
  });

  test("invalidation is org-scoped", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: "org-1",
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Revenue",
        source_entity: "companies",
        confidence: 0.9,
      },
    ];

    // Populate cache for org-1
    await getRelevantPatterns("org-1", "What is the revenue?");

    // Change data
    mockApprovedPatterns = [];

    // Invalidate a different org — org-1 cache untouched
    invalidatePatternCache("org-2");
    const stillCached = await getRelevantPatterns("org-1", "What is the revenue?");
    expect(stillCached.length).toBe(1);

    // Invalidate org-1
    invalidatePatternCache("org-1");
    const fresh = await getRelevantPatterns("org-1", "What is the revenue?");
    expect(fresh.length).toBe(0);
  });

  test("DB failure returns empty without caching the failure", async () => {
    mockGetApprovedPatternsError = new Error("relation learned_patterns does not exist");

    // First call fails — returns empty
    const result = await getRelevantPatterns(null, "What is the revenue?");
    expect(result.length).toBe(0);

    // Fix the DB
    mockGetApprovedPatternsError = null;
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT SUM(revenue) FROM companies",
        description: "Revenue",
        source_entity: "companies",
        confidence: 0.9,
      },
    ];

    // Next call should succeed — failure was NOT cached
    const afterFix = await getRelevantPatterns(null, "What is the revenue?");
    expect(afterFix.length).toBe(1);
  });
});

describe("buildLearnedPatternsSection error handling", () => {
  beforeEach(() => {
    _resetPatternCache();
    mockApprovedPatterns = [];
    mockConfigLearn = { confidenceThreshold: 0.7 };
    mockGetApprovedPatternsError = null;
  });

  test("returns empty string on DB failure without throwing", async () => {
    mockGetApprovedPatternsError = new Error("DB connection failed");
    const section = await buildLearnedPatternsSection(null, "What is the total revenue?");
    expect(section).toBe("");
  });
});

describe("edge cases", () => {
  beforeEach(() => {
    _resetPatternCache();
    mockApprovedPatterns = [];
    mockConfigLearn = { confidenceThreshold: 0.7 };
    mockGetApprovedPatternsError = null;
  });

  test("question with only stop words returns empty", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT 1",
        description: "Test",
        source_entity: "test",
        confidence: 0.9,
      },
    ];

    const results = await getRelevantPatterns(null, "what is the");
    expect(results.length).toBe(0);
  });
});
