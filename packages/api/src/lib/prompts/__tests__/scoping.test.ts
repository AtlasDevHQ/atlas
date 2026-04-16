/**
 * Unit tests for prompt collection scoping.
 *
 * Covers `buildCollectionsListQuery`, `buildCollectionGetQuery`, and
 * `resolvePromptScope` under the (orgId × mode × demoIndustry ×
 * demoConnectionActive) matrix expressed as the tagged scope union.
 * No HTTP layer.
 *
 * See: #1438.
 */
import { describe, it, expect, mock } from "bun:test";

// ── Module mocks (must run before importing scoping) ───────────────

let hasInternalDBFixture = true;
let demoIndustryFixture: string | undefined;
const mockInternalQuery = mock(
  async (_sql: string, _params?: unknown[]) => [] as unknown[],
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBFixture,
  internalQuery: mockInternalQuery,
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string, _orgId?: string) =>
    key === "ATLAS_DEMO_INDUSTRY" ? demoIndustryFixture : undefined,
  getSetting: () => undefined,
}));

// Imports MUST come after mock.module calls.
const {
  buildCollectionsListQuery,
  buildCollectionGetQuery,
  resolvePromptScope,
} = await import("../scoping");
import type { PromptScope } from "../scoping";
import type { AtlasMode } from "@useatlas/types/auth";

// Scope constructors — one per variant, so each test reads declaratively.
function globalScope(mode: AtlasMode = "published"): PromptScope {
  return { kind: "global", mode };
}

function customOnlyScope(
  orgId = "org-1",
  mode: AtlasMode = "published",
): PromptScope {
  return { kind: "org-custom-only", orgId, mode };
}

function withDemoScope(
  orgId = "org-1",
  demoIndustry = "cybersecurity",
  mode: AtlasMode = "published",
): PromptScope {
  return { kind: "org-with-demo", orgId, mode, demoIndustry };
}

describe("buildCollectionsListQuery", () => {
  it("org-with-demo (published): industry-filtered built-ins + custom published", () => {
    const q = buildCollectionsListQuery(withDemoScope());
    expect(q.sql).toContain("status = 'published'");
    expect(q.sql).not.toContain("status IN");
    expect(q.sql).toContain("is_builtin = true AND industry = $2");
    expect(q.sql).toContain("(org_id IS NULL OR org_id = $1)");
    expect(q.sql).toContain("is_builtin = false AND org_id = $1");
    expect(q.params).toEqual(["org-1", "cybersecurity"]);
  });

  it("org-custom-only (published): hides all built-ins, only custom published", () => {
    const q = buildCollectionsListQuery(customOnlyScope());
    expect(q.sql).toContain("status = 'published'");
    expect(q.sql).toContain("org_id = $1");
    expect(q.sql).toContain("is_builtin = false");
    expect(q.sql).not.toContain("industry =");
    expect(q.sql).not.toContain("org_id IS NULL OR");
    expect(q.params).toEqual(["org-1"]);
  });

  it("org-with-demo (developer): status IN + industry + custom (incl. drafts)", () => {
    const q = buildCollectionsListQuery(
      withDemoScope("org-1", "cybersecurity", "developer"),
    );
    expect(q.sql).toContain("status IN ('published', 'draft')");
    expect(q.sql).not.toContain("archived");
    expect(q.sql).toContain("is_builtin = true AND industry = $2");
    expect(q.sql).toContain("is_builtin = false AND org_id = $1");
    expect(q.params).toEqual(["org-1", "cybersecurity"]);
  });

  it("org-custom-only (developer): only custom (published + draft)", () => {
    const q = buildCollectionsListQuery(customOnlyScope("org-1", "developer"));
    expect(q.sql).toContain("status IN ('published', 'draft')");
    expect(q.sql).toContain("org_id = $1");
    expect(q.sql).toContain("is_builtin = false");
    expect(q.sql).not.toContain("industry =");
    expect(q.params).toEqual(["org-1"]);
  });

  it("global (published): global built-ins only, no industry/custom filter", () => {
    const q = buildCollectionsListQuery(globalScope());
    expect(q.sql).toContain("org_id IS NULL");
    expect(q.sql).toContain("status = 'published'");
    expect(q.sql).not.toContain("industry =");
    expect(q.sql).not.toContain("is_builtin = false");
    expect(q.params).toEqual([]);
  });

  it("global (developer): global built-ins, status IN", () => {
    const q = buildCollectionsListQuery(globalScope("developer"));
    expect(q.sql).toContain("org_id IS NULL");
    expect(q.sql).toContain("status IN ('published', 'draft')");
    expect(q.params).toEqual([]);
  });

  it("includes ORDER BY on list queries", () => {
    const q = buildCollectionsListQuery(customOnlyScope());
    expect(q.sql).toContain("ORDER BY sort_order ASC, created_at ASC");
  });
});

describe("buildCollectionGetQuery", () => {
  it("org-with-demo: appends id as $3 after orgId + industry", () => {
    const q = buildCollectionGetQuery(withDemoScope(), "col-1");
    expect(q.sql).not.toContain("ORDER BY");
    expect(q.sql).toContain("AND id = $3");
    expect(q.sql).toContain("is_builtin = true AND industry = $2");
    expect(q.params).toEqual(["org-1", "cybersecurity", "col-1"]);
  });

  it("org-custom-only: appends id as $2 after orgId", () => {
    const q = buildCollectionGetQuery(customOnlyScope(), "col-2");
    expect(q.sql).not.toContain("ORDER BY");
    expect(q.sql).toContain("AND id = $2");
    expect(q.sql).toContain("org_id = $1");
    expect(q.sql).toContain("is_builtin = false");
    expect(q.params).toEqual(["org-1", "col-2"]);
  });

  it("global: id as $1, no org filter", () => {
    const q = buildCollectionGetQuery(globalScope(), "col-3");
    expect(q.sql).not.toContain("ORDER BY");
    expect(q.sql).toContain("AND id = $1");
    expect(q.sql).toContain("org_id IS NULL");
    expect(q.params).toEqual(["col-3"]);
  });

  it("inherits developer status clause", () => {
    const q = buildCollectionGetQuery(customOnlyScope("org-1", "developer"), "col-x");
    expect(q.sql).toContain("status IN ('published', 'draft')");
  });
});

describe("resolvePromptScope", () => {
  function reset({
    hasDB = true,
    industry,
  }: { hasDB?: boolean; industry?: string } = {}) {
    hasInternalDBFixture = hasDB;
    demoIndustryFixture = industry;
    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementation(async () => [] as unknown[]);
  }

  it("returns `global` variant when orgId is undefined, skips DB", async () => {
    reset();
    const scope = await resolvePromptScope({ orgId: undefined, mode: "published" });
    expect(scope.kind).toBe("global");
    expect(scope.mode).toBe("published");
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns `global` variant when internal DB is unavailable, skips DB", async () => {
    reset({ hasDB: false, industry: "cybersecurity" });
    const scope = await resolvePromptScope({ orgId: "org-1", mode: "developer" });
    expect(scope.kind).toBe("global");
    expect(scope.mode).toBe("developer");
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns `org-with-demo` when demo is published + industry set", async () => {
    reset({ industry: "cybersecurity" });
    mockInternalQuery.mockImplementation(async () => [{ active: true }]);
    const scope = await resolvePromptScope({ orgId: "org-1", mode: "developer" });
    expect(scope.kind).toBe("org-with-demo");
    if (scope.kind === "org-with-demo") {
      expect(scope.orgId).toBe("org-1");
      expect(scope.demoIndustry).toBe("cybersecurity");
      expect(scope.mode).toBe("developer");
    }
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("__demo__");
    expect(sql).toContain("status = 'published'");
    expect(params).toEqual(["org-1"]);
  });

  it("returns `org-custom-only` when demo row reports inactive", async () => {
    reset({ industry: "saas" });
    mockInternalQuery.mockImplementation(async () => [{ active: false }]);
    const scope = await resolvePromptScope({ orgId: "org-1", mode: "published" });
    expect(scope.kind).toBe("org-custom-only");
  });

  it("returns `org-custom-only` when EXISTS query returns no rows", async () => {
    reset({ industry: "saas" });
    mockInternalQuery.mockImplementation(async () => [] as unknown[]);
    const scope = await resolvePromptScope({ orgId: "org-1", mode: "published" });
    expect(scope.kind).toBe("org-custom-only");
  });

  it("returns `org-custom-only` when industry setting is missing even if demo is active", async () => {
    reset({ industry: undefined });
    mockInternalQuery.mockImplementation(async () => [{ active: true }]);
    const scope = await resolvePromptScope({ orgId: "org-1", mode: "published" });
    expect(scope.kind).toBe("org-custom-only");
  });

  it("treats non-strict-true `active` values as inactive", async () => {
    // Defense-in-depth: some drivers have returned "t" or 1 historically;
    // strict equality keeps the scope decision pinned to real booleans.
    reset({ industry: "saas" });
    mockInternalQuery.mockImplementation(async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulating loose driver output
      [{ active: "t" as any }],
    );
    const scope = await resolvePromptScope({ orgId: "org-1", mode: "published" });
    expect(scope.kind).toBe("org-custom-only");
  });

  it("defaults mode to published when undefined", async () => {
    reset();
    const scope = await resolvePromptScope({ orgId: undefined, mode: undefined });
    expect(scope.mode).toBe("published");
  });
});
