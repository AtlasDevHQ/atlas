/**
 * Tests for admin abuse prevention API endpoints.
 *
 * Covers: GET /admin/abuse, POST /admin/abuse/:id/reinstate, GET /admin/abuse/config.
 *
 * These routes are platform-admin-only; workspace admins/owners are rejected
 * at the auth gate. See admin-abuse-platform-gate.test.ts for the rejection
 * matrix and security-audit-1-2-3.md F-09 for rationale.
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
import { asPercentage, asRatio } from "@useatlas/types";
import type { ReinstatedLevel } from "@atlas/api/lib/security/abuse";
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
// F-33: `reinstateWorkspace` returns the previous level on success so the
// route can emit audit metadata without a second getter call, or `null`
// when the workspace is not flagged. Default success fixture surfaces
// "warning" to exercise the most common delta.
const mockReinstateWorkspace: Mock<
  (wsId: string, actorId: string) => ReinstatedLevel | null
> = mock(() => "warning");
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

// --- Audit capture (F-33) ---
// Intercept `logAdminAction` so tests can assert reinstate dual-writes to
// `admin_action_log` alongside `abuse_events`. Real `ADMIN_ACTIONS` is
// re-exported so a typo in the route vs. the catalog breaks the suite.

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  metadata?: Record<string, unknown>;
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
}

const mockLogAdminAction: Mock<(entry: CapturedAuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});


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
        user: { id: "platform-admin-1", mode: "simple-key", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
      }),
    );
    mockListFlagged.mockImplementation(() => []);
    mockReinstateWorkspace.mockImplementation(() => "warning");
    mockReinstateWorkspace.mockClear();
    mockGetAbuseEvents.mockImplementation(async () => ({ events: [], status: "ok" }));
    mockLogAdminAction.mockClear();
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

    it("falls back to null AND surfaces a warning when name resolution rejects (#1640, #1751)", async () => {
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
      const body = await res.json() as {
        workspaces: Array<{ workspaceId: string; workspaceName: string | null }>;
        warnings?: string[];
      };
      expect(body.workspaces[0]?.workspaceName).toBeNull();
      // F-09 follow-up: without a warnings[] channel, a platform admin can't
      // tell "all names are genuinely null" from "DB couldn't answer" — an
      // active wrong-row-selection hazard when reinstating by row click.
      expect(body.warnings).toBeDefined();
      expect(body.warnings?.[0]).toMatch(/^name_resolution_failed:/);
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
      // `auditPersisted` is first-class on every reinstate response (F-33
      // follow-up) so non-UI clients can branch on a single boolean
      // without parsing `warnings[]`.
      expect(body.auditPersisted).toBe(true);
    });

    it("returns 400 when workspace not flagged", async () => {
      mockReinstateWorkspace.mockImplementation(() => null);
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-clean/reinstate"),
      );
      expect(res.status).toBe(400);
    });

    it("dual-writes audit: abuse_events (via reinstateWorkspace) AND admin_action_log (#1788, F-33)", async () => {
      // The split trail is the compliance gap: pre-fix, reinstate only hit
      // abuse_events via the lib, so queries against `admin_action_log` for
      // platform-admin activity missed every reinstate. The fix is a
      // dual-write — both paths must fire on the happy path.
      //
      // `reinstateWorkspace` is the module boundary for the `abuse_events`
      // insert (calls `persistAbuseEvent` internally), so asserting it was
      // called pins the abuse_events side; `mockLogAdminAction` pins the
      // admin_action_log side. The parameterized suite below exercises
      // all three `ReinstatedLevel` values; this case is the happy-path
      // smoke with a representative (non-default) return.
      mockReinstateWorkspace.mockImplementation(() => "suspended");
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
      );
      expect(res.status).toBe(200);

      // abuse_events side — `reinstateWorkspace` drives `persistAbuseEvent`
      // which inserts a row capturing the previous level via the event.
      expect(mockReinstateWorkspace).toHaveBeenCalledTimes(1);
      expect(mockReinstateWorkspace.mock.calls[0]?.[0]).toBe("org-1");

      // admin_action_log side — canonical action_type is
      // `workspace.reinstate_abuse` (domain `workspace`) with platform
      // scope since this route is platform-admin-gated (F-09). Metadata
      // carries `previousLevel` so a reviewer can distinguish an un-warn
      // from lifting a full suspension without joining `abuse_events`.
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]?.[0];
      expect(entry).toBeDefined();
      expect(entry?.actionType).toBe("workspace.reinstate_abuse");
      expect(entry?.targetType).toBe("workspace");
      expect(entry?.targetId).toBe("org-1");
      expect(entry?.scope).toBe("platform");
      expect(entry?.metadata?.previousLevel).toBe("suspended");
    });

    it.each([
      ["warning" as const],
      ["throttled" as const],
      ["suspended" as const],
    ])(
      "dual-write propagates previousLevel=%s through to audit metadata (#1788, F-33)",
      async (level) => {
        // Parametrized over every `ReinstatedLevel` value so a future
        // refactor that branches by severity (e.g. collapsing throttled +
        // suspended into a single bucket, or a level-specific audit path)
        // trips the suite on whichever branch it broke. Pins the identity
        // pass-through from `reinstateWorkspace` → `metadata.previousLevel`.
        mockReinstateWorkspace.mockImplementation(() => level);
        const res = await app.fetch(
          adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
        );
        expect(res.status).toBe(200);
        expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
        const entry = mockLogAdminAction.mock.calls[0]?.[0];
        expect(entry?.actionType).toBe("workspace.reinstate_abuse");
        expect(entry?.metadata?.previousLevel).toBe(level);
      },
    );

    it("does NOT emit logAdminAction when workspace is not flagged (#1788, F-33)", async () => {
      // Guard against double-counting: the 400 branch short-circuits before
      // the dual-write, so a reviewer counting `workspace.reinstate_abuse`
      // rows matches the count of actual state transitions, not every
      // attempted click.
      mockReinstateWorkspace.mockImplementation(() => null);
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-clean/reinstate"),
      );
      expect(res.status).toBe(400);
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it("still attempts logAdminAction when no internal DB (#1788, F-33)", async () => {
      // Even without an internal DB, `logAdminAction` is called — it's a
      // noop-safe fire-and-forget per `lib/audit/admin.ts`, so the route
      // stays consistent with other F-* phase-4 audit sites (F-30, F-31,
      // F-32) that don't branch on `hasInternalDB()`. The pino side of
      // `logAdminAction` still emits, which is the only trail available in
      // this configuration — exactly what the `auditPersisted: false` flag
      // and `audit_persist_skipped` warning flag to the admin.
      mocks.hasInternalDB = false;
      try {
        const res = await app.fetch(
          adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
        );
        expect(res.status).toBe(200);
        const body = await res.json() as {
          success: boolean;
          auditPersisted: boolean;
          warnings?: string[];
          message: string;
        };
        expect(body.success).toBe(true);
        expect(body.auditPersisted).toBe(false);
        expect(body.warnings?.[0]).toMatch(/^audit_persist_skipped:/);
        expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
        expect(mockLogAdminAction.mock.calls[0]?.[0]?.actionType).toBe(
          "workspace.reinstate_abuse",
        );
      } finally {
        mocks.hasInternalDB = true;
      }
    });

    it("surfaces audit_persist_skipped warning + auditPersisted:false when no internal DB (#1751)", async () => {
      // Reinstate mutates in-memory state; the audit row goes to the
      // internal DB via fire-and-forget `internalExecute`. When no
      // internal DB is configured, the audit row can't exist at all —
      // the admin needs an explicit warning rather than a successful
      // 200 that hides a compliance gap. Non-UI clients branch on
      // `auditPersisted: false`; UI clients render the `warnings[]`
      // banner. Both channels fire together.
      mocks.hasInternalDB = false;
      try {
        const res = await app.fetch(
          adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
        );
        expect(res.status).toBe(200);
        const body = await res.json() as {
          success: boolean;
          auditPersisted: boolean;
          message: string;
          warnings?: string[];
        };
        expect(body.success).toBe(true);
        expect(body.auditPersisted).toBe(false);
        expect(body.warnings).toBeDefined();
        expect(body.warnings?.[0]).toMatch(/^audit_persist_skipped:/);
        expect(body.message).toMatch(/audit trail could not be written/i);
      } finally {
        mocks.hasInternalDB = true;
      }
    });

    it("returns a clean success response with auditPersisted:true when the internal DB is available", async () => {
      // Counterpart to the no-DB test: when the DB is available, the
      // response must not carry warnings — otherwise the UI shows the
      // destructive banner for every routine reinstate — and the first-class
      // `auditPersisted` flag signals the positive case to non-UI clients.
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        auditPersisted: boolean;
        warnings?: string[];
        message: string;
      };
      expect(body.auditPersisted).toBe(true);
      expect(body.warnings).toBeUndefined();
      expect(body.message).toBe("Workspace reinstated successfully.");
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
          errorRatePct: asPercentage(0),
          uniqueTablesAccessed: 3,
          escalations: 1,
        },
        thresholds: {
          queryRateLimit: 200,
          queryRateWindowSeconds: 300,
          errorRateThreshold: asRatio(0.5),
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

    it("detail falls back to null AND surfaces a warning when name resolution rejects (#1640, #1751)", async () => {
      mockGetAbuseDetail.mockImplementation(async () => ({
        workspaceId: "org-1",
        workspaceName: null,
        level: "warning",
        trigger: "query_rate",
        message: "boom",
        updatedAt: "2026-03-23T00:00:00.000Z",
        counters: { queryCount: 1, errorCount: 0, errorRatePct: null, uniqueTablesAccessed: 0, escalations: 0 },
        thresholds: { queryRateLimit: 200, queryRateWindowSeconds: 300, errorRateThreshold: asRatio(0.5), uniqueTablesLimit: 50, throttleDelayMs: 2000 },
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
      // just as it is for the list. F-09 follow-up adds a warnings[]
      // entry so the admin knows the identity header is degraded before
      // clicking Reinstate.
      expect(res.status).toBe(200);
      const body = await res.json() as { workspaceName: string | null; warnings?: string[] };
      expect(body.workspaceName).toBeNull();
      expect(body.warnings).toBeDefined();
      expect(body.warnings?.[0]).toMatch(/^name_resolution_failed:/);
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
          errorRateThreshold: asRatio(0.5),
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
        counters: { queryCount: 201, errorCount: 0, errorRatePct: asPercentage(0), uniqueTablesAccessed: 0, escalations: 1 },
        thresholds: { queryRateLimit: 200, queryRateWindowSeconds: 300, errorRateThreshold: asRatio(0.5), uniqueTablesLimit: 50, throttleDelayMs: 2000 },
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
