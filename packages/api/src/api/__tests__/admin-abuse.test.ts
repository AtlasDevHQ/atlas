/**
 * Tests for admin abuse prevention API endpoints.
 *
 * Covers: GET /admin/abuse, POST /admin/abuse/:id/reinstate, GET /admin/abuse/config.
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

// --- Unified mocks ---

const mocks = createApiTestMocks();

// --- Abuse mock overrides (test-specific) ---

const mockListFlagged: Mock<() => unknown[]> = mock(() => []);
const mockReinstateWorkspace: Mock<(wsId: string, actorId: string) => boolean> = mock(() => true);
const mockGetAbuseEvents: Mock<(wsId: string, limit?: number) => Promise<unknown[]>> = mock(async () => []);
const mockGetAbuseConfig: Mock<() => unknown> = mock(() => ({
  queryRateLimit: 200,
  queryRateWindowSeconds: 300,
  errorRateThreshold: 0.5,
  uniqueTablesLimit: 50,
  throttleDelayMs: 2000,
}));
const mockGetAbuseDetail: Mock<(wsId: string) => Promise<unknown | null>> = mock(async () => null);

mock.module("@atlas/api/lib/security/abuse", () => ({
  listFlaggedWorkspaces: mockListFlagged,
  reinstateWorkspace: mockReinstateWorkspace,
  getAbuseEvents: mockGetAbuseEvents,
  getAbuseConfig: mockGetAbuseConfig,
  getAbuseDetail: mockGetAbuseDetail,
  checkAbuseStatus: mock(() => ({ level: "none" })),
  recordQueryEvent: mock(() => {}),
  restoreAbuseState: mock(async () => {}),
  _resetAbuseState: mock(() => {}),
  abuseCleanupTick: mock(() => {}),
  ABUSE_CLEANUP_INTERVAL_MS: 300_000,
}));

// --- Import app after mocks ---

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// --- Helper ---

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

// --- Tests ---

describe("Admin Abuse API", () => {
  beforeEach(() => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
    mockListFlagged.mockImplementation(() => []);
    mockReinstateWorkspace.mockImplementation(() => true);
    mockGetAbuseEvents.mockImplementation(async () => []);
  });

  // --- GET /api/v1/admin/abuse ---

  describe("GET /api/v1/admin/abuse", () => {
    it("returns empty list when no workspaces flagged", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.workspaces).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns flagged workspaces", async () => {
      mockListFlagged.mockImplementation(() => [
        {
          workspaceId: "org-1",
          workspaceName: null,
          level: "warning",
          trigger: "query_rate",
          message: "Excessive queries",
          updatedAt: "2026-03-23T00:00:00.000Z",
          events: [],
        },
      ]);
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect((body.workspaces as unknown[]).length).toBe(1);
      expect(body.total).toBe(1);
    });

    it("returns 403 for non-admin", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse"));
      expect(res.status).toBe(403);
    });
  });

  // --- POST /api/v1/admin/abuse/:id/reinstate ---

  describe("POST /api/v1/admin/abuse/:id/reinstate", () => {
    it("reinstates a flagged workspace", async () => {
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.workspaceId).toBe("org-1");
    });

    it("returns 400 when workspace not flagged", async () => {
      mockReinstateWorkspace.mockImplementation(() => false);
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-clean/reinstate"),
      );
      expect(res.status).toBe(400);
    });

    it("returns 403 for non-admin", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
      );
      expect(res.status).toBe(403);
    });
  });

  // --- GET /api/v1/admin/abuse/:id/detail ---

  describe("GET /api/v1/admin/abuse/:id/detail", () => {
    it("returns detail for a flagged workspace", async () => {
      mockGetAbuseDetail.mockImplementation(async () => ({
        workspaceId: "org-1",
        workspaceName: null,
        level: "warning",
        trigger: "query_rate",
        message: "Excessive queries",
        updatedAt: "2026-03-23T00:00:00.000Z",
        counters: {
          queryCount: 250,
          errorCount: 0,
          errorRatePct: 0,
          uniqueTablesAccessed: 3,
          escalations: 1,
        },
        thresholds: {
          queryRateLimit: 200,
          queryRateWindowSeconds: 300,
          errorRateThreshold: 0.5,
          uniqueTablesLimit: 50,
          throttleDelayMs: 2000,
        },
        currentInstance: {
          startedAt: "2026-03-23T00:00:00.000Z",
          endedAt: null,
          peakLevel: "warning",
          events: [],
        },
        priorInstances: [],
      }));
      const res = await app.fetch(
        adminRequest("GET", "/api/v1/admin/abuse/org-1/detail"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.workspaceId).toBe("org-1");
      expect((body.counters as Record<string, unknown>).queryCount).toBe(250);
    });

    it("returns 404 when workspace is not flagged", async () => {
      mockGetAbuseDetail.mockImplementation(async () => null);
      const res = await app.fetch(
        adminRequest("GET", "/api/v1/admin/abuse/org-clean/detail"),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("not_flagged");
      // 4xx responses must carry requestId for log correlation.
      expect(typeof body.requestId).toBe("string");
    });

    it("returns 403 for non-admin", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await app.fetch(
        adminRequest("GET", "/api/v1/admin/abuse/org-1/detail"),
      );
      expect(res.status).toBe(403);
    });
  });

  // --- GET /api/v1/admin/abuse/config ---

  describe("GET /api/v1/admin/abuse/config", () => {
    it("returns current threshold configuration", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse/config"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.queryRateLimit).toBe(200);
      expect(body.queryRateWindowSeconds).toBe(300);
      expect(body.errorRateThreshold).toBe(0.5);
      expect(body.uniqueTablesLimit).toBe(50);
      expect(body.throttleDelayMs).toBe(2000);
    });

    it("returns 403 for non-admin", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse/config"));
      expect(res.status).toBe(403);
    });
  });
});
