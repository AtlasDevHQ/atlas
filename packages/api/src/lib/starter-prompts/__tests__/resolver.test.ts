/**
 * Unit tests for `resolveStarterPrompts` (#1474).
 *
 * Covers:
 *   - cold-start: no demo industry / null orgId / empty library
 *   - library: demo industry set → prompts from prompt_items, dev-mode end-to-end
 *   - limit clamping: MAX_LIMIT, zero, negative, NaN, Infinity, non-integer
 *   - provenance tags and id namespacing (library:<uuid>)
 *   - cold-window filter passed as SQL param; built-ins exempt in SQL body
 *   - compose-order contract: favorites + popular tiers do NOT emit
 *   - library SQL failure → empty tier (cold-start fallback)
 *   - settings read failure → propagates (callers 500 per #1470)
 *   - coldWindowDays runtime guard (non-finite / non-integer / zero rejected)
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
  getSettingAuto: (key: string, _orgId?: string) => {
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

describe("resolveStarterPrompts — cold-start", () => {
  it("returns empty when no demo industry set", async () => {
    demoIndustryFixture = undefined;

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([]);
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
  it("returns library prompts tagged with provenance='library' and namespaced ids", async () => {
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "item-a", question: "How many open incidents this week?" },
      { id: "item-b", question: "Which hosts have unpatched CVEs?" },
    ]);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([
      { id: "library:item-a", text: "How many open incidents this week?", provenance: "library" },
      { id: "library:item-b", text: "Which hosts have unpatched CVEs?", provenance: "library" },
    ]);
    expect(result.every((p) => p.provenance === "library")).toBe(true);
    expect(result.every((p) => p.id.startsWith("library:"))).toBe(true);
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

  it("exempts built-in rows from the cold-window filter in the SQL body", async () => {
    demoIndustryFixture = "cybersecurity";

    await resolveStarterPrompts(baseCtx());

    const [sql] = mockInternalQuery.mock.calls[0]!;
    // Built-ins shipped at migration time have static created_at; the cold
    // window applies only to org-scoped custom rows.
    expect(sql).toContain("pc.is_builtin = true OR pc.created_at");
  });

  it("uses published-only status clause in published mode", async () => {
    demoIndustryFixture = "cybersecurity";

    await resolveStarterPrompts(baseCtx({ mode: "published" }));

    const [sql] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("pc.status = 'published'");
    expect(sql).not.toContain("'draft'");
  });

  it("expands to published + draft in developer mode and emits rows", async () => {
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "draft-1", question: "draft query" },
    ]);

    const result = await resolveStarterPrompts(baseCtx({ mode: "developer" }));

    const [sql] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("pc.status IN ('published', 'draft')");
    expect(result).toEqual([
      { id: "library:draft-1", text: "draft query", provenance: "library" },
    ]);
  });

  it("clamps limit to MAX_LIMIT (50) for large values", async () => {
    demoIndustryFixture = "cybersecurity";

    await resolveStarterPrompts(baseCtx({ limit: 9999 }));

    const [, params] = mockInternalQuery.mock.calls[0]!;
    expect(params).toEqual(["cybersecurity", "org-1", "90", 50]);
  });

  it("short-circuits (no DB query) for zero / negative / non-finite limits", async () => {
    demoIndustryFixture = "cybersecurity";

    for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      mockInternalQuery.mockClear();
      const result = await resolveStarterPrompts(baseCtx({ limit: bad }));
      expect(result).toEqual([]);
      expect(mockInternalQuery).not.toHaveBeenCalled();
    }
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

describe("resolveStarterPrompts — compose-order contract", () => {
  // Locks the invariant that only the library tier emits rows in this slice.
  // When #1475 / #1476 / #1477 land, these tests will need updating in lock-step
  // with their new emit behavior — if they silently drift, we catch it here.
  it("never emits favorite-provenance rows in this slice", async () => {
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "item-x", question: "library row" },
    ]);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result.some((p) => p.provenance === "favorite")).toBe(false);
  });

  it("never emits popular-provenance rows in this slice", async () => {
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "item-y", question: "library row" },
    ]);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result.some((p) => p.provenance === "popular")).toBe(false);
  });

  it("never emits cold-start-provenance rows in this slice", async () => {
    // Cold-start is expressed as an empty list, not a synthesized row.
    demoIndustryFixture = undefined;

    const result = await resolveStarterPrompts(baseCtx());

    expect(result.some((p) => p.provenance === "cold-start")).toBe(false);
  });
});

describe("resolveStarterPrompts — error handling", () => {
  it("propagates settings read failures so the endpoint can 500", async () => {
    // Per #1470 pattern: don't silently mask a transient read failure.
    demoReadErrorFixture = new Error("settings cache unreachable");

    await expect(resolveStarterPrompts(baseCtx())).rejects.toThrow(
      "settings cache unreachable",
    );
  });

  it("rejects non-integer coldWindowDays at the boundary", async () => {
    demoIndustryFixture = "cybersecurity";

    await expect(
      resolveStarterPrompts(baseCtx({ coldWindowDays: 3.7 })),
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects NaN / Infinity / negative coldWindowDays at the boundary", async () => {
    demoIndustryFixture = "cybersecurity";

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      await expect(
        resolveStarterPrompts(baseCtx({ coldWindowDays: bad })),
      ).rejects.toThrow(/positive integer/);
    }
  });
});
