/**
 * Unit tests for `resolveStarterPrompts`.
 *
 * Covers:
 *   - cold-start: no demo industry / null orgId / empty library
 *   - favorites tier: ordering, limit consumption, failure fallthrough
 *   - library tier: demo-industry filter, dev-mode draft visibility
 *   - limit clamping: MAX_LIMIT, zero, negative, NaN, Infinity, non-integer
 *   - provenance tags and id namespacing (library:<uuid>)
 *   - cold-window filter passed as SQL param; built-ins exempt in SQL body
 *   - compose-order contract: popular tier does not emit yet
 *   - library SQL failure → empty tier (cold-start fallback)
 *   - settings read failure → propagates rather than masquerading as cold-start
 *   - coldWindowDays runtime guard (non-finite / non-integer / zero rejected)
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { FavoritePromptRow } from "../favorite-store";

// ── Module mocks (must run before importing the resolver) ────────────────

let demoIndustryFixture: string | undefined;
let demoReadErrorFixture: Error | null = null;
let hasInternalDBFixture = true;

const mockInternalQuery = mock(
  async (_sql: string, _params?: unknown[]) => [] as unknown[],
);

// Popular tier — mocked at the helper boundary so resolver tests don't
// need to know the SQL shape. Each test sets `popularFixture` or
// `popularReadErrorFixture` to drive behavior.
let popularFixture: Array<{ id: string; description: string }> = [];
let popularReadErrorFixture: Error | null = null;
const mockGetPopularSuggestions = mock(
  async (
    _orgId: string | null,
    _limit?: number,
    _mode?: "developer" | "published",
  ) => {
    if (popularReadErrorFixture) throw popularReadErrorFixture;
    // Return rows shaped loosely like QuerySuggestionRow — the resolver
    // only reads id + description.
    return popularFixture.map((r) => ({
      id: r.id,
      description: r.description,
      // Pad with enough fields for the row shape without asserting them here.
      approval_status: "approved" as const,
    }));
  },
);

// Favorites tier — mocked at the store boundary so resolver tests do not
// have to care about SQL shape.
let favoritesFixture: FavoritePromptRow[] = [];
let favoritesReadErrorFixture: Error | null = null;
const mockListFavorites = mock(
  async (_userId: string, _orgId: string) => {
    if (favoritesReadErrorFixture) throw favoritesReadErrorFixture;
    return favoritesFixture;
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBFixture,
  internalQuery: mockInternalQuery,
  getPopularSuggestions: mockGetPopularSuggestions,
}));

mock.module("../favorite-store", () => ({
  // Mock every export to satisfy Bun's mock.module partial-mock rule (CLAUDE.md).
  FAVORITE_TEXT_MAX_LENGTH: 2000,
  FavoriteCapError: class FavoriteCapError extends Error {
    public readonly _tag = "FavoriteCapError" as const;
    constructor(public readonly cap: number) { super(`cap ${cap}`); }
  },
  DuplicateFavoriteError: class DuplicateFavoriteError extends Error {
    public readonly _tag = "DuplicateFavoriteError" as const;
    constructor() { super("duplicate"); }
  },
  listFavorites: mockListFavorites,
  createFavorite: mock(async () => { throw new Error("createFavorite not used in resolver tests"); }),
  deleteFavorite: mock(async () => ({ status: "not_found" as const })),
  updateFavoritePosition: mock(async () => ({ status: "not_found" as const })),
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
  favoritesFixture = [];
  favoritesReadErrorFixture = null;
  popularFixture = [];
  popularReadErrorFixture = null;
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async () => [] as unknown[]);
  mockGetPopularSuggestions.mockClear();
  mockListFavorites.mockClear();
});

function favRow(overrides: Partial<FavoritePromptRow> = {}): FavoritePromptRow {
  return {
    id: "fav-1",
    userId: "user-1",
    orgId: "org-1",
    text: "favorite text",
    position: 1,
    createdAt: new Date("2026-04-17T00:00:00Z"),
    ...overrides,
  };
}

describe("resolveStarterPrompts — cold-start", () => {
  it("returns empty when no demo industry set", async () => {
    demoIndustryFixture = undefined;

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([]);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("runs the library tier with orgId=null and scopes to global builtin prompts (#1944)", async () => {
    // With no workspace context (e.g. demo bearer, single-tenant unauth), the
    // library tier still runs but the SQL `pc.org_id = $2` collapses to NULL,
    // leaving only `pc.org_id IS NULL` rows visible — the global `__demo__`
    // cohort prompts. The default mock returns no rows, so this test asserts
    // empty output AND that the SQL ran with `params[1] = null`.
    demoIndustryFixture = "cybersecurity";

    const result = await resolveStarterPrompts(baseCtx({ orgId: null }));

    expect(result).toEqual([]);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockInternalQuery.mock.calls[0]!;
    expect(params![1]).toBeNull();
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

describe("resolveStarterPrompts — favorites tier", () => {
  it("emits favorites first, tagged with provenance='favorite' and namespaced ids", async () => {
    favoritesFixture = [
      favRow({ id: "fav-a", text: "pinned 1", position: 3 }),
      favRow({ id: "fav-b", text: "pinned 2", position: 2 }),
    ];
    mockInternalQuery.mockImplementation(async () => []);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([
      { id: "favorite:fav-a", text: "pinned 1", provenance: "favorite" },
      { id: "favorite:fav-b", text: "pinned 2", provenance: "favorite" },
    ]);
  });

  it("places favorites ahead of library tier when both have rows", async () => {
    favoritesFixture = [favRow({ id: "fav-a", text: "my pin" })];
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "lib-1", question: "library row" },
    ]);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result.map((p) => p.provenance)).toEqual(["favorite", "library"]);
    expect(result[0]).toMatchObject({ id: "favorite:fav-a" });
    expect(result[1]).toMatchObject({ id: "library:lib-1" });
  });

  it("preserves the store's ordering — resolver does not resort favorites", async () => {
    // listFavorites is the sort authority (position DESC, created_at DESC).
    // The resolver is a pure composer; re-sorting here would mask store bugs.
    favoritesFixture = [
      favRow({ id: "fav-a", text: "third" }),
      favRow({ id: "fav-b", text: "first" }),
      favRow({ id: "fav-c", text: "second" }),
    ];

    const result = await resolveStarterPrompts(baseCtx());

    expect(result.map((p) => p.text)).toEqual(["third", "first", "second"]);
  });

  it("stops consuming library slots when favorites fill the limit", async () => {
    favoritesFixture = [
      favRow({ id: "fav-a", text: "1" }),
      favRow({ id: "fav-b", text: "2" }),
      favRow({ id: "fav-c", text: "3" }),
      favRow({ id: "fav-d", text: "4" }),
    ];
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => []);

    const result = await resolveStarterPrompts(baseCtx({ limit: 3 }));

    expect(result).toHaveLength(3);
    expect(result.every((p) => p.provenance === "favorite")).toBe(true);
    // With favorites exceeding the limit the library query must not be issued.
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("asks the library for only the remaining slots after favorites", async () => {
    favoritesFixture = [favRow({ id: "fav-a", text: "pin" })];
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => []);

    await resolveStarterPrompts(baseCtx({ limit: 6 }));

    const [, params] = mockInternalQuery.mock.calls[0]!;
    // limit = 6 total, 1 favorite consumed → library requests 5.
    expect(params![3]).toBe(5);
  });

  it("skips the favorites tier when userId is null (no session)", async () => {
    favoritesFixture = [favRow()];

    const result = await resolveStarterPrompts(baseCtx({ userId: null }));

    expect(mockListFavorites).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("swallows listFavorites failure and continues to library (cold-start fallback)", async () => {
    // Pins are an optimization; a transient DB hiccup on the favorites
    // read must not black out the whole empty state.
    favoritesReadErrorFixture = new Error("transient connection error");
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "lib-1", question: "library row" },
    ]);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([
      { id: "library:lib-1", text: "library row", provenance: "library" },
    ]);
  });
});

describe("resolveStarterPrompts — popular tier (approved-only)", () => {
  it("emits popular-provenance rows with namespaced ids between favorites and library", async () => {
    favoritesFixture = [favRow({ id: "fav-a", text: "my pin" })];
    popularFixture = [
      { id: "pop-1", description: "approved popular row" },
      { id: "pop-2", description: "another approved row" },
    ];
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "lib-1", question: "library row" },
    ]);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result.map((p) => p.provenance)).toEqual([
      "favorite",
      "popular",
      "popular",
      "library",
    ]);
    expect(result[1]).toMatchObject({
      id: "popular:pop-1",
      text: "approved popular row",
      provenance: "popular",
    });
    expect(result[2]).toMatchObject({
      id: "popular:pop-2",
      text: "another approved row",
    });
  });

  it("passes orgId, remaining limit, and mode to getPopularSuggestions", async () => {
    favoritesFixture = [favRow({ id: "fav-a", text: "pin" })];
    demoIndustryFixture = "cybersecurity";

    await resolveStarterPrompts(baseCtx({ limit: 6 }));

    expect(mockGetPopularSuggestions).toHaveBeenCalled();
    const callArgs = mockGetPopularSuggestions.mock.calls[0]!;
    expect(callArgs[0]).toBe("org-1");
    // 6 total, 1 favorite consumed → popular requests up to 5.
    expect(callArgs[1]).toBe(5);
    // Mode threads through from the route to the store so the published
    // surface never leaks draft rows to non-admins.
    expect(callArgs[2]).toBe("published");
  });

  it("threads developer mode into getPopularSuggestions so drafts overlay in the admin view", async () => {
    demoIndustryFixture = "cybersecurity";

    await resolveStarterPrompts(baseCtx({ mode: "developer" }));

    const callArgs = mockGetPopularSuggestions.mock.calls[0]!;
    expect(callArgs[2]).toBe("developer");
  });

  it("stops consuming library slots when popular fills the limit", async () => {
    popularFixture = [
      { id: "pop-1", description: "r1" },
      { id: "pop-2", description: "r2" },
      { id: "pop-3", description: "r3" },
    ];
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "lib-1", question: "library — should not appear" },
    ]);

    const result = await resolveStarterPrompts(baseCtx({ limit: 3 }));

    expect(result.map((p) => p.provenance)).toEqual([
      "popular",
      "popular",
      "popular",
    ]);
    // Library query must not fire when popular already saturates the limit.
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("falls through to library when the popular read fails", async () => {
    // Popular is an optimization, not a hard dependency. A transient
    // read failure must not black out the empty state — fall through to
    // library / cold-start.
    popularReadErrorFixture = new Error("transient popular query failure");
    demoIndustryFixture = "cybersecurity";
    mockInternalQuery.mockImplementation(async () => [
      { id: "lib-1", question: "library row" },
    ]);

    const result = await resolveStarterPrompts(baseCtx());

    expect(result).toEqual([
      { id: "library:lib-1", text: "library row", provenance: "library" },
    ]);
  });

  it("skips the popular tier when orgId is null (no workspace)", async () => {
    popularFixture = [{ id: "pop-1", description: "should not appear" }];

    const result = await resolveStarterPrompts(baseCtx({ orgId: null }));

    expect(mockGetPopularSuggestions).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe("resolveStarterPrompts — compose-order contract", () => {
  it("never emits cold-start-provenance rows (cold-start = empty list)", async () => {
    demoIndustryFixture = undefined;

    const result = await resolveStarterPrompts(baseCtx());

    expect(result.some((p) => p.provenance === "cold-start")).toBe(false);
  });
});

describe("resolveStarterPrompts — error handling", () => {
  it("propagates settings read failures so the endpoint can 500", async () => {
    // Don't silently mask a transient settings-read failure.
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
