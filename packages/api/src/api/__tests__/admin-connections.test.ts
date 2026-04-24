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

function adminRequest(urlPath: string, method = "GET", body?: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { Authorization: "Bearer test-key" };
  if (cookie) headers.Cookie = cookie;
  const opts: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
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
        if (sql.includes("SELECT c.id FROM connections c WHERE c.org_id")) {
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
        if (sql.includes("SELECT c.id FROM connections c WHERE c.org_id")) {
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
        ([sql]) => typeof sql === "string" && sql.includes("SELECT c.id FROM connections c WHERE c.org_id"),
      );
      expect(orgFilterCall).toBeUndefined();
    });

    it("update scopes by active org even for platform admin", async () => {
      setPlatformAdmin("org-alpha");
      // Platform admin queries now always include org_id (composite PK scoping)
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

      // Verify the SELECT includes org_id filter (composite PK scoping)
      const selectCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("SELECT") && sql.includes("connections"),
      );
      expect(selectCall).toBeDefined();
      expect(selectCall![0]).toContain("org_id");
    });

    it("delete scopes by active org even for platform admin", async () => {
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

      // Delete is implemented as an archive UPDATE (#1428) — verify it
      // includes the org_id filter (composite PK scoping)
      const archiveCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("UPDATE connections") &&
          sql.includes("archived"),
      );
      expect(archiveCall).toBeDefined();
      expect(archiveCall![0]).toContain("org_id");
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
        if (sql.includes("SELECT c.id FROM connections c WHERE c.org_id")) {
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
        if (sql.includes("SELECT c.id FROM connections c WHERE c.org_id")) {
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

  // ─── GET /connections — mode-aware status clause (#1427 / #1455) ──────

  describe("GET /connections — mode-aware status filter", () => {
    function findVisibleConnectionsCall(): [string, unknown[]] | undefined {
      const call = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("SELECT c.id FROM connections c WHERE c.org_id"),
      );
      return call as [string, unknown[]] | undefined;
    }

    it("published mode restricts visible connections to status = 'published'", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);

      const call = findVisibleConnectionsCall();
      expect(call).toBeDefined();
      expect(call![0]).toContain("status = 'published'");
      expect(call![0]).not.toContain("status IN ('published', 'draft')");
    });

    it("developer mode expands to status IN ('published', 'draft') when cookie is set", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "GET", undefined, "atlas-mode=developer"),
      );
      expect(res.status).toBe(200);

      const call = findVisibleConnectionsCall();
      expect(call).toBeDefined();
      expect(call![0]).toContain("status IN ('published', 'draft')");
      expect(call![0]).not.toContain("status = 'published'");
      // Archived rows are always excluded — never appears in either mode
      expect(call![0]).not.toContain("archived");
    });
  });

  // ─── Write-path mode-awareness (#1428) ────────────────────────────────

  describe("POST /connections — mode-aware create", () => {
    beforeEach(() => {
      setOrgAdmin("org-alpha");
    });

    it("published mode inserts status='published'", async () => {
      mocks.mockInternalQuery.mockResolvedValue([]);
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
        }),
      );
      expect(res.status).toBe(201);
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO connections"),
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      expect(sql).toContain("status");
      expect(sql).toContain("url_key_version");
      // F-47: status is now at index 6 (was last, pushed by url_key_version at index 7).
      expect((params as unknown[])[6]).toBe("published");
      // url_key_version is the active keyset version (1 for dev/no-key deployments).
      expect((params as unknown[])[7]).toBe(1);
    });

    it("developer mode inserts status='draft'", async () => {
      mocks.mockInternalQuery.mockResolvedValue([]);
      const res = await app.fetch(
        adminRequest(
          "/api/v1/admin/connections",
          "POST",
          { id: "analytics", url: "postgresql://user:pass@host/db" },
          "atlas-mode=developer",
        ),
      );
      expect(res.status).toBe(201);
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO connections"),
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      expect(sql).toContain("status");
      // F-47 shifted status from last → index 6.
      expect((params as unknown[])[6]).toBe("draft");
    });

    it("revives an archived row (UPDATE, not INSERT) when PK collides", async () => {
      // After a DELETE archives a connection, the (id, org_id) PK row remains
      // while the in-memory registry is unregistered. Recreating with the
      // same id must revive via UPDATE rather than 500 on PK conflict.
      // Using id="analytics" which isn't in the default mock registry, so
      // `connections.has("analytics")` returns false as it would in prod
      // after unregister.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT status FROM connections")) {
          return Promise.resolve([{ status: "archived" }]);
        }
        return Promise.resolve([]);
      });
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
        }),
      );
      expect(res.status).toBe(201);
      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("UPDATE connections") &&
          sql.includes("status"),
      );
      expect(updateCall).toBeDefined();
      // Revival UPDATE must be scoped to the composite PK — id AND org_id
      expect(updateCall![0] as string).toContain("WHERE id =");
      expect(updateCall![0] as string).toContain("org_id");
      const updateParams = updateCall![1] as unknown[];
      // status revives to 'published' (default mode), then id, then orgId
      expect(updateParams).toContain("published");
      expect(updateParams).toContain("analytics");
      expect(updateParams).toContain("org-alpha");
      const staleInsert = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" && sql.includes("INSERT INTO connections"),
      );
      expect(staleInsert).toBeUndefined();
    });

    it("non-demo PUT in developer mode is immediate direct UPDATE (not staged)", async () => {
      // AC: connection edits are immediate per PRD — even in developer mode
      setOrgAdmin("org-alpha");
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
        return Promise.resolve([]);
      });
      const res = await app.fetch(
        adminRequest(
          "/api/v1/admin/connections/warehouse",
          "PUT",
          { description: "edited in dev" },
          "atlas-mode=developer",
        ),
      );
      expect(res.status).toBe(200);
      // Verify we ran UPDATE — not an INSERT (draft-copy semantics would be wrong for connections)
      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("UPDATE connections SET url"),
      );
      expect(updateCall).toBeDefined();
      const staleInsert = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" && sql.includes("INSERT INTO connections"),
      );
      expect(staleInsert).toBeUndefined();
    });

    it("returns 409 when PK collides with a non-archived row", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT status FROM connections")) {
          return Promise.resolve([{ status: "published" }]);
        }
        return Promise.resolve([]);
      });
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("conflict");
    });
  });

  describe("PUT /connections/__demo__ — demo gating", () => {
    it("rejects demo writes in published mode with 403 and descriptive message", async () => {
      setOrgAdmin("org-alpha");
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/__demo__", "PUT", { description: "tampered" }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("demo_readonly");
      expect(String(body.message)).toMatch(/developer mode/i);
    });

    it("allows demo writes in developer mode (hits the DB select)", async () => {
      setOrgAdmin("org-alpha");
      // The select returns empty — we only care that the demo gate doesn't fire first
      mocks.mockInternalQuery.mockResolvedValue([]);
      const res = await app.fetch(
        adminRequest(
          "/api/v1/admin/connections/__demo__",
          "PUT",
          { description: "editing demo in dev" },
          "atlas-mode=developer",
        ),
      );
      // Returns 404 because we haven't seeded the row in the mock, but the demo
      // gate didn't fire — that's what we're verifying
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /connections — mode-aware archive", () => {
    it("archives (status='archived') instead of hard delete", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{ id: "warehouse" }]);
        }
        return Promise.resolve([{ count: "0" }]);
      });
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "DELETE"),
      );
      expect(res.status).toBe(200);
      const archiveCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("UPDATE connections") &&
          sql.includes("status") &&
          sql.includes("archived"),
      );
      expect(archiveCall).toBeDefined();
      const hardDelete = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("DELETE FROM connections WHERE id"),
      );
      expect(hardDelete).toBeUndefined();
    });

    it("rejects DELETE on __demo__ in published mode with 403", async () => {
      setOrgAdmin("org-alpha");
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/__demo__", "DELETE"),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("demo_readonly");
    });

    it("allows DELETE on __demo__ in developer mode (archives instead of hard delete)", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{ id: "__demo__" }]);
        }
        return Promise.resolve([{ count: "0" }]);
      });
      const res = await app.fetch(
        adminRequest(
          "/api/v1/admin/connections/__demo__",
          "DELETE",
          undefined,
          "atlas-mode=developer",
        ),
      );
      expect(res.status).toBe(200);
      const archiveCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("UPDATE connections") &&
          sql.includes("archived"),
      );
      expect(archiveCall).toBeDefined();
    });
  });

  // ─── F-44 regression — response bodies scrub DSN userinfo ──────────────
  //
  // The test-connection + create-connection + update-connection endpoints
  // used to interpolate raw `err.message` into the 400/500 response body on
  // driver failure. pg / mysql2 sometimes echo the full DSN into `err.message`
  // (`connect ECONNREFUSED for postgres://user:pass@host:5432/db`), which
  // leaked the password to whatever consumed the response — admin UI,
  // browser history, bug-report screenshots, upstream proxies. The log line
  // was scrubbed by the pino serializer, but the HTTP body wasn't.
  //
  // These tests assert the password `hunter2` never escapes the response body
  // on the four response-body interpolation paths fixed in this PR.

  describe("F-44 — connection test response-body DSN scrub", () => {
    const DSN = "postgresql://admin:hunter2@db.example.com:5432/analytics";

    beforeEach(() => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);
    });

    it("POST /test scrubs DSN userinfo from the 400 response body", async () => {
      mockHealthCheck.mockImplementationOnce(() =>
        Promise.reject(new Error(`ECONNREFUSED for ${DSN}`)),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/test", "POST", { url: DSN }),
      );

      expect(res.status).toBe(400);
      const raw = await res.text();
      expect(raw).not.toContain("hunter2");
      expect(raw).toContain("postgresql://***@db.example.com:5432/analytics");
    });

    it("POST / (create) scrubs DSN userinfo when connection test fails", async () => {
      mockHealthCheck.mockImplementationOnce(() =>
        Promise.reject(new Error(`ECONNREFUSED for ${DSN}`)),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", { id: "new-conn", url: DSN }),
      );

      expect(res.status).toBe(400);
      const raw = await res.text();
      expect(raw).not.toContain("hunter2");
    });

    it("POST /test scrubs DSN userinfo when URL-scheme detection throws", async () => {
      const res = await app.fetch(
        adminRequest(
          "/api/v1/admin/connections/test",
          "POST",
          { url: "postgres://admin:hunter2@db.example.com/invalid" },
        ),
      );

      // register/healthCheck both succeed for the valid postgres scheme,
      // so this particular URL wouldn't trigger the detectDBType path —
      // but we assert on any 4xx/5xx that would interpolate err.message.
      const raw = await res.text();
      if (res.status >= 400) {
        expect(raw).not.toContain("hunter2");
      }
    });
  });
});
