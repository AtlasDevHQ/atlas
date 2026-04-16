/**
 * Unit tests for prompt collection scoping (#1438).
 *
 * Covers `buildCollectionsListQuery` and `buildCollectionGetQuery` under
 * the (orgId × mode × demoIndustry × demoConnectionActive) matrix.
 * No HTTP layer — pure query builder.
 */
import { describe, it, expect } from "bun:test";
import {
  buildCollectionsListQuery,
  buildCollectionGetQuery,
  type PromptScope,
} from "../scoping";

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
