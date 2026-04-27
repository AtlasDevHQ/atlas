/**
 * Tests for admin token usage API routes.
 *
 * Mocks everything needed by the Hono app to test the three token endpoints:
 * /tokens/summary, /tokens/by-user, /tokens/trends.
 *
 * All endpoints are org-scoped: queries filter on token_usage.org_id matching
 * the caller's active organization.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks ---

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-test",
  },
  authMode: "managed",
});

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helpers ---

function adminRequest(urlPath: string): Request {
  return new Request(`http://localhost${urlPath}`, {
    method: "GET",
    headers: { Authorization: "Bearer test-key" },
  });
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

// --- Tests ---

describe("admin token usage routes", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.setOrgAdmin("org-test");
  });

  describe("GET /tokens/summary", () => {
    it("returns token summary with org_id filter", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { total_prompt: "15000", total_completion: "5000", total_requests: "10" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.totalPromptTokens).toBe(15000);
      expect(body.totalCompletionTokens).toBe(5000);
      expect(body.totalTokens).toBe(20000);
      expect(body.totalRequests).toBe(10);

      // Verify org-scoping: SQL must include org_id filter and pass orgId as param
      const lastCall = mocks.mockInternalQuery.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const [sql, params] = lastCall!;
      expect(sql).toContain("org_id");
      expect(params).toContain("org-test");
    });

    it("returns 404 when no internal DB", async () => {
      mocks.hasInternalDB = false;
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(404);
    });

    it("returns 403 for non-admin", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "managed",
          user: { id: "user-1", mode: "managed", label: "User", role: "member", activeOrganizationId: "org-test" },
        }),
      );
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(403);
    });

    it("accepts date range parameters", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([{ total_prompt: "0", total_completion: "0", total_requests: "0" }]);
      });
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary?from=2026-01-01&to=2026-03-01"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.from).toBe("2026-01-01");
      expect(body.to).toBe("2026-03-01");
    });

    it("returns 400 for invalid date format", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary?from=not-a-date"));
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.error).toBe("invalid_request");
      expect(body.requestId).toBeDefined();
    });

    it("returns 500 when DB query fails", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.reject(new Error("connection refused"));
      });
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(500);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
    });

    it("returns 400 when no active organization", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "managed",
          user: {
            id: "admin-1",
            mode: "managed",
            label: "Admin",
            role: "admin",
            claims: { twoFactorEnabled: true },
          },
        }),
      );
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.error).toBe("bad_request");
    });
  });

  describe("GET /tokens/by-user", () => {
    it("returns user token breakdown with org_id filter", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          {
            user_id: "user-1",
            total_prompt: "8000",
            total_completion: "3000",
            total_tokens: "11000",
            request_count: "5",
          },
          {
            user_id: "user-2",
            total_prompt: "4000",
            total_completion: "1500",
            total_tokens: "5500",
            request_count: "3",
          },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/by-user"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.users).toHaveLength(2);
      expect(body.users[0].userId).toBe("user-1");
      expect(body.users[0].totalTokens).toBe(11000);
      expect(body.users[1].requestCount).toBe(3);

      // Verify org-scoping
      const lastCall = mocks.mockInternalQuery.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const [sql, params] = lastCall!;
      expect(sql).toContain("org_id");
      expect(params).toContain("org-test");
    });

    it("returns 404 when no internal DB", async () => {
      mocks.hasInternalDB = false;
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/by-user"));
      expect(res.status).toBe(404);
    });
  });

  describe("GET /tokens/trends", () => {
    it("returns daily trends with org_id filter", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { day: "2026-03-08", prompt_tokens: "5000", completion_tokens: "2000", request_count: "3" },
          { day: "2026-03-09", prompt_tokens: "7000", completion_tokens: "3000", request_count: "5" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/trends"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.trends).toHaveLength(2);
      expect(body.trends[0].day).toBe("2026-03-08");
      expect(body.trends[0].promptTokens).toBe(5000);
      expect(body.trends[0].totalTokens).toBe(7000);
      expect(body.trends[1].requestCount).toBe(5);

      // Verify org-scoping
      const lastCall = mocks.mockInternalQuery.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const [sql, params] = lastCall!;
      expect(sql).toContain("org_id");
      expect(params).toContain("org-test");
    });

    it("returns 404 when no internal DB", async () => {
      mocks.hasInternalDB = false;
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/trends"));
      expect(res.status).toBe(404);
    });

    it("returns empty array when no data", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/trends"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.trends).toEqual([]);
    });
  });
});
