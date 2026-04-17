/**
 * Tests for user-facing suggestion API routes.
 *
 * Tests: GET /suggestions?table=..., GET /suggestions/popular,
 *        POST /suggestions/:id/click.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Test-specific mocks for suggestion DB helpers ---

const mockGetSuggestionsByTables: Mock<() => Promise<unknown[]>> = mock(() => Promise.resolve([]));
const mockGetPopularSuggestions: Mock<() => Promise<unknown[]>> = mock(() => Promise.resolve([]));
const mockIncrementSuggestionClick: Mock<() => void> = mock(() => {});

// --- Unified mocks ---

const mocks = createApiTestMocks({
  authUser: {
    id: "user-1",
    mode: "simple-key",
    label: "User",
    role: "member",
    activeOrganizationId: "org-1",
  },
  authMode: "simple-key",
  internal: {
    getSuggestionsByTables: mockGetSuggestionsByTables,
    getPopularSuggestions: mockGetPopularSuggestions,
    incrementSuggestionClick: mockIncrementSuggestionClick,
    upsertSuggestion: mock(async () => "skipped"),
  },
});

// --- Import the app AFTER mocks ---

const { app } = await import("../index");

// --- Helpers ---

function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/suggestions${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

function mockSuggestionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sug-1",
    org_id: "org-1",
    description: "Count orders by status",
    pattern_sql: "SELECT status, COUNT(*) FROM orders GROUP BY status",
    normalized_hash: "abc123",
    tables_involved: JSON.stringify(["orders"]),
    primary_table: "orders",
    frequency: 10,
    clicked_count: 3,
    score: 8.5,
    last_seen_at: "2026-03-18T00:00:00Z",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-18T00:00:00Z",
    ...overrides,
  };
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

// --- Reset mocks between tests ---

beforeEach(() => {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
    }),
  );
  mocks.hasInternalDB = true;
  mockGetSuggestionsByTables.mockReset();
  mockGetSuggestionsByTables.mockImplementation(() => Promise.resolve([]));
  mockGetPopularSuggestions.mockReset();
  mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
  mockIncrementSuggestionClick.mockReset();
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("suggestions routes", () => {
  // ─── Auth gating ──────────────────────────────────────────────────

  describe("auth gating", () => {
    it("returns 401 for unauthenticated", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid token",
          status: 401,
        }),
      );
      const res = await req("GET", "/?table=orders");
      expect(res.status).toBe(401);
    });
  });

  // ─── Rate limiting ────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("returns 429 when rate limited on GET /", async () => {
      mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: false, retryAfterMs: 60000 }));
      const res = await req("GET", "/?table=orders");
      expect(res.status).toBe(429);
    });

    it("returns 429 when rate limited on GET /popular", async () => {
      mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: false, retryAfterMs: 60000 }));
      const res = await req("GET", "/popular");
      expect(res.status).toBe(429);
    });
  });

  // ─── No internal DB ───────────────────────────────────────────────

  describe("no internal DB", () => {
    it("returns empty list when no internal DB on GET /", async () => {
      mocks.hasInternalDB = false;
      const res = await req("GET", "/?table=orders");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.suggestions).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns empty list when no internal DB on GET /popular", async () => {
      mocks.hasInternalDB = false;
      const res = await req("GET", "/popular");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.suggestions).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ─── GET / ────────────────────────────────────────────────────────

  describe("GET /?table=orders", () => {
    it("returns matching suggestions, 200", async () => {
      mockGetSuggestionsByTables.mockImplementation(() =>
        Promise.resolve([mockSuggestionRow(), mockSuggestionRow({ id: "sug-2" })]),
      );

      const res = await req("GET", "/?table=orders");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.suggestions).toBeArray();
      expect(body.total).toBe(2);
      // Verify camelCased shape
      expect(body.suggestions[0].id).toBe("sug-1");
      expect(body.suggestions[0].description).toBe("Count orders by status");
      expect(body.suggestions[0].patternSql).toBe("SELECT status, COUNT(*) FROM orders GROUP BY status");
      expect(body.suggestions[0].normalizedHash).toBe("abc123");
      expect(body.suggestions[0].tablesInvolved).toEqual(["orders"]);
      expect(body.suggestions[0].primaryTable).toBe("orders");
      expect(body.suggestions[0].frequency).toBe(10);
      expect(body.suggestions[0].clickedCount).toBe(3);
      expect(body.suggestions[0].score).toBe(8.5);
    });

    it("returns 400 when no table param", async () => {
      const res = await req("GET", "/");
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toContain("table");
    });

    it("supports multiple table params", async () => {
      mockGetSuggestionsByTables.mockImplementation(() => Promise.resolve([]));
      const res = await req("GET", "/?table=orders&table=products");
      expect(res.status).toBe(200);
      expect(mockGetSuggestionsByTables.mock.calls.length).toBe(1);
      const callArgs = mockGetSuggestionsByTables.mock.calls[0] as unknown[];
      expect(callArgs[1]).toEqual(["orders", "products"]);
    });

    it("caps limit at 50", async () => {
      mockGetSuggestionsByTables.mockImplementation(() => Promise.resolve([]));
      const res = await req("GET", "/?table=orders&limit=999");
      expect(res.status).toBe(200);
      const callArgs = mockGetSuggestionsByTables.mock.calls[0] as unknown[];
      expect(callArgs[2]).toBe(50);
    });

    it("passes orgId from session", async () => {
      mockGetSuggestionsByTables.mockImplementation(() => Promise.resolve([]));
      await req("GET", "/?table=orders");
      const callArgs = mockGetSuggestionsByTables.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe("org-1");
    });
  });

  // ─── GET /popular ─────────────────────────────────────────────────

  describe("GET /popular", () => {
    it("returns suggestions, 200", async () => {
      mockGetPopularSuggestions.mockImplementation(() =>
        Promise.resolve([mockSuggestionRow(), mockSuggestionRow({ id: "sug-2", score: 5.0 })]),
      );

      const res = await req("GET", "/popular");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.suggestions).toBeArray();
      expect(body.total).toBe(2);
      expect(body.suggestions[0].id).toBe("sug-1");
    });

    it("caps limit at 50", async () => {
      mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
      const res = await req("GET", "/popular?limit=100");
      expect(res.status).toBe(200);
      const callArgs = mockGetPopularSuggestions.mock.calls[0] as unknown[];
      expect(callArgs[1]).toBe(50);
    });

    it("passes orgId from session", async () => {
      mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
      await req("GET", "/popular");
      const callArgs = mockGetPopularSuggestions.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe("org-1");
    });

    // ─── Mode participation (#1478) ────────────────────────────────
    //
    // The default member-role mock always resolves to `published` mode
    // regardless of cookie/header — resolveMode() downgrades non-admin
    // callers. The admin-mode branch is covered end-to-end via the
    // admin-starter-prompts tests; here we assert that a non-admin
    // caller never sees draft rows leak into /popular.

    it("passes mode='published' to the store for a member caller (even with dev-mode cookie)", async () => {
      mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
      const res = await app.fetch(
        new Request("http://localhost/api/v1/suggestions/popular", {
          method: "GET",
          headers: {
            Authorization: "Bearer test",
            Cookie: "atlas-mode=developer",
          },
        }),
      );
      expect(res.status).toBe(200);
      const callArgs = mockGetPopularSuggestions.mock.calls[0] as unknown[];
      // Third arg is the resolved atlasMode; member role was downgraded.
      expect(callArgs[2]).toBe("published");
    });

    it("passes mode='developer' to the store when an admin caller sets the cookie", async () => {
      mocks.setOrgAdmin("org-1");
      mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
      const res = await app.fetch(
        new Request("http://localhost/api/v1/suggestions/popular", {
          method: "GET",
          headers: {
            Authorization: "Bearer test",
            Cookie: "atlas-mode=developer",
          },
        }),
      );
      expect(res.status).toBe(200);
      const callArgs = mockGetPopularSuggestions.mock.calls[0] as unknown[];
      expect(callArgs[2]).toBe("developer");
    });
  });

  // ─── POST /:id/click ──────────────────────────────────────────────

  describe("POST /:id/click", () => {
    it("returns 204", async () => {
      const res = await req("POST", "/sug-1/click");
      expect(res.status).toBe(204);
    });

    it("calls incrementSuggestionClick with id and orgId", async () => {
      await req("POST", "/sug-42/click");
      expect(mockIncrementSuggestionClick.mock.calls.length).toBe(1);
      const callArgs = mockIncrementSuggestionClick.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe("sug-42");
      expect(callArgs[1]).toBe("org-1");
    });

    it("returns 204 even if incrementSuggestionClick throws", async () => {
      mockIncrementSuggestionClick.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await req("POST", "/sug-1/click");
      expect(res.status).toBe(204);
    });

    it("returns 401 for unauthenticated", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid token",
          status: 401,
        }),
      );
      const res = await req("POST", "/sug-1/click");
      expect(res.status).toBe(401);
    });
  });

  // ─── Org-scoping (null org) ────────────────────────────────────────

  describe("org-scoping", () => {
    it("passes null orgId when user has no activeOrganizationId", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
        }),
      );
      mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
      await req("GET", "/popular");
      const callArgs = mockGetPopularSuggestions.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBeNull();
    });
  });
});
