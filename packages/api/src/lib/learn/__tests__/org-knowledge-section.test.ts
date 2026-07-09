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

// internalQuery is the single Postgres-emulation chokepoint, routed by SQL
// text. Both the real `listFavorites` resolver (separate, unmocked module) and
// the `getPopularSuggestions` stub route through it, so the WHERE predicates
// under test — favorites' (user_id, org_id) and suggestions' org + approval +
// mode-driven status clause — are honored exactly like Postgres would.
async function mockInternalQuery(sql: string, paramsArg?: unknown[]) {
  const params = paramsArg ?? [];
  if (sql.includes("user_favorite_prompts")) {
    const [userId, orgId] = params as [string, string];
    return favoriteRows.filter((r) => r.user_id === userId && r.org_id === orgId);
  }
  if (sql.includes("query_suggestions")) {
    // Interpret the real resolver's SQL: org scope (or IS NULL), the approval
    // gate, and the mode-driven status clause — `published` only unless the
    // SQL opted developer-mode drafts in.
    const orgIsNull = sql.includes("org_id IS NULL");
    const allowDraft = sql.includes("'draft'");
    const limit = Number(params[params.length - 1] ?? 10);
    return suggestionRows
      .filter((s) => {
        if (orgIsNull ? s.org_id !== null : s.org_id !== params[0]) return false;
        if (sql.includes("approval_status = 'approved'") && s.approval_status !== "approved") {
          return false;
        }
        return allowDraft
          ? s.status === "published" || s.status === "draft"
          : s.status === "published";
      })
      .slice(0, limit);
  }
  return [];
}

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: async () => ({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: mockInternalQuery,
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
  // Popular-suggestion resolver — mirrors the real impl: builds the same SQL
  // (org scope + approval gate + mode-driven status clause) and routes through
  // `internalQuery`, so the predicate lives in the chokepoint above rather than
  // being reimplemented here. Honors `mode` so a developer-mode caller would
  // see drafts exactly as Postgres would.
  getPopularSuggestions: async (
    orgId: string | null,
    limit = 10,
    mode: "published" | "developer" = "published",
  ) => {
    const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
    const statusClause =
      mode === "developer"
        ? "query_suggestions.status IN ('published', 'draft')"
        : "query_suggestions.status = 'published'";
    const params = orgId != null ? [orgId, limit] : [limit];
    return mockInternalQuery(
      `SELECT * FROM query_suggestions WHERE ${orgClause} AND approval_status = 'approved' AND ${statusClause} ORDER BY score DESC LIMIT $${params.length}`,
      params,
    );
  },
  upsertSuggestion: async () => "created",
  getSuggestionsByTables: async () => [],
  incrementSuggestionClick: () => {},
  deleteSuggestion: async () => false,
  getAuditLogQueries: async () => [],
}));

void mock.module("@atlas/api/lib/settings", () => {
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
  buildOrgKnowledgeSection,
  resolveOrgKnowledgeSection,
} = await import("@atlas/api/lib/learn/org-knowledge-section");
const { _resetPatternCache } = await import("@atlas/api/lib/learn/pattern-cache");

function pattern(over: Partial<RelevantPattern> = {}): RelevantPattern {
  return {
    sourceEntity: "companies",
    description: "Total company revenue",
    patternSql: "SELECT SUM(revenue) FROM companies",
    avgDurationMs: null,
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

  test("surfaces a pattern's average latency when measured (PRD #3617 B-2)", () => {
    const section = buildOrgKnowledgeSection({
      patterns: [pattern({ avgDurationMs: 123.4 })],
      favorites: [],
      suggestions: [],
    });
    expect(section).toContain("(avg ~123ms)");
  });

  test("omits the latency hint for a never-observed pattern", () => {
    const section = buildOrgKnowledgeSection({
      patterns: [pattern({ avgDurationMs: null })],
      favorites: [],
      suggestions: [],
    });
    expect(section).not.toContain("(avg ~");
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

  test("developer mode surfaces approved drafts that published mode hides", async () => {
    suggestionRows = [
      { id: "s-draft", org_id: "org-a", description: "Queued approved draft", approval_status: "approved", status: "draft" },
      { id: "s-published", org_id: "org-a", description: "Live published question", approval_status: "approved", status: "published" },
    ];

    const published = await resolveOrgKnowledgeSection({
      orgId: "org-a",
      userId: "user-a",
      connectionGroupId: null,
      mode: "published",
      question: "show me revenue",
    });
    expect(published).toContain("Live published question");
    expect(published).not.toContain("Queued approved draft");

    const developer = await resolveOrgKnowledgeSection({
      orgId: "org-a",
      userId: "user-a",
      connectionGroupId: null,
      mode: "developer",
      question: "show me revenue",
    });
    expect(developer).toContain("Live published question");
    expect(developer).toContain("Queued approved draft");
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
