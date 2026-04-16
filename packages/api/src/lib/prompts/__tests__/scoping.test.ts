/**
 * Unit tests for prompt collection scoping (#1438).
 *
 * Covers `buildCollectionsListQuery`, `buildCollectionGetQuery`, and
 * `resolvePromptDemoContext` under the (orgId × mode × demoIndustry ×
 * demoConnectionActive) matrix. No HTTP layer.
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
  resolvePromptDemoContext,
} = await import("../scoping");
import type { PromptScope } from "../scoping";

function scope(overrides: Partial<PromptScope> = {}): PromptScope {
  return {
    orgId: "org-1",
    mode: "published",
    demoIndustry: null,
    demoConnectionActive: false,
    ...overrides,
  };
}

describe("buildCollectionsListQuery", () => {
  it("published + demo active: matches industry built-ins + custom published", () => {
    const q = buildCollectionsListQuery(
      scope({ demoIndustry: "cybersecurity", demoConnectionActive: true }),
    );
    expect(q.sql).toContain("status = 'published'");
    expect(q.sql).not.toContain("status IN");
    expect(q.sql).toContain("is_builtin = true AND industry = $2");
    expect(q.sql).toContain("(org_id IS NULL OR org_id = $1)");
    expect(q.sql).toContain("is_builtin = false AND org_id = $1");
    expect(q.params).toEqual(["org-1", "cybersecurity"]);
  });

  it("published + demo archived: only custom published, hides all built-ins", () => {
    const q = buildCollectionsListQuery(
      scope({ demoIndustry: "cybersecurity", demoConnectionActive: false }),
    );
    expect(q.sql).toContain("status = 'published'");
    expect(q.sql).toContain("org_id = $1");
    expect(q.sql).toContain("is_builtin = false");
    expect(q.sql).not.toContain("industry =");
    expect(q.sql).not.toContain("org_id IS NULL OR");
    expect(q.params).toEqual(["org-1"]);
  });

  it("published + no demo industry even when connection active: hides all built-ins", () => {
    // Edge case: __demo__ exists as published connection but industry unset.
    // Without an industry filter we'd show every global builtin; safer to hide.
    const q = buildCollectionsListQuery(
      scope({ demoIndustry: null, demoConnectionActive: true }),
    );
    expect(q.sql).toContain("org_id = $1");
    expect(q.sql).toContain("is_builtin = false");
    expect(q.sql).not.toContain("industry =");
    expect(q.params).toEqual(["org-1"]);
  });

  it("developer + demo active: status IN + industry + custom (incl. drafts)", () => {
    const q = buildCollectionsListQuery(
      scope({
        mode: "developer",
        demoIndustry: "cybersecurity",
        demoConnectionActive: true,
      }),
    );
    expect(q.sql).toContain("status IN ('published', 'draft')");
    expect(q.sql).not.toContain("archived");
    expect(q.sql).toContain("is_builtin = true AND industry = $2");
    expect(q.sql).toContain("is_builtin = false AND org_id = $1");
    expect(q.params).toEqual(["org-1", "cybersecurity"]);
  });

  it("developer + no demo: only custom (published + draft)", () => {
    const q = buildCollectionsListQuery(
      scope({ mode: "developer", demoConnectionActive: false }),
    );
    expect(q.sql).toContain("status IN ('published', 'draft')");
    expect(q.sql).toContain("org_id = $1");
    expect(q.sql).toContain("is_builtin = false");
    expect(q.sql).not.toContain("industry =");
    expect(q.params).toEqual(["org-1"]);
  });

  it("no orgId (single-tenant): global built-ins only, no industry/custom filter", () => {
    const q = buildCollectionsListQuery(
      scope({ orgId: undefined, demoIndustry: "cybersecurity", demoConnectionActive: true }),
    );
    expect(q.sql).toContain("org_id IS NULL");
    expect(q.sql).toContain("status = 'published'");
    expect(q.sql).not.toContain("industry =");
    expect(q.sql).not.toContain("is_builtin = false");
    expect(q.params).toEqual([]);
  });

  it("no orgId + developer: global built-ins, status IN", () => {
    const q = buildCollectionsListQuery(
      scope({ orgId: undefined, mode: "developer" }),
    );
    expect(q.sql).toContain("org_id IS NULL");
    expect(q.sql).toContain("status IN ('published', 'draft')");
    expect(q.params).toEqual([]);
  });

  it("mode defaults to published when undefined", () => {
    const q = buildCollectionsListQuery(scope({ mode: undefined }));
    expect(q.sql).toContain("status = 'published'");
    expect(q.sql).not.toContain("status IN");
  });

  it("includes ORDER BY on list queries", () => {
    const q = buildCollectionsListQuery(scope());
    expect(q.sql).toContain("ORDER BY sort_order ASC, created_at ASC");
  });
});

describe("buildCollectionGetQuery", () => {
  it("appends id filter with next positional placeholder (demo active)", () => {
    const q = buildCollectionGetQuery(
      scope({ demoIndustry: "cybersecurity", demoConnectionActive: true }),
      "col-1",
    );
    expect(q.sql).not.toContain("ORDER BY");
    expect(q.sql).toContain("AND id = $3");
    expect(q.params).toEqual(["org-1", "cybersecurity", "col-1"]);
  });

  it("appends id filter (custom-only branch)", () => {
    const q = buildCollectionGetQuery(scope(), "col-2");
    expect(q.sql).not.toContain("ORDER BY");
    expect(q.sql).toContain("AND id = $2");
    expect(q.params).toEqual(["org-1", "col-2"]);
  });

  it("appends id filter (no-orgId branch)", () => {
    const q = buildCollectionGetQuery(scope({ orgId: undefined }), "col-3");
    expect(q.sql).not.toContain("ORDER BY");
    expect(q.sql).toContain("AND id = $1");
    expect(q.params).toEqual(["col-3"]);
  });
});

describe("resolvePromptDemoContext", () => {
  // Reset fixtures + call count before each scenario
  function reset({
    hasDB = true,
    industry,
  }: { hasDB?: boolean; industry?: string } = {}) {
    hasInternalDBFixture = hasDB;
    demoIndustryFixture = industry;
    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementation(async () => [] as unknown[]);
  }

  it("returns defaults and skips DB when orgId is undefined", async () => {
    reset();
    const result = await resolvePromptDemoContext(undefined);
    expect(result).toEqual({ demoIndustry: null, demoConnectionActive: false });
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns defaults and skips DB when internal DB is unavailable", async () => {
    reset({ hasDB: false, industry: "cybersecurity" });
    const result = await resolvePromptDemoContext("org-1");
    expect(result).toEqual({ demoIndustry: null, demoConnectionActive: false });
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns industry + active=true when demo exists as published connection", async () => {
    reset({ industry: "cybersecurity" });
    mockInternalQuery.mockImplementation(async () => [{ active: true }]);
    const result = await resolvePromptDemoContext("org-1");
    expect(result).toEqual({
      demoIndustry: "cybersecurity",
      demoConnectionActive: true,
    });
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("__demo__");
    expect(sql).toContain("status = 'published'");
    expect(params).toEqual(["org-1"]);
  });

  it("returns industry + active=false when demo row reports inactive", async () => {
    reset({ industry: "saas" });
    mockInternalQuery.mockImplementation(async () => [{ active: false }]);
    const result = await resolvePromptDemoContext("org-1");
    expect(result.demoIndustry).toBe("saas");
    expect(result.demoConnectionActive).toBe(false);
  });

  it("returns active=false when EXISTS query returns no rows", async () => {
    reset({ industry: "saas" });
    mockInternalQuery.mockImplementation(async () => [] as unknown[]);
    const result = await resolvePromptDemoContext("org-1");
    expect(result.demoConnectionActive).toBe(false);
  });

  it("normalizes a missing ATLAS_DEMO_INDUSTRY setting to null", async () => {
    reset({ industry: undefined });
    mockInternalQuery.mockImplementation(async () => [{ active: true }]);
    const result = await resolvePromptDemoContext("org-1");
    expect(result.demoIndustry).toBeNull();
    expect(result.demoConnectionActive).toBe(true);
  });

  it("treats non-strict-true `active` values as inactive", async () => {
    // Defense-in-depth: some drivers have returned "t" or 1 historically;
    // strict equality keeps demoConnectionActive pinned to real booleans.
    reset({ industry: "saas" });
    mockInternalQuery.mockImplementation(async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulating loose driver output
      [{ active: "t" as any }],
    );
    const result = await resolvePromptDemoContext("org-1");
    expect(result.demoConnectionActive).toBe(false);
  });
});
