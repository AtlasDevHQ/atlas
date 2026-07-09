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

let mockConfigLearn: { confidenceThreshold: number; retrievalTurns?: number } | undefined = {
  confidenceThreshold: 0.7,
};

let mockGetApprovedPatternsError: Error | null = null;

// #3611 — record retrieval calls + allow per-group result sets so tests can
// assert that each connection group sees only its own patterns and that the
// active group is threaded all the way to the DB layer.
let getApprovedPatternsCalls: Array<{ orgId: string | null; connectionGroupId: string | null | undefined }> = [];
let mockPatternsByGroup: Map<string | null, typeof mockApprovedPatterns> | null = null;

// --- Mocks (all named exports) ---

void mock.module("@atlas/api/lib/db/internal", () => ({
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
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
  isPlaintextUrl: () => true,
  getApprovedPatterns: async (orgId: string | null, connectionGroupId?: string | null) => {
    getApprovedPatternsCalls.push({ orgId, connectionGroupId });
    if (mockGetApprovedPatternsError) throw mockGetApprovedPatternsError;
    if (mockPatternsByGroup) return mockPatternsByGroup.get(connectionGroupId ?? null) ?? [];
    return mockApprovedPatterns;
  },
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

void mock.module("@atlas/api/lib/config", () => ({
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

// pattern-cache reads the learn knobs from the settings registry (workspace
// override > platform override > env var > default). Drive them from the same
// `mockConfigLearn` object the tests already mutate.
void mock.module("@atlas/api/lib/settings", () => {
  const settingValue = (key: string): string | undefined => {
    if (key === "ATLAS_LEARN_CONFIDENCE_THRESHOLD") {
      return mockConfigLearn?.confidenceThreshold === undefined
        ? undefined
        : String(mockConfigLearn.confidenceThreshold);
    }
    if (key === "ATLAS_LEARN_RETRIEVAL_TURNS") {
      return mockConfigLearn?.retrievalTurns === undefined
        ? undefined
        : String(mockConfigLearn.retrievalTurns);
    }
    return undefined;
  };
  return {
    getSetting: (key: string) => settingValue(key),
    getSettingAuto: (key: string) => settingValue(key),
    getSettingLive: async (key: string) => settingValue(key),
  };
});

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock(),
);

void mock.module("@atlas/api/lib/logger", () => ({
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
  buildRetrievalQuery,
  getRetrievalTurns,
  extractKeywords,
  invalidatePatternCache,
  _resetPatternCache,
  DEFAULT_RETRIEVAL_TURNS,
} = await import("@atlas/api/lib/learn/pattern-cache");

/** Build a minimal user/assistant UI message for retrieval-query tests. */
function msg(role: "user" | "assistant", text: string) {
  return { id: `${role}-${text.slice(0, 8)}`, role, parts: [{ type: "text" as const, text }] };
}

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

describe("buildRetrievalQuery", () => {
  test("uses the last user message when it carries keywords", () => {
    const query = buildRetrievalQuery([
      msg("user", "What is total revenue by company?"),
    ]);
    expect(query).toBe("What is total revenue by company?");
  });

  test("merges the last N user turns, skipping assistant turns", () => {
    const query = buildRetrievalQuery(
      [
        msg("user", "Show revenue by company"),
        msg("assistant", "Here is the revenue breakdown"),
        msg("user", "now break that down by region"),
      ],
      3,
    );
    expect(query).toBe("Show revenue by company now break that down by region");
  });

  test("a keyword-less follow-up still surfaces prior-turn keywords", () => {
    // "now break that down by region" alone yields no keywords after
    // stop-word filtering — the earlier turn's keywords must carry through.
    const followUpOnly = extractKeywords("now break that down by region");
    expect(followUpOnly.has("revenue")).toBe(false);
    expect(followUpOnly.has("company")).toBe(false);

    const query = buildRetrievalQuery([
      msg("user", "What is total revenue by company?"),
      msg("assistant", "$1.2M across 40 companies"),
      msg("user", "now break that down by region"),
    ]);
    const keywords = extractKeywords(query);
    expect(keywords.has("revenue")).toBe(true);
    expect(keywords.has("company")).toBe(true);
    expect(keywords.has("region")).toBe(true);
  });

  test("respects the N bound — only the last N user turns are included", () => {
    const query = buildRetrievalQuery(
      [
        msg("user", "alpha keyword"),
        msg("user", "bravo keyword"),
        msg("user", "charlie keyword"),
      ],
      2,
    );
    expect(query).toBe("bravo keyword charlie keyword");
    expect(query).not.toContain("alpha");
  });

  test("empty user turns do not consume the turn budget", () => {
    const query = buildRetrievalQuery(
      [
        msg("user", "revenue by company"),
        { role: "user", parts: [] },
        msg("user", "by region"),
      ],
      2,
    );
    expect(query).toBe("revenue by company by region");
  });

  test("clamps non-positive and non-finite N to 1", () => {
    const messages = [msg("user", "first turn"), msg("user", "second turn")];
    expect(buildRetrievalQuery(messages, 0)).toBe("second turn");
    expect(buildRetrievalQuery(messages, -5)).toBe("second turn");
    expect(buildRetrievalQuery(messages, Number.NaN)).toBe("second turn");
  });

  test("returns empty string when there is no user text", () => {
    expect(buildRetrievalQuery([])).toBe("");
    expect(buildRetrievalQuery([msg("assistant", "hello there")])).toBe("");
  });

  test("default N is the documented constant and surfaces multi-turn context", () => {
    expect(DEFAULT_RETRIEVAL_TURNS).toBe(3);
    const query = buildRetrievalQuery([
      msg("user", "revenue by company"),
      msg("user", "filter to 2025"),
      msg("user", "now by region"),
    ]);
    expect(query).toBe("revenue by company filter to 2025 now by region");
  });
});

describe("getRetrievalTurns", () => {
  beforeEach(() => {
    mockConfigLearn = { confidenceThreshold: 0.7 };
  });

  test("falls back to the default when config omits retrievalTurns", () => {
    expect(getRetrievalTurns()).toBe(DEFAULT_RETRIEVAL_TURNS);
  });

  test("uses a configured retrievalTurns value", () => {
    mockConfigLearn = { confidenceThreshold: 0.7, retrievalTurns: 5 };
    expect(getRetrievalTurns()).toBe(5);
  });

  test("ignores an invalid retrievalTurns value", () => {
    mockConfigLearn = { confidenceThreshold: 0.7, retrievalTurns: 0 };
    expect(getRetrievalTurns()).toBe(DEFAULT_RETRIEVAL_TURNS);
  });
});

describe("multi-turn retrieval surfaces patterns for keyword-less follow-ups", () => {
  beforeEach(() => {
    _resetPatternCache();
    mockApprovedPatterns = [];
    mockConfigLearn = { confidenceThreshold: 0.7 };
    mockGetApprovedPatternsError = null;
  });

  test("query assembled from prior turns matches a pattern the follow-up alone would miss", async () => {
    mockApprovedPatterns = [
      {
        id: "1",
        org_id: null,
        pattern_sql: "SELECT company, SUM(revenue) FROM companies GROUP BY company",
        description: "Company revenue totals",
        source_entity: "companies",
        confidence: 0.9,
      },
    ];

    const messages = [
      msg("user", "What is total revenue by company?"),
      msg("assistant", "$1.2M across 40 companies"),
      msg("user", "now break that down by month"),
    ];

    // The follow-up on its own carries no keyword that overlaps the pattern
    // ("month"/"break" miss the company-revenue pattern), so it surfaces
    // nothing — this is the bug #3632 fixes.
    const followUpResults = await getRelevantPatterns(null, "now break that down by month");
    expect(followUpResults.length).toBe(0);

    // Assembled across turns, the pattern is found.
    const multiTurnResults = await getRelevantPatterns(
      null,
      buildRetrievalQuery(messages),
    );
    expect(multiTurnResults.length).toBe(1);
    expect(multiTurnResults[0].sourceEntity).toBe("companies");
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

    const results = await getRelevantPatterns(null, "Show me revenue", null, 5);
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

describe("connection-group scoping (#3611)", () => {
  beforeEach(() => {
    _resetPatternCache();
    mockApprovedPatterns = [];
    mockPatternsByGroup = null;
    getApprovedPatternsCalls = [];
    mockConfigLearn = { confidenceThreshold: 0.7 };
    mockGetApprovedPatternsError = null;
  });

  test("threads the active connection group through to the DB layer", async () => {
    await getRelevantPatterns("org-1", "What is the revenue?", "us-prod");

    expect(getApprovedPatternsCalls).toHaveLength(1);
    expect(getApprovedPatternsCalls[0]).toEqual({ orgId: "org-1", connectionGroupId: "us-prod" });
  });

  test("each agent session sees only its own group's patterns", async () => {
    // Same org, two groups, disjoint pattern libraries.
    mockPatternsByGroup = new Map([
      [
        "us-prod",
        [
          {
            id: "us-1",
            org_id: "org-1",
            pattern_sql: "SELECT SUM(revenue) FROM us_companies",
            description: "US revenue",
            source_entity: "us_companies",
            confidence: 0.9,
          },
        ],
      ],
      [
        "eu-prod",
        [
          {
            id: "eu-1",
            org_id: "org-1",
            pattern_sql: "SELECT SUM(revenue) FROM eu_companies",
            description: "EU revenue",
            source_entity: "eu_companies",
            confidence: 0.9,
          },
        ],
      ],
    ]);

    const us = await getRelevantPatterns("org-1", "What is the revenue?", "us-prod");
    const eu = await getRelevantPatterns("org-1", "What is the revenue?", "eu-prod");

    expect(us.map((p) => p.patternSql)).toEqual(["SELECT SUM(revenue) FROM us_companies"]);
    expect(eu.map((p) => p.patternSql)).toEqual(["SELECT SUM(revenue) FROM eu_companies"]);
    // No cross-group bleed: the us-prod session never sees the eu pattern.
    expect(us.some((p) => p.patternSql.includes("eu_companies"))).toBe(false);
  });

  test("cache is partitioned per group — distinct groups each hit the DB", async () => {
    mockPatternsByGroup = new Map([
      ["us-prod", []],
      ["eu-prod", []],
    ]);

    await getRelevantPatterns("org-1", "revenue", "us-prod");
    await getRelevantPatterns("org-1", "revenue", "us-prod"); // cached — no new DB call
    await getRelevantPatterns("org-1", "revenue", "eu-prod"); // different group — DB call

    const groupsFetched = getApprovedPatternsCalls.map((c) => c.connectionGroupId);
    expect(groupsFetched).toEqual(["us-prod", "eu-prod"]);
  });

  test("org-scoped invalidation clears every group entry for that org", async () => {
    mockPatternsByGroup = new Map([
      ["us-prod", [{ id: "u", org_id: "org-1", pattern_sql: "SELECT revenue FROM t", description: "d", source_entity: "t", confidence: 0.9 }]],
      ["eu-prod", [{ id: "e", org_id: "org-1", pattern_sql: "SELECT revenue FROM t", description: "d", source_entity: "t", confidence: 0.9 }]],
    ]);

    // Warm both group caches for org-1.
    await getRelevantPatterns("org-1", "revenue", "us-prod");
    await getRelevantPatterns("org-1", "revenue", "eu-prod");
    const callsAfterWarm = getApprovedPatternsCalls.length;

    // Admin approve/reject invalidates at org granularity (no group known).
    invalidatePatternCache("org-1");

    // Both groups must re-fetch — neither served a stale cache entry.
    await getRelevantPatterns("org-1", "revenue", "us-prod");
    await getRelevantPatterns("org-1", "revenue", "eu-prod");
    expect(getApprovedPatternsCalls.length).toBe(callsAfterWarm + 2);
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
