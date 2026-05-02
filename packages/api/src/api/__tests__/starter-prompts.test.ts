/**
 * Integration tests for the `/api/v1/starter-prompts` surface.
 *
 * Exercises route wiring end-to-end: auth gate → config → resolver →
 * response shape, plus the /favorites CRUD endpoints. Resolver and
 * store have deeper unit coverage in their own __tests__/ dirs.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import {
  FavoriteCapError,
  DuplicateFavoriteError,
  InvalidFavoriteTextError,
  type DeleteResult,
  type UpdatePositionResult,
  type FavoritePromptRow,
} from "@atlas/api/lib/starter-prompts/favorite-store";
// Demo helpers read BETTER_AUTH_SECRET live on every call (not at import time),
// so a static import is safe even though the secret is only assigned in beforeAll.
import {
  signDemoToken,
  resetDemoRateLimits,
} from "@atlas/api/lib/demo";

const DEMO_TEST_SECRET = "test-secret-that-is-at-least-32-chars-long";
const ORIGINAL_BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = DEMO_TEST_SECRET;
});

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
  InvalidFavoriteTextError,
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
  if (ORIGINAL_BETTER_AUTH_SECRET !== undefined) {
    process.env.BETTER_AUTH_SECRET = ORIGINAL_BETTER_AUTH_SECRET;
  } else {
    delete process.env.BETTER_AUTH_SECRET;
  }
});

beforeEach(() => {
  // Clear call history so per-test "was/wasn't called" assertions are
  // honest (the mock accumulates across the whole file otherwise).
  mocks.mockAuthenticateRequest.mockClear();
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
  // Demo rate limiter is keyed by demoUserId(email) and persists across
  // tests in module-level state — clear it so per-test budgets are reset.
  resetDemoRateLimits();
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

// ── Demo bearer auth (#1944) ─────────────────────────────────────────────
//
// `/api/v1/starter-prompts` accepts the same demo bearer that `/api/v1/demo/*`
// uses. With a valid demo bearer, the resolver runs with `orgId = null`, mode
// `published`, and the SQL `pc.org_id IS NULL OR pc.org_id = $2` keeps reads
// scoped to the global `__demo__` cohort prompts. Standard session / API-key
// paths must be unaffected.
describe("GET /api/v1/starter-prompts — demo bearer auth", () => {
  function demoReq(
    token: string,
    extraHeaders: Record<string, string> = {},
    path = "/api/v1/starter-prompts",
  ) {
    return app.fetch(
      new Request(`http://localhost${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
      }),
    );
  }

  it("returns 200 with the __demo__ cohort's published prompts for a valid demo bearer", async () => {
    // Standard auth path is broken in this test — only demo bearer should let us in.
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );

    demoIndustryFixture = "cybersecurity";
    mocks.mockInternalQuery.mockImplementation(async () => [
      { id: "demo-1", question: "Which alerts had the highest severity in the last 7 days?" },
      { id: "demo-2", question: "Show me failed login events grouped by user this week." },
    ]);

    const signed = signDemoToken("demo-200@example.com");
    expect(signed).not.toBeNull();

    // The `x-atlas-mode: developer` header would normally let an admin opt
    // into the draft overlay. Demo callers must NOT — assert the SQL still
    // filters to `published` only.
    const res = await demoReq(signed!.token, { "x-atlas-mode": "developer" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts: Array<{ id: string; text: string; provenance: string }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.prompts).toEqual([
      { id: "library:demo-1", text: "Which alerts had the highest severity in the last 7 days?", provenance: "library" },
      { id: "library:demo-2", text: "Show me failed login events grouped by user this week.", provenance: "library" },
    ]);

    // Bright-line guard: the demo path must NOT silently delegate to
    // standardAuth. If a future regression flips the order, this assertion
    // catches it before the wire contract changes.
    expect(mocks.mockAuthenticateRequest).not.toHaveBeenCalled();

    // Demo bearer queries scope library to global builtin prompts —
    // pc.org_id IS NULL OR pc.org_id = NULL collapses to the IS NULL branch —
    // and stay in published mode regardless of the developer header.
    const sqlCalls = mocks.mockInternalQuery.mock.calls;
    expect(sqlCalls.length).toBeGreaterThan(0);
    const [sql, params] = sqlCalls[0]!;
    expect(params![1]).toBeNull();
    expect(sql).toContain("pc.status = 'published'");
    expect(sql).not.toContain("'draft'");
  });

  it("returns 401 when the demo bearer is malformed and standard auth also fails", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );

    const res = await demoReq("not-a-real-token");

    expect(res.status).toBe(401);
  });

  it("returns 401 when the demo bearer is signature-tampered and standard auth also fails", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );

    const signed = signDemoToken("demo-tampered@example.com");
    expect(signed).not.toBeNull();
    const tampered = signed!.token.slice(0, -4) + "AAAA";

    const res = await demoReq(tampered);

    expect(res.status).toBe(401);
  });

  it("returns 429 with Retry-After when the demo per-email rate limit is exceeded", async () => {
    // Saturate the limiter — default RPM is 10 (ATLAS_DEMO_RATE_LIMIT_RPM).
    // Use a unique email so this test can't see budget consumed elsewhere.
    const email = "demo-ratelimit@example.com";
    const signed = signDemoToken(email);
    expect(signed).not.toBeNull();

    const limit = 10;
    for (let i = 0; i < limit; i++) {
      const ok = await demoReq(signed!.token);
      expect(ok.status).toBe(200);
    }

    const blocked = await demoReq(signed!.token);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const body = (await blocked.json()) as { error: string; requestId: string };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.requestId).toBe("string");
  });

  it("falls through to standardAuth when BETTER_AUTH_SECRET is unset (no 500)", async () => {
    // Misconfigured self-hosted deploys: verifyDemoToken returns null, the
    // middleware must NOT throw. Standard auth (mocked here as success) takes
    // the request the rest of the way.
    delete process.env.BETTER_AUTH_SECRET;
    try {
      // Any bearer string — verification fails before any HMAC check.
      const res = await demoReq("anything-since-no-secret");
      expect(res.status).toBe(200);
      // Standard auth ran — exact opposite of the happy-path 200 test.
      expect(mocks.mockAuthenticateRequest).toHaveBeenCalled();
    } finally {
      process.env.BETTER_AUTH_SECRET = DEMO_TEST_SECRET;
    }
  });

  // Favorites endpoints stay on standardAuth — a demo bearer must not let a
  // demo caller pin into a non-existent workspace. Three small guard tests
  // so that mounting `demoOrStandardAuth` at `*` in a future refactor would
  // turn red here before shipping.
  describe("favorites endpoints reject demo bearers", () => {
    function demoFavReq(
      method: "POST" | "DELETE" | "PATCH",
      path: string,
      token: string,
      body?: unknown,
    ) {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      return app.fetch(new Request(`http://localhost${path}`, init));
    }

    it("rejects POST /favorites with 401", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
      );
      const signed = signDemoToken("demo-fav-post@example.com");
      const res = await demoFavReq("POST", "/api/v1/starter-prompts/favorites", signed!.token, {
        text: "should be rejected",
      });
      expect(res.status).toBe(401);
      expect(mockCreateFavorite).not.toHaveBeenCalled();
    });

    it("rejects DELETE /favorites/:id with 401", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
      );
      const signed = signDemoToken("demo-fav-delete@example.com");
      const res = await demoFavReq("DELETE", "/api/v1/starter-prompts/favorites/fav-x", signed!.token);
      expect(res.status).toBe(401);
      expect(mockDeleteFavorite).not.toHaveBeenCalled();
    });

    it("rejects PATCH /favorites/:id with 401", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
      );
      const signed = signDemoToken("demo-fav-patch@example.com");
      const res = await demoFavReq("PATCH", "/api/v1/starter-prompts/favorites/fav-x", signed!.token, {
        position: 2,
      });
      expect(res.status).toBe(401);
      expect(mockUpdateFavoritePosition).not.toHaveBeenCalled();
    });
  });
});

// ── Favorites endpoints ─────────────────────────────────────────────────

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

  it("returns 400 'invalid_favorite_text' when the store throws InvalidFavoriteTextError", async () => {
    mockCreateFavorite.mockImplementation(async () => {
      throw new InvalidFavoriteTextError("Pin text must not be empty");
    });

    const res = await jsonReq("POST", "/api/v1/starter-prompts/favorites", {
      text: "will-throw-from-store",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_favorite_text");
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
