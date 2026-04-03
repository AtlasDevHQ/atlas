/**
 * Tests for admin connection CRUD org-scoping.
 *
 * Validates that:
 * 1. Creating a connection stores org_id in the DB
 * 2. Workspace admins only see connections belonging to their org
 * 3. Workspace admins cannot update/delete/health-check/drain connections from another org
 * 3b. Health-check endpoint respects visibility filter
 * 3c. Connection drain endpoint respects visibility filter
 * 3d. Org drain endpoint restricts workspace admins to their own org
 * 4. Platform admins can see/modify all connections regardless of org
 * 5. getVisibleConnectionIds returns the correct set for a given org
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

const mockHealthCheck = mock(() =>
  Promise.resolve({ status: "healthy", latencyMs: 3, checkedAt: new Date() }),
);

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  connection: {
    connections: {
      get: () => null,
      getDefault: () => null,
      describe: () => [
        { id: "default", dbType: "postgres", description: "Default config connection" },
        { id: "warehouse", dbType: "postgres", description: "Warehouse" },
        { id: "other-org-conn", dbType: "mysql", description: "Other org connection" },
      ],
      healthCheck: mockHealthCheck,
      register: mock(() => {}),
      unregister: mock(() => false),
      has: (id: string) => ["default", "warehouse", "other-org-conn"].includes(id),
      list: () => ["default", "warehouse", "other-org-conn"],
      getForOrg: () => null,
      drain: mock(() => Promise.resolve({ drained: true, message: "Pool drained" })),
      drainOrg: mock(() => Promise.resolve({ drained: 0 })),
      getAllPoolMetrics: () => [],
      getOrgPoolMetrics: () => [],
      getOrgPoolConfig: () => ({ enabled: false, maxConnections: 5, idleTimeoutMs: 30000, maxOrgs: 50, warmupProbes: 2, drainThreshold: 5 }),
      listOrgs: () => [],
    },
    resolveDatasourceUrl: () => "postgresql://stub",
  },
  internal: {
    encryptUrl: (url: string) => `encrypted:${url}`,
    decryptUrl: (url: string) => (url as string).replace(/^encrypted:/, ""),
  },
});

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helpers ---

function setOrgAdmin(orgId: string): void {
  mocks.setOrgAdmin(orgId);
}

function setPlatformAdmin(orgId: string): void {
  mocks.setPlatformAdmin(orgId);
}

function adminRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key" },
  };
  if (body) {
    opts.headers = { ...opts.headers, "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${urlPath}`, opts);
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

// --- Tests ---

describe("admin connections — org scoping", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    mockHealthCheck.mockClear();
    setOrgAdmin("org-alpha");
  });

  // ─── 1. Create stores org_id ────────────────────────────────────────

  describe("POST /connections — create stores org_id", () => {
    it("passes orgId to the INSERT query", async () => {
      // register + healthCheck succeed via mock, then encrypt + INSERT
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
        }),
      );

      expect(res.status).toBe(201);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("analytics");

      // Find the INSERT call among internalQuery calls
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO connections"),
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      expect(sql).toContain("org_id");
      expect(params).toContain("org-alpha");
    });

    it("stores a different org_id for a different workspace admin", async () => {
      setOrgAdmin("org-beta");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "reporting",
          url: "postgresql://user:pass@host/reporting",
        }),
      );

      expect(res.status).toBe(201);

      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO connections"),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain("org-beta");
    });
  });

  // ─── 2. List filters by org ─────────────────────────────────────────

  describe("GET /connections — list filters by org", () => {
    it("workspace admin only sees connections belonging to their org", async () => {
      // getVisibleConnectionIds queries internal DB for org's connections
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM connections WHERE org_id")) {
          // org-alpha owns "warehouse" only
          return Promise.resolve([{ id: "warehouse" }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      // Should see "default" (always visible) + "warehouse" (owned by org-alpha)
      expect(ids).toContain("default");
      expect(ids).toContain("warehouse");
      // Should NOT see "other-org-conn" (belongs to a different org)
      expect(ids).not.toContain("other-org-conn");
    });

    it("workspace admin with no DB connections only sees default", async () => {
      // No connections in internal DB for this org
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["default"]);
    });
  });

  // ─── 3. Update/delete 404 for wrong org ─────────────────────────────

  describe("PUT /connections/:id — org isolation", () => {
    it("returns 404 when connection belongs to another org", async () => {
      setOrgAdmin("org-alpha");
      // SELECT ... WHERE id = $1 AND org_id = $2 → empty (wrong org)
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn", "PUT", {
          description: "hacked",
        }),
      );

      expect(res.status).toBe(404);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_found");

      // Verify the SQL included org_id filter
      const selectCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("SELECT") && sql.includes("connections"),
      );
      expect(selectCall).toBeDefined();
      expect(selectCall![0]).toContain("org_id");
      expect(selectCall![1]).toContain("org-alpha");
    });

    it("succeeds when connection belongs to the admin's org", async () => {
      setOrgAdmin("org-alpha");
      // SELECT returns existing connection
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{
            id: "warehouse",
            url: "encrypted:postgresql://user:pass@host/db",
            type: "postgres",
            description: "Warehouse",
            schema_name: null,
          }]);
        }
        // UPDATE succeeds
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          description: "Updated warehouse",
        }),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("warehouse");
    });
  });

  describe("DELETE /connections/:id — org isolation", () => {
    it("returns 404 when connection belongs to another org", async () => {
      setOrgAdmin("org-alpha");
      // SELECT ... WHERE id = $1 AND org_id = $2 → empty
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn", "DELETE"),
      );

      expect(res.status).toBe(404);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_found");
    });

    it("succeeds when connection belongs to the admin's org", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{ id: "warehouse" }]);
        }
        // scheduled_tasks check + DELETE
        return Promise.resolve([{ count: "0" }]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "DELETE"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });

    it("cannot delete the default connection", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/default", "DELETE"),
      );

      expect(res.status).toBe(403);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("forbidden");
    });
  });

  // ─── 3b. Health-check org isolation ───────────────────────────────

  describe("POST /connections/:id/test — org isolation", () => {
    it("returns 404 when health-checking a connection not visible to org", async () => {
      setOrgAdmin("org-alpha");
      // org-alpha does not own other-org-conn
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn/test", "POST"),
      );

      expect(res.status).toBe(404);
    });

    it("succeeds when health-checking a connection visible to org", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM connections WHERE org_id")) {
          return Promise.resolve([{ id: "warehouse" }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse/test", "POST"),
      );

      expect(res.status).toBe(200);
    });

    it("platform admin can health-check any connection", async () => {
      setPlatformAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn/test", "POST"),
      );

      expect(res.status).toBe(200);
    });
  });

  // ─── 3c. Drain endpoint org isolation ───────────────────────────────

  describe("POST /connections/:id/drain — org isolation", () => {
    it("returns 404 when draining a connection not visible to org", async () => {
      setOrgAdmin("org-alpha");
      // org-alpha does not own other-org-conn
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn/drain", "POST"),
      );

      expect(res.status).toBe(404);
    });

    it("platform admin can drain any connection", async () => {
      setPlatformAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse/drain", "POST"),
      );

      expect(res.status).toBe(200);
    });
  });

  // ─── 3d. Org drain cross-org restriction ────────────────────────────

  describe("POST /connections/pool/orgs/:orgId/drain — cross-org guard", () => {
    it("workspace admin gets 403 when draining another org's pools", async () => {
      setOrgAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/pool/orgs/org-beta/drain", "POST"),
      );

      expect(res.status).toBe(403);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("forbidden");
    });

    it("workspace admin can drain their own org's pools", async () => {
      setOrgAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/pool/orgs/org-alpha/drain", "POST"),
      );

      expect(res.status).toBe(200);
    });

    it("platform admin can drain any org's pools", async () => {
      setPlatformAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/pool/orgs/org-beta/drain", "POST"),
      );

      expect(res.status).toBe(200);
    });
  });

  // ─── 4. Platform admin bypasses org filter ──────────────────────────

  describe("platform admin — cross-org access", () => {
    it("list returns all connections without org filter", async () => {
      setPlatformAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      // Platform admin sees everything — no filtering
      expect(ids).toContain("default");
      expect(ids).toContain("warehouse");
      expect(ids).toContain("other-org-conn");

      // getVisibleConnectionIds returns null for platform admins (no DB query), so no org filter applied
      const orgFilterCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("SELECT id FROM connections WHERE org_id"),
      );
      expect(orgFilterCall).toBeUndefined();
    });

    it("update succeeds for connection from any org", async () => {
      setPlatformAdmin("org-alpha");
      // Platform admin SELECT omits org_id filter
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{
            id: "other-org-conn",
            url: "encrypted:mysql://user:pass@host/db",
            type: "mysql",
            description: "Other org",
            schema_name: null,
          }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn", "PUT", {
          description: "Updated by platform admin",
        }),
      );

      expect(res.status).toBe(200);

      // Verify the SELECT did NOT include org_id filter
      const selectCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("SELECT") && sql.includes("connections"),
      );
      expect(selectCall).toBeDefined();
      expect(selectCall![0]).not.toContain("org_id");
    });

    it("delete succeeds for connection from any org", async () => {
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{ id: "other-org-conn" }]);
        }
        return Promise.resolve([{ count: "0" }]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn", "DELETE"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });
  });

  // ─── 5. getVisibleConnectionIds correctness ─────────────────────────

  describe("getVisibleConnectionIds — via list endpoint behavior", () => {
    it("always includes 'default' for workspace admins", async () => {
      // Even if internal DB returns no connections for this org
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toContain("default");
    });

    it("includes org-owned connections from internal DB", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM connections WHERE org_id")) {
          return Promise.resolve([{ id: "warehouse" }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toContain("default");
      expect(ids).toContain("warehouse");
      expect(ids).toHaveLength(2);
    });

    it("returns null (no filter) for platform admins — all connections visible", async () => {
      setPlatformAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      // All 3 connections from describe() are returned
      expect(body.connections).toHaveLength(3);
    });

    it("get-by-id returns 404 for connection not visible to org", async () => {
      setOrgAdmin("org-alpha");
      // org-alpha does not own other-org-conn
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn"),
      );

      expect(res.status).toBe(404);
    });

    it("get-by-id succeeds for connection visible to org", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM connections WHERE org_id")) {
          return Promise.resolve([{ id: "warehouse" }]);
        }
        // Detail query for managed connection info
        if (sql.includes("SELECT url, schema_name FROM connections WHERE id")) {
          return Promise.resolve([{ url: "encrypted:postgresql://user:pass@host/db", schema_name: null }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("warehouse");
      expect(body.managed).toBe(true);
    });
  });
});
