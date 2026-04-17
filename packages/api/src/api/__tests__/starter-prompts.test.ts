/**
 * Integration tests for GET /api/v1/starter-prompts (#1474).
 *
 * Exercises route wiring end-to-end: auth gate → config → resolver →
 * response shape. Resolver has deeper unit coverage in
 * `packages/api/src/lib/starter-prompts/__tests__/resolver.test.ts`.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import {
  FavoriteCapError,
  DuplicateFavoriteError,
  type DeleteResult,
  type UpdatePositionResult,
  type FavoritePromptRow,
} from "@atlas/api/lib/starter-prompts/favorite-store";

// ── Module mocks (must run before importing the app) ────────────────────

const mocks = createApiTestMocks();

// Controls the demo-industry read per test.
let demoIndustryFixture: string | undefined;
mock.module("@atlas/api/lib/settings", () => ({
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  getSetting: () => undefined,
  // Real signature is (key: string, orgId?: string). Mirror it so per-org
  // stubs work end-to-end if a future test needs them.
  getSettingAuto: (key: string, _orgId?: string) =>
    key === "ATLAS_DEMO_INDUSTRY" ? demoIndustryFixture : undefined,
  getSettingLive: async () => undefined,
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

// Favorites-store mocks — route tests exercise the HTTP contract, not the
// store's SQL shape (covered exhaustively in favorite-store.test.ts).
const mockListFavorites = mock(
  async (_userId: string, _orgId: string) => [] as FavoritePromptRow[],
);
const mockCreateFavorite = mock(
  async (
    input: { userId: string; orgId: string; text: string },
    _cap: number,
  ): Promise<FavoritePromptRow> => ({
    id: "fav-new",
    userId: input.userId,
    orgId: input.orgId,
    text: input.text.trim(),
    position: 1,
    createdAt: new Date("2026-04-17T00:00:00Z"),
  }),
);
const mockDeleteFavorite = mock(
  async (_input: { id: string; userId: string; orgId: string }): Promise<DeleteResult> => ({
    status: "ok",
  }),
);
const mockUpdateFavoritePosition = mock(
  async (input: {
    id: string;
    userId: string;
    orgId: string;
    position: number;
  }): Promise<UpdatePositionResult> => ({
    status: "ok",
    favorite: {
      id: input.id,
      userId: input.userId,
      orgId: input.orgId,
      text: "pinned",
      position: input.position,
      createdAt: new Date("2026-04-17T00:00:00Z"),
    },
  }),
);

mock.module("@atlas/api/lib/starter-prompts/favorite-store", () => ({
  FAVORITE_TEXT_MAX_LENGTH: 2000,
  FavoriteCapError,
  DuplicateFavoriteError,
  listFavorites: mockListFavorites,
  createFavorite: mockCreateFavorite,
  deleteFavorite: mockDeleteFavorite,
  updateFavoritePosition: mockUpdateFavoritePosition,
}));

// Import the app AFTER mocks.
const { app } = await import("../index");

function req(path: string, headers: Record<string, string> = {}) {
  const url = `http://localhost${path}`;
  return app.fetch(
    new Request(url, {
      method: "GET",
      headers: { Authorization: "Bearer test", ...headers },
    }),
  );
}

function jsonReq(
  method: "POST" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
) {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: "Bearer test",
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.fetch(new Request(url, init));
}

afterAll(() => {
  mocks.cleanup();
});

beforeEach(() => {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "user-1",
        mode: "simple-key",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
      },
    }),
  );
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
  demoIndustryFixture = undefined;
  mockListFavorites.mockReset();
  mockListFavorites.mockImplementation(async () => []);
  mockCreateFavorite.mockReset();
  mockCreateFavorite.mockImplementation(async (input, _cap) => ({
    id: "fav-new",
    userId: input.userId,
    orgId: input.orgId,
    text: input.text.trim(),
    position: 1,
    createdAt: new Date("2026-04-17T00:00:00Z"),
  }));
  mockDeleteFavorite.mockReset();
  mockDeleteFavorite.mockImplementation(async () => ({ status: "ok" }));
  mockUpdateFavoritePosition.mockReset();
  mockUpdateFavoritePosition.mockImplementation(async (input) => ({
    status: "ok",
    favorite: {
      id: input.id,
      userId: input.userId,
      orgId: input.orgId,
      text: "pinned",
      position: input.position,
      createdAt: new Date("2026-04-17T00:00:00Z"),
    },
  }));
});

describe("GET /api/v1/starter-prompts", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );

    const res = await req("/api/v1/starter-prompts");

    expect(res.status).toBe(401);
  });

  it("returns empty list when no demo industry is set (cold-start)", async () => {
    demoIndustryFixture = undefined;

    const res = await req("/api/v1/starter-prompts");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prompts).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns library prompts with namespaced ids for the workspace's demo industry", async () => {
    demoIndustryFixture = "cybersecurity";
    mocks.mockInternalQuery.mockImplementation(async () => [
      { id: "item-1", question: "How many open incidents this week?" },
      { id: "item-2", question: "Which hosts have unpatched CVEs?" },
    ]);

    const res = await req("/api/v1/starter-prompts");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts: Array<{ id: string; text: string; provenance: string }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.prompts).toEqual([
      { id: "library:item-1", text: "How many open incidents this week?", provenance: "library" },
      { id: "library:item-2", text: "Which hosts have unpatched CVEs?", provenance: "library" },
    ]);
  });

  it("clamps limit query parameter to MAX_LIMIT=50", async () => {
    demoIndustryFixture = "ecommerce";

    await req("/api/v1/starter-prompts?limit=100");

    const sqlCalls = mocks.mockInternalQuery.mock.calls;
    expect(sqlCalls.length).toBeGreaterThan(0);
    const [, params] = sqlCalls[0]!;
    expect(params![3]).toBe(50);
  });

  it("defaults to limit=6 when no query parameter is provided", async () => {
    demoIndustryFixture = "ecommerce";

    await req("/api/v1/starter-prompts");

    const sqlCalls = mocks.mockInternalQuery.mock.calls;
    expect(sqlCalls.length).toBeGreaterThan(0);
    const [, params] = sqlCalls[0]!;
    expect(params![3]).toBe(6);
  });

  it("falls back to default limit=6 when limit=0 / negative / non-numeric", async () => {
    demoIndustryFixture = "ecommerce";

    for (const bad of ["0", "-5", "abc"]) {
      mocks.mockInternalQuery.mockClear();
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));

      await req(`/api/v1/starter-prompts?limit=${bad}`);

      const sqlCalls = mocks.mockInternalQuery.mock.calls;
      expect(sqlCalls.length).toBe(1);
      const [, params] = sqlCalls[0]!;
      expect(params![3]).toBe(6);
    }
  });

  it("passes the default coldWindowDays (90) to the resolver when config is absent", async () => {
    demoIndustryFixture = "cybersecurity";

    await req("/api/v1/starter-prompts");

    const sqlCalls = mocks.mockInternalQuery.mock.calls;
    expect(sqlCalls.length).toBeGreaterThan(0);
    const [, params] = sqlCalls[0]!;
    expect(params![2]).toBe("90");
  });
});

// ── Favorites endpoints (#1475) ─────────────────────────────────────────

describe("POST /api/v1/starter-prompts/favorites", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );

    const res = await jsonReq("POST", "/api/v1/starter-prompts/favorites", {
      text: "Anything",
    });

    expect(res.status).toBe(401);
    expect(mockCreateFavorite).not.toHaveBeenCalled();
  });

  it("returns 400 when body is missing text", async () => {
    const res = await jsonReq("POST", "/api/v1/starter-prompts/favorites", {});

    expect(res.status).toBe(400);
    expect(mockCreateFavorite).not.toHaveBeenCalled();
  });

  it("returns 400 when text is empty string", async () => {
    const res = await jsonReq("POST", "/api/v1/starter-prompts/favorites", {
      text: "",
    });

    expect(res.status).toBe(400);
  });

  it("returns 200 and the created favorite on success", async () => {
    const res = await jsonReq("POST", "/api/v1/starter-prompts/favorites", {
      text: "My pinned question",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      favorite: { id: string; text: string; position: number; createdAt: string };
    };
    expect(body.favorite.text).toBe("My pinned question");
    expect(body.favorite.id).toBeTruthy();
    expect(typeof body.favorite.createdAt).toBe("string");
    expect(mockCreateFavorite).toHaveBeenCalledTimes(1);
  });

  it("passes the configured max-favorites cap through to the store", async () => {
    await jsonReq("POST", "/api/v1/starter-prompts/favorites", {
      text: "x",
    });

    const [, cap] = mockCreateFavorite.mock.calls[0]!;
    expect(cap).toBe(10);
  });

  it("returns 409 when the store throws DuplicateFavoriteError", async () => {
    mockCreateFavorite.mockImplementation(async () => {
      throw new DuplicateFavoriteError();
    });

    const res = await jsonReq("POST", "/api/v1/starter-prompts/favorites", {
      text: "dup",
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("duplicate_favorite");
  });

  it("returns 400 with user-safe message when the cap is exceeded", async () => {
    mockCreateFavorite.mockImplementation(async () => {
      throw new FavoriteCapError(10);
    });

    const res = await jsonReq("POST", "/api/v1/starter-prompts/favorites", {
      text: "over-cap",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("favorite_cap_exceeded");
    expect(body.message).toContain("10");
  });
});

describe("DELETE /api/v1/starter-prompts/favorites/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );

    const res = await jsonReq("DELETE", "/api/v1/starter-prompts/favorites/fav-1");

    expect(res.status).toBe(401);
    expect(mockDeleteFavorite).not.toHaveBeenCalled();
  });

  it("returns 204 on successful delete", async () => {
    const res = await jsonReq("DELETE", "/api/v1/starter-prompts/favorites/fav-1");

    expect(res.status).toBe(204);
  });

  it("returns 404 when the favorite does not exist", async () => {
    mockDeleteFavorite.mockImplementation(async () => ({ status: "not_found" }));

    const res = await jsonReq("DELETE", "/api/v1/starter-prompts/favorites/missing");

    expect(res.status).toBe(404);
  });

  it("returns 403 when attempting to unpin another user's favorite", async () => {
    mockDeleteFavorite.mockImplementation(async () => ({ status: "forbidden" }));

    const res = await jsonReq("DELETE", "/api/v1/starter-prompts/favorites/other");

    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/starter-prompts/favorites/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );

    const res = await jsonReq("PATCH", "/api/v1/starter-prompts/favorites/fav-1", {
      position: 2,
    });

    expect(res.status).toBe(401);
    expect(mockUpdateFavoritePosition).not.toHaveBeenCalled();
  });

  it("returns 400 when body is missing position", async () => {
    const res = await jsonReq("PATCH", "/api/v1/starter-prompts/favorites/fav-1", {});

    expect(res.status).toBe(400);
  });

  it("returns 400 when position is NaN or Infinity", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await jsonReq("PATCH", "/api/v1/starter-prompts/favorites/fav-1", {
        position: bad,
      });
      // NaN/Infinity serialize as null in JSON — schema rejects as 400.
      expect(res.status).toBe(400);
    }
  });

  it("returns 200 with the updated favorite", async () => {
    const res = await jsonReq("PATCH", "/api/v1/starter-prompts/favorites/fav-1", {
      position: 5.5,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      favorite: { id: string; position: number };
    };
    expect(body.favorite.position).toBe(5.5);
  });

  it("returns 404 when the favorite does not exist", async () => {
    mockUpdateFavoritePosition.mockImplementation(async () => ({ status: "not_found" }));

    const res = await jsonReq("PATCH", "/api/v1/starter-prompts/favorites/missing", {
      position: 1,
    });

    expect(res.status).toBe(404);
  });

  it("returns 403 when attempting to reorder another user's favorite", async () => {
    mockUpdateFavoritePosition.mockImplementation(async () => ({ status: "forbidden" }));

    const res = await jsonReq("PATCH", "/api/v1/starter-prompts/favorites/other", {
      position: 1,
    });

    expect(res.status).toBe(403);
  });
});
