/**
 * Unit tests for `resolveStarterPrompts` (#1474).
 *
 * Covers:
 *   - cold-start: no demo industry → empty list
 *   - library: demo industry set → prompts from prompt_items
 *   - limit enforcement (clamped + propagated to SQL)
 *   - provenance tags are "library" for loaded rows
 *   - cold-window filter is passed as the 3rd param to the library SQL
 *   - favorites/popular tiers are no-ops (placeholder contract for later slices)
 *   - library query failure is swallowed into empty tier (cold-start fallback)
 *   - settings read failure is propagated (so callers 500, per #1470 pattern)
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Module mocks (must run before importing the resolver) ────────────────

let demoIndustryFixture: string | undefined;
let demoReadErrorFixture: Error | null = null;
let hasInternalDBFixture = true;

const mockInternalQuery = mock(
  async (_sql: string, _params?: unknown[]) => [] as unknown[],
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBFixture,
  internalQuery: mockInternalQuery,
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string) => {
    if (demoReadErrorFixture) throw demoReadErrorFixture;
    return key === "ATLAS_DEMO_INDUSTRY" ? demoIndustryFixture : undefined;
  },
}));

// Imports MUST come after mock.module calls.
const { resolveStarterPrompts } = await import("../resolver");
import type { ResolveContext } from "../resolver";

function baseCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    orgId: "org-1",
    userId: "user-1",
    mode: "published",
    limit: 6,
    coldWindowDays: 90,
    requestId: "req-test",
    ...overrides,
  };
}

beforeEach(() => {
  demoIndustryFixture = undefined;
  demoReadErrorFixture = null;
  hasInternalDBFixture = true;
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async () => [] as unknown[]);
});

describe("resolveStarterPrompts — cold-start (no demo industry)", () => {
  it("returns empty when no demo industry set", async () => {
    demoIndustryFixture = undefined;

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([]);
    // No DB query should be issued — there's nothing to look up.
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns empty when orgId is null (single-tenant / unauth)", async () => {
    demoIndustryFixture = "cybersecurity";

    const result = await resolveStarterPrompts(baseCtx({ orgId: null }));

    expect(result).toEqual([]);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns empty when library tier finds no matching collections", async () => {
    demoIndustryFixture = "ecommerce";
    mockInternalQuery.mockImplementation(async () => []);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([]);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });
});

describe("resolveStarterPrompts — library tier", () => {
  it("returns library prompts tagged with provenance='library'", async () => {
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "item-a", question: "How many open incidents this week?" },
      { id: "item-b", question: "Which hosts have unpatched CVEs?" },
    ]);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([
      { id: "item-a", text: "How many open incidents this week?", provenance: "library" },
      { id: "item-b", text: "Which hosts have unpatched CVEs?", provenance: "library" },
    ]);
    expect(result.every((p) => p.provenance === "library")).toBe(true);
  });

  it("passes demoIndustry, orgId, coldWindowDays, and limit to the SQL query", async () => {
    demoIndustryFixture = "ecommerce";
    mockInternalQuery.mockImplementation(async () => []);

    await resolveStarterPrompts(baseCtx({ limit: 4, coldWindowDays: 45 }));

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(typeof sql).toBe("string");
    expect(params).toEqual(["ecommerce", "org-1", "45", 4]);
  });

  it("uses published-only status clause in published mode", async () => {
    demoIndustryFixture = "cybersecurity";

    await resolveStarterPrompts(baseCtx({ mode: "published" }));

    const [sql] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("pc.status = 'published'");
    expect(sql).not.toContain("'draft'");
  });

  it("expands to published + draft in developer mode", async () => {
    demoIndustryFixture = "cybersecurity";

    await resolveStarterPrompts(baseCtx({ mode: "developer" }));

    const [sql] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("pc.status IN ('published', 'draft')");
  });

  it("clamps limit to MAX_LIMIT (50) and zero when invalid", async () => {
    demoIndustryFixture = "cybersecurity";

    const big = await resolveStarterPrompts(baseCtx({ limit: 9999 }));
    expect(big).toEqual([]);
    // Query was called with clamped limit
    expect(mockInternalQuery.mock.calls[0]![1]).toEqual([
      "cybersecurity",
      "org-1",
      "90",
      50,
    ]);

    mockInternalQuery.mockClear();
    const zero = await resolveStarterPrompts(baseCtx({ limit: 0 }));
    expect(zero).toEqual([]);
    // Zero-limit short-circuit — no DB query at all.
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("short-circuits when internal DB is unavailable", async () => {
    demoIndustryFixture = "cybersecurity";
    hasInternalDBFixture = false;

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([]);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("swallows library SQL failure and returns empty (cold-start fallback)", async () => {
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("prompt_items relation does not exist");
    });

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([]);
  });
});

describe("resolveStarterPrompts — error handling", () => {
  it("propagates settings read failures so the endpoint can 500", async () => {
    // Per #1470 pattern: don't silently mask a transient read failure as "no industry".
    demoReadErrorFixture = new Error("settings cache unreachable");

    await expect(resolveStarterPrompts(baseCtx())).rejects.toThrow(
      "settings cache unreachable",
    );
  });
});
