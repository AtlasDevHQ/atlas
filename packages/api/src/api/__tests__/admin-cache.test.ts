/**
 * Tests for admin cache management routes.
 *
 * The cache router is mounted under /api/v1/admin/cache via admin.route()
 * and uses createAdminRouter() — admin/owner/platform_admin roles all have
 * access; regular members get 403 (#2167).
 *
 * Endpoints:
 * - GET  /cache/stats  — cache statistics
 * - POST /cache/flush  — flush entire cache
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

// --- Unified mocks ---

let mockCacheEnabled = true;
const mockCacheStats = mock(() => ({ hits: 42, misses: 8, entryCount: 15, maxSize: 1000, ttl: 300000 }));
const mockFlushCache = mock(() => {});
const mockGetCache = mock(() => ({
  get: () => null,
  set: () => {},
  delete: () => false,
  flush: () => {},
  stats: mockCacheStats,
}));

const mocks = createApiTestMocks({
  authUser: {
    id: "platform-admin-1",
    mode: "managed",
    label: "platform@test.com",
    role: "platform_admin",
    activeOrganizationId: "org-test",
  },
  authMode: "managed",
});

// Override cache with test-specific mocks
const cacheMockFactory = () => ({
  getCache: mockGetCache,
  cacheEnabled: () => mockCacheEnabled,
  setCacheBackend: mock(() => {}),
  flushCache: mockFlushCache,
  getDefaultTtl: mock(() => 300000),
  _resetCache: mock(() => {}),
  buildCacheKey: mock(() => "mock-key"),
});

mock.module("@atlas/api/lib/cache", cacheMockFactory);
mock.module("@atlas/api/lib/cache/index", cacheMockFactory);

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helpers ---

function setPlatformAdmin(): void {
  mocks.setPlatformAdmin();
}

function setOrgAdmin(): void {
  mocks.setOrgAdmin("org-test");
}

function setMember(): void {
  mocks.setMember("org-test");
}

/**
 * Org owner — user-level role "owner" is admitted by `adminAuth` alongside
 * admin/platform_admin. Factory has no `setOwner` helper, so override
 * `mockAuthenticateRequest` directly. `twoFactorEnabled: true` keeps the
 * F-MFA gate happy.
 */
function setOrgOwner(): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "owner-1",
        mode: "managed",
        label: "owner@test.com",
        role: "owner",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: true },
      },
    }),
  );
}

/**
 * Org admin without an enrolled second factor — exercises the
 * `mfaRequired` gate that `createAdminRouter()` wires in front of every
 * admin route. The wider role gate from #2167 means more users hit this
 * path; locking the contract in place here prevents a future regression
 * that drops the gate from silently exposing flush to unenrolled admins.
 */
function setOrgAdminNoMfa(): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-no-mfa-1",
        mode: "managed",
        label: "admin@test.com",
        role: "admin",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: false },
      },
    }),
  );
}

function cacheRequest(urlPath: string, method: "GET" | "POST" = "GET"): Request {
  return new Request(`http://localhost${urlPath}`, {
    method,
    headers: { Authorization: "Bearer test-key" },
  });
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

// --- Tests ---

describe("admin cache routes", () => {
  beforeEach(() => {
    mockCacheEnabled = true;
    mockCacheStats.mockClear();
    mockFlushCache.mockClear();
    mockGetCache.mockImplementation(() => ({
      get: () => null,
      set: () => {},
      delete: () => false,
      flush: () => {},
      stats: mockCacheStats,
    }));
    setPlatformAdmin();
  });

  describe("GET /cache/stats", () => {
    it("returns 403 for non-admin members (#2167 — admin gate, not member)", async () => {
      setMember();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
    });

    it("returns 200 for org admin (#2167 — was 403 under platform-only gate)", async () => {
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(true);
      expect(body.hits).toBe(42);
    });

    it("returns 200 for org owner (#2167 — adminAuth admit-list includes owner)", async () => {
      setOrgOwner();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(true);
    });

    it("returns 403 mfa_enrollment_required when admin has no second factor", async () => {
      setOrgAdminNoMfa();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("mfa_enrollment_required");
    });

    it("returns cache stats with correct shape for platform admin", async () => {
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(true);
      expect(body.hits).toBe(42);
      expect(body.misses).toBe(8);
      // hitRate should be 42/(42+8) = 0.84
      expect(body.hitRate).toBeCloseTo(0.84, 2);
      // missRate should be 8/(42+8) = 0.16
      expect(body.missRate).toBeCloseTo(0.16, 2);
      expect(body.entryCount).toBe(15);
    });

    it("returns hitRate/missRate of 0 when cache is enabled but empty", async () => {
      mockCacheStats.mockReturnValueOnce({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 });
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(true);
      expect(body.hitRate).toBe(0);
      expect(body.missRate).toBe(0);
    });

    it("returns fallback response when cache is disabled", async () => {
      mockCacheEnabled = false;
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(false);
      expect(body.hits).toBe(0);
      expect(body.misses).toBe(0);
      expect(body.hitRate).toBe(0);
      expect(body.missRate).toBe(0);
      expect(body.entryCount).toBe(0);
    });

    it("returns 500 with requestId when stats() throws", async () => {
      mockGetCache.mockImplementation(() => ({
        get: () => null,
        set: () => {},
        delete: () => false,
        flush: () => {},
        stats: (() => { throw new Error("Redis connection refused"); }) as unknown as typeof mockCacheStats,
      }));
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
    });
  });

  describe("POST /cache/flush", () => {
    it("returns 403 for non-admin members (#2167 — admin gate, not member)", async () => {
      setMember();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
    });

    it("flushes cache successfully for org admin (#2167 — was 403 under platform-only gate)", async () => {
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.flushed).toBe(15);
      expect(mockFlushCache).toHaveBeenCalledTimes(1);
    });

    it("flushes cache successfully for org owner (#2167 — adminAuth admit-list includes owner)", async () => {
      setOrgOwner();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(mockFlushCache).toHaveBeenCalledTimes(1);
    });

    it("returns 403 mfa_enrollment_required when admin has no second factor", async () => {
      setOrgAdminNoMfa();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("mfa_enrollment_required");
      expect(mockFlushCache).not.toHaveBeenCalled();
    });

    it("flushes cache successfully for platform admin", async () => {
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.flushed).toBe(15);
      expect(body.message).toBe("Cache flushed");
      expect(mockFlushCache).toHaveBeenCalledTimes(1);
    });

    it("returns disabled response when cache is off", async () => {
      mockCacheEnabled = false;
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.flushed).toBe(0);
      expect(body.message).toBe("Cache is disabled");
      expect(mockFlushCache).not.toHaveBeenCalled();
    });

    it("returns 500 with requestId when flush throws", async () => {
      mockFlushCache.mockImplementation(() => { throw new Error("Redis flush failed"); });
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
    });
  });
});
