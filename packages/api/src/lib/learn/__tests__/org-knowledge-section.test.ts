import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { RelevantPattern } from "@atlas/api/lib/learn/pattern-cache";

// ---------------------------------------------------------------------------
// Fixtures — two orgs with disjoint favorites / suggestions / patterns so the
// scoping tests can prove org-A never sees org-B's rows.
// ---------------------------------------------------------------------------

interface FavRow {
  id: string;
  user_id: string;
  org_id: string;
  text: string;
  position: number;
  created_at: string;
}

let favoriteRows: FavRow[] = [];

interface SuggRow {
  id: string;
  org_id: string | null;
  description: string;
  approval_status: string;
  status: string;
}
let suggestionRows: SuggRow[] = [];

interface PatRow {
  id: string;
  org_id: string | null;
  connection_group_id: string | null;
  pattern_sql: string;
  description: string | null;
  source_entity: string | null;
  confidence: number;
}
let patternRows: PatRow[] = [];

// --- Mocks (all named exports) ---

// internalQuery is routed by SQL text so the real `listFavorites` resolver
// runs against an in-memory table that honors the (user_id, org_id) WHERE
// predicate exactly like Postgres would — the scoping under test.
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: async () => ({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: async (sql: string, paramsArg?: unknown[]) => {
    const params = paramsArg ?? [];
    if (sql.includes("user_favorite_prompts")) {
      const [userId, orgId] = params as [string, string];
      return favoriteRows.filter((r) => r.user_id === userId && r.org_id === orgId);
    }
    return [];
  },
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
  // Approved-pattern resolver — scoped by org + connection group.
  getApprovedPatterns: async (orgId: string | null, connectionGroupId?: string | null) =>
    patternRows.filter(
      (p) =>
        (p.org_id === orgId || p.org_id === null) &&
        (p.connection_group_id === (connectionGroupId ?? null) || p.connection_group_id === null),
    ),
  // Popular-suggestion resolver — scoped by org, approved + published only.
  getPopularSuggestions: async (orgId: string | null, limit = 10) =>
    suggestionRows
      .filter(
        (s) =>
          s.org_id === orgId &&
          s.approval_status === "approved" &&
          s.status === "published",
      )
      .slice(0, limit),
  upsertSuggestion: async () => "created",
  getSuggestionsByTables: async () => [],
  incrementSuggestionClick: () => {},
  deleteSuggestion: async () => false,
  getAuditLogQueries: async () => [],
}));

mock.module("@atlas/api/lib/settings", () => {
  const settingValue = (key: string): string | undefined => {
    if (key === "ATLAS_LEARN_CONFIDENCE_THRESHOLD") return "0.7";
    if (key === "ATLAS_LEARN_RETRIEVAL_TURNS") return undefined;
    return undefined;
  };
  return {
    getSetting: (key: string) => settingValue(key),
    getSettingAuto: (key: string) => settingValue(key),
    getSettingLive: async (key: string) => settingValue(key),
  };
});

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
  buildOrgKnowledgeSection,
  resolveOrgKnowledgeSection,
} = await import("@atlas/api/lib/learn/org-knowledge-section");
const { _resetPatternCache } = await import("@atlas/api/lib/learn/pattern-cache");

function pattern(over: Partial<RelevantPattern> = {}): RelevantPattern {
  return {
    sourceEntity: "companies",
    description: "Total company revenue",
    patternSql: "SELECT SUM(revenue) FROM companies",
    ...over,
  };
}

// ===========================================================================
// Pure builder
// ===========================================================================

describe("buildOrgKnowledgeSection (pure)", () => {
  test("returns empty string when every signal list is empty", () => {
    expect(
      buildOrgKnowledgeSection({ patterns: [], favorites: [], suggestions: [] }),
    ).toBe("");
  });

  test("renders the learned-patterns subsection", () => {
    const section = buildOrgKnowledgeSection({
      patterns: [pattern()],
      favorites: [],
      suggestions: [],
    });
    expect(section).toContain("## Organizational knowledge");
    expect(section).toContain("semantic layer definitions above always take precedence");
    expect(section).toContain("### Previously successful query patterns");
    expect(section).toContain("[companies]: Total company revenue");
    expect(section).toContain("SQL: SELECT SUM(revenue) FROM companies");
  });

  test("renders favorites and suggestions alongside patterns", () => {
    const section = buildOrgKnowledgeSection({
      patterns: [pattern()],
      favorites: [{ text: "Show MRR by month" }],
      suggestions: [{ description: "Top 10 customers by revenue" }],
    });
    expect(section).toContain("### Prompts your team has pinned");
    expect(section).toContain("- Show MRR by month");
    expect(section).toContain("### Popular questions in this workspace");
    expect(section).toContain("- Top 10 customers by revenue");
  });

  test("renders favorites/suggestions even when there are no patterns", () => {
    const section = buildOrgKnowledgeSection({
      patterns: [],
      favorites: [{ text: "Churn this quarter" }],
      suggestions: [{ description: "Active users today" }],
    });
    expect(section).toContain("## Organizational knowledge");
    expect(section).not.toContain("### Previously successful query patterns");
    expect(section).toContain("- Churn this quarter");
    expect(section).toContain("- Active users today");
  });

  test("uses [general] when source_entity is null and falls back to a default description", () => {
    const section = buildOrgKnowledgeSection({
      patterns: [pattern({ sourceEntity: null, description: null })],
      favorites: [],
      suggestions: [],
    });
    expect(section).toContain("[general]: Query pattern");
  });

  test("caps favorites and suggestions and skips blank text", () => {
    const section = buildOrgKnowledgeSection({
      patterns: [],
      favorites: [
        { text: "f1" },
        { text: "   " },
        { text: "f2" },
        { text: "f3" },
        { text: "f4" },
        { text: "f5" },
        { text: "f6" },
      ],
      suggestions: [],
      maxFavorites: 3,
    });
    expect(section).toContain("- f1");
    expect(section).toContain("- f2");
    expect(section).toContain("- f3");
    // Blank dropped, and beyond the cap of 3 nothing else renders.
    expect(section).not.toContain("- f4");
    expect(section).not.toContain("-    ");
  });

  test("sanitizes injected text — strips headings, collapses newlines, truncates", () => {
    const long = "x".repeat(400);
    const section = buildOrgKnowledgeSection({
      patterns: [],
      favorites: [{ text: `## fake heading\ninjected\n${long}` }],
      suggestions: [],
    });
    // A pinned prompt cannot forge a new markdown heading.
    expect(section).not.toContain("\n## fake heading");
    expect(section).toContain("fake heading injected");
    expect(section).toContain("...");
  });
});

// ===========================================================================
// Orchestrator + scoping (no cross-tenant leak)
// ===========================================================================

describe("resolveOrgKnowledgeSection (scoping)", () => {
  beforeEach(() => {
    _resetPatternCache();
    favoriteRows = [];
    suggestionRows = [];
    patternRows = [];
  });

  test("folds favorites + approved suggestions + patterns for the active org", async () => {
    favoriteRows = [
      { id: "f-a", user_id: "user-a", org_id: "org-a", text: "Org A favorite", position: 1, created_at: "2026-01-01" },
    ];
    suggestionRows = [
      { id: "s-a", org_id: "org-a", description: "Org A popular question", approval_status: "approved", status: "published" },
    ];
    patternRows = [
      { id: "p-a", org_id: "org-a", connection_group_id: null, pattern_sql: "SELECT revenue FROM orga", description: "Org A pattern", source_entity: "orga", confidence: 0.9 },
    ];

    const section = await resolveOrgKnowledgeSection({
      orgId: "org-a",
      userId: "user-a",
      connectionGroupId: null,
      mode: "published",
      question: "show me revenue",
    });

    expect(section).toContain("Org A favorite");
    expect(section).toContain("Org A popular question");
    expect(section).toContain("Org A pattern");
  });

  test("never surfaces another org's favorites or suggestions (no cross-tenant leak)", async () => {
    favoriteRows = [
      { id: "f-a", user_id: "user-a", org_id: "org-a", text: "Alpha favorite", position: 1, created_at: "2026-01-01" },
      { id: "f-b", user_id: "user-b", org_id: "org-b", text: "Bravo secret favorite", position: 1, created_at: "2026-01-01" },
    ];
    suggestionRows = [
      { id: "s-a", org_id: "org-a", description: "Alpha popular question", approval_status: "approved", status: "published" },
      { id: "s-b", org_id: "org-b", description: "Bravo secret question", approval_status: "approved", status: "published" },
    ];
    patternRows = [
      { id: "p-a", org_id: "org-a", connection_group_id: null, pattern_sql: "SELECT revenue FROM alpha", description: "Alpha pattern", source_entity: "alpha", confidence: 0.9 },
      { id: "p-b", org_id: "org-b", connection_group_id: null, pattern_sql: "SELECT revenue FROM bravo", description: "Bravo pattern", source_entity: "bravo", confidence: 0.9 },
    ];

    const section = await resolveOrgKnowledgeSection({
      orgId: "org-a",
      userId: "user-a",
      connectionGroupId: null,
      mode: "published",
      question: "show me revenue",
    });

    expect(section).toContain("Alpha favorite");
    expect(section).toContain("Alpha popular question");
    // The other tenant's signals must never appear.
    expect(section).not.toContain("Bravo secret favorite");
    expect(section).not.toContain("Bravo secret question");
    expect(section).not.toContain("bravo");
  });

  test("a user only sees their own pins within the org", async () => {
    favoriteRows = [
      { id: "f-a", user_id: "user-a", org_id: "org-a", text: "Mine", position: 1, created_at: "2026-01-01" },
      { id: "f-c", user_id: "user-c", org_id: "org-a", text: "Someone else pin", position: 1, created_at: "2026-01-01" },
    ];

    const section = await resolveOrgKnowledgeSection({
      orgId: "org-a",
      userId: "user-a",
      connectionGroupId: null,
      mode: "published",
      question: "show me revenue",
    });

    expect(section).toContain("Mine");
    expect(section).not.toContain("Someone else pin");
  });

  test("excludes pending / unpublished suggestions", async () => {
    suggestionRows = [
      { id: "s-pending", org_id: "org-a", description: "Pending question", approval_status: "pending", status: "draft" },
      { id: "s-approved", org_id: "org-a", description: "Approved question", approval_status: "approved", status: "published" },
    ];

    const section = await resolveOrgKnowledgeSection({
      orgId: "org-a",
      userId: "user-a",
      connectionGroupId: null,
      mode: "published",
      question: "show me revenue",
    });

    expect(section).toContain("Approved question");
    expect(section).not.toContain("Pending question");
  });

  test("returns empty string when the org has no signals", async () => {
    const section = await resolveOrgKnowledgeSection({
      orgId: "org-empty",
      userId: "user-x",
      connectionGroupId: null,
      mode: "published",
      question: "show me revenue",
    });
    expect(section).toBe("");
  });
});
