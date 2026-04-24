/**
 * Audit regression suite for `admin-connections.ts` — F-29 (#1784) +
 * F-29 residuals (#1828) + F-34 (#1789).
 *
 * Pins:
 *   - `POST /test` (ephemeral URL probe) → `connection.probe`
 *   - `POST /:id/test` (registered health check) → `connection.health_check`
 *   - `POST /pool/orgs/:orgId/drain` → `connection.pool_drain` (platform scope)
 *   - `POST /:id/drain` → `connection.pool_drain` (workspace scope) — F-29 residuals
 *
 * Per-id drain shares the `connection.pool_drain` action name with the
 * org-wide drain (shipped in #1823); the two are disambiguated by `scope`
 * (workspace vs platform) and by `targetId` (connection id vs org id) on
 * the audit row. Compliance queries that separately count per-connection
 * vs org-wide drain events filter on scope — the action name stays
 * uniform so "all pool drains this quarter" is a single filter. The
 * parity with wizard `/save` is covered in `admin-wizard-save-audit.test.ts`.
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

// ---------------------------------------------------------------------------
// Mocks — declared before the app import
// ---------------------------------------------------------------------------

const mockConnectionList: Mock<() => string[]> = mock(() => ["warehouse"]);
const mockConnectionHas: Mock<(id: string) => boolean> = mock(() => true);
const mockConnectionDescribe: Mock<() => Array<{ id: string; dbType: string }>> = mock(
  () => [{ id: "warehouse", dbType: "postgres" }],
);
const mockConnectionRegister: Mock<(id: string, cfg: unknown) => void> = mock(() => {});
const mockConnectionUnregister: Mock<(id: string) => void> = mock(() => {});
const mockConnectionHealthCheck: Mock<(id: string) => Promise<{ status: string; latencyMs: number; checkedAt: Date }>> = mock(
  () => Promise.resolve({ status: "healthy", latencyMs: 7, checkedAt: new Date() }),
);
const mockConnectionDrainOrg: Mock<(orgId: string) => Promise<{ drained: number }>> = mock(
  async () => ({ drained: 3 }),
);
const mockConnectionDrain: Mock<(id: string) => Promise<{ drained: boolean; message: string }>> = mock(
  async () => ({ drained: true, message: "ok" }),
);
const mockConnectionGetOrgPoolMetrics: Mock<(orgId?: string) => Record<string, unknown>> = mock(() => ({}));
const mockConnectionGetAllPoolMetrics: Mock<() => Record<string, unknown>> = mock(() => ({}));
const mockConnectionGetOrgPoolConfig: Mock<() => Record<string, unknown>> = mock(() => ({}));
const mockConnectionListOrgs: Mock<() => string[]> = mock(() => []);

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "platform_admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  connection: {
    connections: {
      get: () => null,
      getDefault: () => null,
      list: mockConnectionList,
      has: mockConnectionHas,
      describe: mockConnectionDescribe,
      register: mockConnectionRegister,
      unregister: mockConnectionUnregister,
      healthCheck: mockConnectionHealthCheck,
      drainOrg: mockConnectionDrainOrg,
      drain: mockConnectionDrain,
      getOrgPoolMetrics: mockConnectionGetOrgPoolMetrics,
      getAllPoolMetrics: mockConnectionGetAllPoolMetrics,
      getOrgPoolConfig: mockConnectionGetOrgPoolConfig,
      listOrgs: mockConnectionListOrgs,
      getForOrg: () => null,
    },
    resolveDatasourceUrl: () => "postgresql://stub",
    detectDBType: (url?: string) => {
      const connStr = url ?? "";
      if (connStr.startsWith("mysql://")) return "mysql";
      if (connStr.startsWith("postgres://") || connStr.startsWith("postgresql://")) return "postgres";
      throw new Error("Unsupported database URL scheme.");
    },
  },
});

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setPlatformAdmin("org-alpha");
  mockLogAdminAction.mockClear();
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(async () => []);
  mockConnectionList.mockClear();
  mockConnectionList.mockReturnValue(["warehouse"]);
  mockConnectionHas.mockClear();
  mockConnectionHas.mockReturnValue(true);
  mockConnectionDescribe.mockClear();
  mockConnectionDescribe.mockReturnValue([{ id: "warehouse", dbType: "postgres" }]);
  mockConnectionRegister.mockClear();
  mockConnectionUnregister.mockClear();
  mockConnectionHealthCheck.mockClear();
  mockConnectionHealthCheck.mockImplementation(() =>
    Promise.resolve({ status: "healthy", latencyMs: 7, checkedAt: new Date() }),
  );
  mockConnectionDrainOrg.mockClear();
  mockConnectionDrainOrg.mockResolvedValue({ drained: 3 });
});

// ---------------------------------------------------------------------------
// POST /test — ephemeral probe
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/connections/test — audit emission (F-29/F-34)", () => {
  it("emits connection.probe with success metadata on healthy probe", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/test", {
        url: "postgresql://localhost/test",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("connection.probe");
    expect(entry.targetType).toBe("connection");
    expect(entry.targetId).toMatch(/^_test_/); // temp id
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      success: true,
      dbType: "postgres",
    });
    expect(typeof entry.metadata?.latencyMs).toBe("number");
    // Probe is distinct from health_check — compliance queries filter
    // on action_type alone without parsing metadata discriminators.
    expect(entry.actionType).not.toBe("connection.health_check");
  });

  it("emits failure-status connection.probe when healthCheck rejects", async () => {
    mockConnectionHealthCheck.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/test", {
        url: "postgresql://localhost/test",
      }),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("connection.probe");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({ success: false });
  });

  it("does not emit when the URL scheme is unsupported (400)", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/test", {
        url: "ftp://invalid",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /:id/test — existing connection health check
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/connections/:id/test — audit emission (F-29/F-34)", () => {
  it("emits connection.health_check with registered id as target", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/warehouse/test"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("connection.health_check");
    expect(entry.targetType).toBe("connection");
    expect(entry.targetId).toBe("warehouse");
    expect(entry.metadata).toMatchObject({
      success: true,
      dbType: "postgres",
    });
    // Distinct from probe — filter on action_type alone.
    expect(entry.actionType).not.toBe("connection.probe");
  });

  it("does not emit when the connection is not registered (404)", async () => {
    mockConnectionList.mockReturnValue([]);

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/ghost/test"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /pool/orgs/:orgId/drain — pool drain
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/connections/pool/orgs/:orgId/drain — audit emission (F-29/F-34)", () => {
  it("emits connection.pool_drain with platform scope + drainedConnections count", async () => {
    mockConnectionDrainOrg.mockResolvedValue({ drained: 5 });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/pool/orgs/org-alpha/drain"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("connection.pool_drain");
    expect(entry.targetType).toBe("connection");
    expect(entry.targetId).toBe("org-alpha");
    expect(entry.scope).toBe("platform");
    expect(entry.metadata).toMatchObject({
      orgId: "org-alpha",
      drainedConnections: 5,
    });
  });

  it("does not emit when a workspace admin targets another org (403)", async () => {
    mocks.setOrgAdmin("org-alpha");

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/pool/orgs/org-other/drain"),
    );

    expect(res.status).toBe(403);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("does not emit when drainOrg rejects (500)", async () => {
    mockConnectionDrainOrg.mockRejectedValueOnce(new Error("pool stuck"));

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/pool/orgs/org-alpha/drain"),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /:id/drain — per-connection pool drain (F-29 residuals)
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/connections/:id/drain — audit emission (F-29 residuals)", () => {
  it("emits connection.pool_drain with workspace scope + connectionId metadata", async () => {
    mockConnectionDrain.mockResolvedValueOnce({ drained: true, message: "ok" });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/warehouse/drain"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("connection.pool_drain");
    expect(entry.targetType).toBe("connection");
    expect(entry.targetId).toBe("warehouse");
    expect(entry.scope).toBe("workspace");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({ connectionId: "warehouse" });
  });

  it("does not emit when the drain returns drained:false (409)", async () => {
    // The underlying pool refused to drain (already draining / in use).
    // The mutation did not take effect — per the "don't log actions that
    // didn't happen" policy, no audit row lands. Pinned so a future
    // behavior change (e.g. logging the 409 as a distinct action) is an
    // explicit decision, not an accidental regression.
    mockConnectionDrain.mockResolvedValueOnce({
      drained: false,
      message: "pool already draining",
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/warehouse/drain"),
    );

    expect(res.status).toBe(409);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("emits failure-status connection.pool_drain when drain rejects (500)", async () => {
    // Failure-path emission — the drain was attempted and may have
    // partially taken effect before the throw. Forensic evidence is
    // worth a row even when the mutation errored mid-flight.
    mockConnectionDrain.mockRejectedValueOnce(new Error("connection pool exploded"));

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/warehouse/drain"),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("connection.pool_drain");
    expect(entry.targetType).toBe("connection");
    expect(entry.targetId).toBe("warehouse");
    expect(entry.scope).toBe("workspace");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({ connectionId: "warehouse" });
    expect(typeof entry.metadata?.error).toBe("string");
  });

  it("does not emit when the connection is unknown (404)", async () => {
    mockConnectionHas.mockReturnValueOnce(false);

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections/ghost/drain"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
