/**
 * Tests for admin cache management routes.
 *
 * The cache router is mounted under /api/v1/admin/cache via admin.route()
 * and uses createPlatformRouter() — only platform_admin role has access.
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

function setRegularAdmin(): void {
  mocks.setOrgAdmin("org-test");
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
    it("returns 403 for regular admin (non-platform_admin)", async () => {
      setRegularAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
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
    it("returns 403 for regular admin (non-platform_admin)", async () => {
      setRegularAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
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
