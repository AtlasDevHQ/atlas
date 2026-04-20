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
import type { AbuseDetail } from "@useatlas/types";
import { createAbuseInstance } from "@atlas/api/lib/security/abuse-instances";

// --- Unified mocks ---

const mockGetWorkspaceNamesByIds: Mock<(ids: string[]) => Promise<Map<string, string | null>>> =
  mock(async (ids) => {
    const m = new Map<string, string | null>();
    for (const id of ids) m.set(id, null);
    return m;
  });

const mocks = createApiTestMocks({
  internal: {
    getWorkspaceNamesByIds: mockGetWorkspaceNamesByIds,
  },
});

// --- Abuse mock overrides (test-specific) ---

const mockListFlagged: Mock<() => unknown[]> = mock(() => []);
const mockReinstateWorkspace: Mock<(wsId: string, actorId: string) => boolean> = mock(() => true);
const mockGetAbuseEvents: Mock<
  (wsId: string, limit?: number) => Promise<{ events: unknown[]; status: string }>
> = mock(async () => ({ events: [], status: "ok" }));
const mockGetAbuseConfig: Mock<() => unknown> = mock(() => ({
  queryRateLimit: 200,
  queryRateWindowSeconds: 300,
  errorRateThreshold: 0.5,
  uniqueTablesLimit: 50,
  throttleDelayMs: 2000,
}));
// Typed `AbuseDetail | null` so hand-rolling the nested `AbuseInstance`
// shape inline fails typecheck (#1684). Fixtures that want a current or
// prior instance must go through `createAbuseInstance`.
const mockGetAbuseDetail: Mock<(wsId: string) => Promise<AbuseDetail | null>> = mock(async () => null);

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
    mockGetAbuseEvents.mockImplementation(async () => ({ events: [], status: "ok" }));
    mockGetWorkspaceNamesByIds.mockClear();
    mockGetWorkspaceNamesByIds.mockImplementation(async (ids) => {
      const m = new Map<string, string | null>();
      for (const id of ids) m.set(id, null);
      return m;
    });
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

    it("resolves workspaceName from the internal DB (#1640)", async () => {
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
        {
          workspaceId: "org-2",
          workspaceName: null,
          level: "throttled",
          trigger: "query_rate",
          message: "Still too many",
          updatedAt: "2026-03-23T00:01:00.000Z",
          events: [],
        },
      ]);
      mockGetWorkspaceNamesByIds.mockImplementation(async (ids) => {
        const m = new Map<string, string | null>();
        // Return a name for org-1 and a missing/null for org-2 so we assert both branches.
        for (const id of ids) m.set(id, id === "org-1" ? "Acme Corp" : null);
        return m;
      });
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse"));
      expect(res.status).toBe(200);
      const body = await res.json() as { workspaces: Array<{ workspaceId: string; workspaceName: string | null }> };
      expect(mockGetWorkspaceNamesByIds).toHaveBeenCalledTimes(1);
      expect(mockGetWorkspaceNamesByIds.mock.calls[0]?.[0]).toEqual(["org-1", "org-2"]);
      const byId = Object.fromEntries(body.workspaces.map((w) => [w.workspaceId, w.workspaceName]));
      expect(byId).toEqual({ "org-1": "Acme Corp", "org-2": null });
      // Admin table expects most-recent-first ordering from listFlaggedWorkspaces.
      // Enrichment must preserve input order — a refactor that traversed
      // Map.keys() on names instead of workspaces would scramble this silently.
      expect(body.workspaces.map((w) => w.workspaceId)).toEqual(["org-1", "org-2"]);
    });

    it("falls back to null when name resolution rejects (#1640)", async () => {
      mockListFlagged.mockImplementation(() => [
        {
          workspaceId: "org-1",
          workspaceName: null,
          level: "warning",
          trigger: "query_rate",
          message: "boom",
          updatedAt: "2026-03-23T00:00:00.000Z",
          events: [],
        },
      ]);
      mockGetWorkspaceNamesByIds.mockImplementation(async () => {
        throw new Error("internal DB unreachable");
      });
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse"));
      // Must still 200 — name resolution is advisory. The page renders the
      // opaque id rather than 500'ing the admin.
      expect(res.status).toBe(200);
      const body = await res.json() as { workspaces: Array<{ workspaceId: string; workspaceName: string | null }> };
      expect(body.workspaces[0]?.workspaceName).toBeNull();
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
        currentInstance: createAbuseInstance([]),
        priorInstances: [],
        eventsStatus: "ok",
      }));
      const res = await app.fetch(
        adminRequest("GET", "/api/v1/admin/abuse/org-1/detail"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.workspaceId).toBe("org-1");
      expect((body.counters as Record<string, unknown>).queryCount).toBe(250);
      expect(body.eventsStatus).toBe("ok");
    });

    it("detail route falls back to null workspaceName when resolution rejects (#1640)", async () => {
      mockGetAbuseDetail.mockImplementation(async () => ({
        workspaceId: "org-1",
        workspaceName: null,
        level: "warning",
        trigger: "query_rate",
        message: "boom",
        updatedAt: "2026-03-23T00:00:00.000Z",
        counters: { queryCount: 1, errorCount: 0, errorRatePct: null, uniqueTablesAccessed: 0, escalations: 0 },
        thresholds: { queryRateLimit: 200, queryRateWindowSeconds: 300, errorRateThreshold: 0.5, uniqueTablesLimit: 50, throttleDelayMs: 2000 },
        currentInstance: createAbuseInstance([]),
        priorInstances: [],
        eventsStatus: "ok",
      }));
      mockGetWorkspaceNamesByIds.mockImplementation(async () => {
        throw new Error("internal DB unreachable");
      });
      const res = await app.fetch(
        adminRequest("GET", "/api/v1/admin/abuse/org-1/detail"),
      );
      // Must still 200 — name resolution is advisory for the detail panel
      // just as it is for the list (regression guard for #1640 follow-up).
      expect(res.status).toBe(200);
      const body = await res.json() as { workspaceName: string | null };
      expect(body.workspaceName).toBeNull();
    });

    it("resolves workspaceName on the detail route (#1640)", async () => {
      mockGetAbuseDetail.mockImplementation(async () => ({
        workspaceId: "org-1",
        workspaceName: null,
        level: "warning",
        trigger: "query_rate",
        message: "Excessive queries",
        updatedAt: "2026-03-23T00:00:00.000Z",
        counters: {
          queryCount: 1,
          errorCount: 0,
          errorRatePct: null,
          uniqueTablesAccessed: 0,
          escalations: 0,
        },
        thresholds: {
          queryRateLimit: 200,
          queryRateWindowSeconds: 300,
          errorRateThreshold: 0.5,
          uniqueTablesLimit: 50,
          throttleDelayMs: 2000,
        },
        currentInstance: createAbuseInstance([]),
        priorInstances: [],
        eventsStatus: "ok",
      }));
      mockGetWorkspaceNamesByIds.mockImplementation(async (ids) => {
        const m = new Map<string, string | null>();
        for (const id of ids) m.set(id, "Acme Corp");
        return m;
      });
      const res = await app.fetch(
        adminRequest("GET", "/api/v1/admin/abuse/org-1/detail"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { workspaceName: string | null; workspaceId: string };
      expect(body.workspaceName).toBe("Acme Corp");
      expect(body.workspaceId).toBe("org-1");
    });

    it("propagates eventsStatus='load_failed' through the detail route (#1682)", async () => {
      // The diagnostic channel must reach the wire so the UI can render a
      // destructive banner instead of the benign empty-history copy when
      // the audit trail is unreachable.
      mockGetAbuseDetail.mockImplementation(async () => ({
        workspaceId: "org-1",
        workspaceName: null,
        level: "warning",
        trigger: "query_rate",
        message: "was flagged",
        updatedAt: "2026-03-23T00:00:00.000Z",
        counters: { queryCount: 201, errorCount: 0, errorRatePct: 0, uniqueTablesAccessed: 0, escalations: 1 },
        thresholds: { queryRateLimit: 200, queryRateWindowSeconds: 300, errorRateThreshold: 0.5, uniqueTablesLimit: 50, throttleDelayMs: 2000 },
        currentInstance: createAbuseInstance([]),
        priorInstances: [],
        eventsStatus: "load_failed",
      }));
      const res = await app.fetch(
        adminRequest("GET", "/api/v1/admin/abuse/org-1/detail"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { eventsStatus: string; counters: Record<string, unknown> };
      expect(body.eventsStatus).toBe("load_failed");
      // Counters still render — the banner sits alongside live state, not instead of it.
      expect(body.counters.queryCount).toBe(201);
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
