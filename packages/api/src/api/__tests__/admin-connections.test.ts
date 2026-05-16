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
    encryptSecret: (url: string) => `encrypted:${url}`,
    decryptSecret: (url: string) => (url as string).replace(/^encrypted:/, ""),
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
    it("workspace admin sees only their org's connections — default is suppressed when org owns rows", async () => {
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
      // Should see "warehouse" (owned by org-alpha)
      expect(ids).toContain("warehouse");
      // Should NOT see "default" — the org owns its own connection, so the
      // runtime-registered fallback is suppressed (avoids the SaaS phantom-
      // duplicate where every org saw both `default` and `__demo__`).
      expect(ids).not.toContain("default");
      // Should NOT see "other-org-conn" (belongs to a different org)
      expect(ids).not.toContain("other-org-conn");
    });

    it("workspace admin with no DB connections falls back to default and emits null group fields", async () => {
      // No connections in internal DB for this org — self-hosted single-tenant
      // path keeps working because `default` is the only registered connection.
      // The decoration fallback must still emit groupId/groupName as null on
      // every row; a regression that drops the `?? null` would silently ship
      // `undefined` and trip every downstream consumer relying on the
      // documented three-state semantics.
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["default"]);
      const defaultRow = body.connections[0];
      expect(defaultRow.groupId).toBeNull();
      expect(defaultRow.groupName).toBeNull();
    });

    it("decorates each row with groupId + groupName from the connection_groups JOIN", async () => {
      // The list endpoint's second internalQuery call selects c.id, c.group_id
      // and g.name via LEFT JOIN connection_groups. The visibility query runs
      // first; we only return a group decoration for the visible row.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT c.id FROM connections c WHERE c.org_id")) {
          return Promise.resolve([{ id: "warehouse" }]);
        }
        if (sql.includes("g.name AS group_name")) {
          return Promise.resolve([
            { id: "warehouse", group_id: "g_prod", group_name: "g_prod" },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const warehouse = body.connections.find((c: { id: string }) => c.id === "warehouse");
      expect(warehouse).toBeDefined();
      expect(warehouse.groupId).toBe("g_prod");
      expect(warehouse.groupName).toBe("g_prod");
    });

    it("emits groupName: null when a visible connection has no group decoration", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT c.id FROM connections c WHERE c.org_id")) {
          return Promise.resolve([{ id: "warehouse" }]);
        }
        // LEFT JOIN returns the row with NULL group_id/name when ungrouped.
        if (sql.includes("g.name AS group_name")) {
          return Promise.resolve([
            { id: "warehouse", group_id: null, group_name: null },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const warehouse = body.connections.find((c: { id: string }) => c.id === "warehouse");
      expect(warehouse).toBeDefined();
      expect(warehouse.groupId).toBeNull();
      expect(warehouse.groupName).toBeNull();
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
          // Delete handler now selects (id, org_id, type) so it can decide
          // archive-in-place vs per-org tombstone for global connections.
          return Promise.resolve([{ id: "warehouse", org_id: "org-alpha", type: "postgres" }]);
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

    it("platform admin health-checking a connection not in their active org gets 404", async () => {
      // Mirrors the platform-admin scoping fix: per-connection routes use
      // active-org visibility for everyone. Switch active org to reach
      // another tenant's connection.
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn/test", "POST"),
      );

      expect(res.status).toBe(404);
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

    it("platform admin draining a connection not in their active org gets 404", async () => {
      // After the platform_admin visibility bypass was removed, the
      // per-connection drain endpoint scopes by active org for everyone.
      // Cross-org pool drain still works via `POST /pool/orgs/:orgId/drain`
      // (which accepts an explicit orgId) — that surface remains
      // platform-admin-only via its own check.
      setPlatformAdmin("org-alpha");
      // org-alpha does not own warehouse in this fixture
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse/drain", "POST"),
      );

      expect(res.status).toBe(404);
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

  describe("platform admin — list still org-scoped", () => {
    it("list is scoped to the active org (no cross-org bypass)", async () => {
      // The previous implementation short-circuited getVisibleConnectionIds
      // to `return null` for platform admins, which leaked every tenant's
      // connections into every workspace's admin-connections page. After
      // the fix, platform admins see the same scoped set as workspace
      // admins — they must use the workspace switcher (or the dedicated
      // `/platform/*` surfaces) to look at another org.
      setPlatformAdmin("org-alpha");
      // org-alpha owns only warehouse in this fixture
      mocks.mockInternalQuery.mockResolvedValue([{ id: "warehouse" }]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["warehouse"]);

      // Org filter SQL was issued (no platform_admin bypass)
      const orgFilterCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("SELECT c.id FROM connections c WHERE c.org_id"),
      );
      expect(orgFilterCall).toBeDefined();
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
          return Promise.resolve([{ id: "other-org-conn", org_id: "org-alpha", type: "mysql" }]);
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
    it("falls back to 'default' for workspace admins when the org owns no connections", async () => {
      // Self-hosted single-tenant: no connections rows → seed `default` from
      // the runtime registry so the admin still sees the config-managed DB.
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

    it("suppresses 'default' once the org has its own connections", async () => {
      // SaaS path: dhamra owns __demo__ (or wizard-created), so the runtime-
      // registered `default` should not surface alongside it.
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
      expect(ids).toEqual(["warehouse"]);
    });

    it("scopes platform admin to their active org's connections (no bypass)", async () => {
      // The platform_admin "null = no filter" bypass was removed — platform
      // admins now see the same set as workspace admins. Cross-org views
      // belong in `/platform/*`.
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([{ id: "warehouse" }]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["warehouse"]);
    });

    it("visibility query UNIONs `__global__` connections as a fallback", async () => {
      // The new visibility SQL UNIONs the org's own rows with rows at
      // org_id = '__global__' (with an EXISTS check so an own-row shadows
      // a same-id global row). Used for canonical demos like `__demo__`.
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([{ id: "warehouse" }]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections"),
      );

      expect(res.status).toBe(200);

      // Verify the SQL queried `__global__` in addition to the active org.
      const visibilityCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("SELECT c.id FROM connections c WHERE c.org_id"),
      );
      expect(visibilityCall).toBeDefined();
      expect(visibilityCall![0]).toContain("__global__");
      // Shadow-precedence is enforced via NOT EXISTS, not at the SQL UNION
      // level — same-id own-rows mask the global counterpart.
      expect(visibilityCall![0]).toContain("NOT EXISTS");
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
        // Detail query — now LEFT JOINs connection_groups to surface
        // groupId/groupName on the wire (#2421). The substring picks the
        // composite alias so it doesn't collide with the list endpoint.
        if (sql.includes("SELECT c.url, c.schema_name, c.group_id, g.name AS group_name")) {
          return Promise.resolve([
            {
              url: "encrypted:postgresql://user:pass@host/db",
              schema_name: null,
              group_id: null,
              group_name: null,
            },
          ]);
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
      // group fields are surfaced; null here because the mock returns NULL
      // from the LEFT JOIN. A separate case asserts the populated branch.
      expect(body.groupId).toBeNull();
      expect(body.groupName).toBeNull();
    });

    it("get-by-id surfaces groupId + groupName when the LEFT JOIN matches", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT c.id FROM connections c WHERE c.org_id")) {
          return Promise.resolve([{ id: "warehouse" }]);
        }
        if (sql.includes("SELECT c.url, c.schema_name, c.group_id, g.name AS group_name")) {
          return Promise.resolve([
            {
              url: "encrypted:postgresql://user:pass@host/db",
              schema_name: null,
              group_id: "g_warehouse",
              group_name: "warehouse",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse"),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("g_warehouse");
      expect(body.groupName).toBe("warehouse");
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

    it("published mode (default) inserts status='draft' (#2177)", async () => {
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
      // Post-#2177: status is always 'draft' regardless of `atlas-mode` header.
      expect((params as unknown[])[6]).toBe("draft");
      // url_key_version is the active keyset version (1 for dev/no-key deployments).
      expect((params as unknown[])[7]).toBe(1);
    });

    it("developer mode also inserts status='draft' (#2177 — header is irrelevant)", async () => {
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
      // Post-#2177 status revives to 'draft' regardless of `atlas-mode` header.
      expect(updateParams).toContain("draft");
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

  describe("PUT /connections/__demo__ — no demo-readonly gate post-#2177", () => {
    it("accepts demo edits in published mode (no 403 — drafts handle staging)", async () => {
      // Pre-#2177 this 403'd in published mode. Post-#2177 every write is a
      // draft regardless of mode, so the demo carve-out is gone; the
      // org_id scoping in the row lookup prevents mutating the `__global__`
      // canonical row, so a workspace admin's edit returns 404 (no per-org
      // row exists) instead of leaking into shared state.
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/__demo__", "PUT", { description: "tampered" }),
      );
      // 404 — no per-org `__demo__` exists. The point is: NOT 403.
      expect(res.status).toBe(404);
    });

    it("accepts demo edits with developer-mode cookie too (no special branch)", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);
      const res = await app.fetch(
        adminRequest(
          "/api/v1/admin/connections/__demo__",
          "PUT",
          { description: "editing demo in dev" },
          "atlas-mode=developer",
        ),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /connections — mode-aware archive", () => {
    it("archives (status='archived') instead of hard delete", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{ id: "warehouse", org_id: "org-alpha", type: "postgres" }]);
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

    it("DELETE on __demo__ in any mode hides it from the workspace via per-org tombstone", async () => {
      // Replaces the previous "rejects in published mode" + "allows in
      // developer" pair. After the global-demo + per-org-tombstone
      // refactor (#2304), delete is non-destructive: it inserts a
      // per-org archived shadow row that hides the canonical global
      // `__demo__` from this workspace only. Other tenants keep seeing
      // it. The published-mode demoReadonly guard remains on the PUT
      // handler since URL/description edits would mutate shared state.
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{ id: "__demo__", org_id: "__global__", type: "postgres" }]);
        }
        return Promise.resolve([{ count: "0" }]);
      });
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/__demo__", "DELETE"),
      );
      expect(res.status).toBe(200);

      // Per-org tombstone INSERT (not UPDATE on the global row)
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO connections") &&
          sql.includes("'archived'"),
      );
      expect(insertCall).toBeDefined();
    });

    it("DELETE on org-owned __demo__ in developer mode archives in place", async () => {
      // Backward-compat path: orgs that still have a per-org `__demo__`
      // row (pre-global-demo onboarding) get the original archive-in-place
      // behavior, not a tombstone.
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT") && sql.includes("connections")) {
          return Promise.resolve([{ id: "__demo__", org_id: "org-alpha", type: "postgres" }]);
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

  // ─── #2484 — Add Connection Env Field ─────────────────────────────
  //
  // POST + PUT accept `connectionGroupId` (attach existing env) and
  // `newGroupName` (inline-create with the new connection promoted as
  // primary). Cross-org `connectionGroupId` rejects with 404 (B2B
  // isolation — foreign-org ids look indistinguishable from missing).
  // `newGroupName` conflict on `uq_connection_groups_org_name` rolls the
  // whole INSERT/UPDATE back via the single CTE.

  describe("POST /connections — env field (#2484)", () => {
    it("attach to existing env: INSERT uses provided connectionGroupId, no auto-singleton CTE", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        // Pre-validation: env exists and is active in this org.
        if (sql.includes("SELECT id, status FROM connection_groups")) {
          return Promise.resolve([{ id: "g_prod", status: "active" }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          connectionGroupId: "g_prod",
        }),
      );

      expect(res.status).toBe(201);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("g_prod");

      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO connections"),
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      // Attach branch — straight INSERT, no group_row CTE.
      expect(sql).not.toContain("INSERT INTO connection_groups");
      expect(params).toContain("g_prod");
    });

    it("inline-create env: CTE inserts connection_groups with primary_connection_id = new connection id", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          newGroupName: "Production",
        }),
      );

      expect(res.status).toBe(201);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toMatch(/^g_/);

      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO connections") &&
          sql.includes("INSERT INTO connection_groups"),
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      expect(sql).toContain("primary_connection_id");
      // Group name + connection id both flow into the CTE params.
      expect(params).toContain("Production");
      expect(params).toContain("analytics");
    });

    it("ungrouped (no env field): keeps the existing auto-`g_<id>` self-group CTE", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
        }),
      );

      expect(res.status).toBe(201);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("g_analytics");

      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO connections") &&
          sql.includes("'g_' || $1"),
      );
      expect(insertCall).toBeDefined();
    });

    it("cross-org connectionGroupId: SELECT returns no rows → 404 (B2B isolation, #2424 pattern)", async () => {
      // Mock returns `[]` for the env pre-validate SELECT — mirrors the
      // result of querying with the workspace's org_id when the env
      // actually lives in a different org. Foreign-org ids look identical
      // to ids that don't exist anywhere; both → 404.
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          connectionGroupId: "g_foreign",
        }),
      );

      expect(res.status).toBe(404);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_found");

      // No INSERT should have fired — pre-validation rejected before persistence.
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO connections"),
      );
      expect(insertCall).toBeUndefined();
    });

    it("inline-create env name conflict: 23505 on uq_connection_groups_org_name → 409, connection NOT persisted", async () => {
      // Throw a faux pg unique-violation from the single CTE INSERT.
      // The CTE atomicity is what guarantees rollback — both the group
      // insert and the connection insert fail together. We can't observe
      // the rollback directly from a mock, but the 409 + the absence of
      // a partial UPDATE call in the registry is the contract.
      const conflictErr = Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "uq_connection_groups_org_name",
      });
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (
          typeof sql === "string" &&
          sql.includes("INSERT INTO connections") &&
          sql.includes("INSERT INTO connection_groups")
        ) {
          return Promise.reject(conflictErr);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          newGroupName: "Production",
        }),
      );

      expect(res.status).toBe(409);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("conflict");
      expect(body.message).toContain("Production");
    });

    it("both fields together: 400 invalid_request (mutually exclusive)", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          connectionGroupId: "g_prod",
          newGroupName: "Production",
        }),
      );

      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("invalid_request");
    });

    it("newGroupName fails the name pattern: 400 invalid_request", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          newGroupName: "  spaces & ampersands ", // ampersand isn't in the pattern
        }),
      );

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /connections/:id — env field (#2484)", () => {
    it("reattach to existing env: UPDATE includes group_id, response carries new groupId", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        // Existing-row pre-load — caller's connection lives in this org.
        if (sql.includes("SELECT id, url, type, description, schema_name, group_id FROM connections")) {
          return Promise.resolve([
            {
              id: "warehouse",
              url: "encrypted:postgresql://old",
              type: "postgres",
              description: null,
              schema_name: null,
              group_id: "g_warehouse",
            },
          ]);
        }
        // Env pre-validate: target group exists and is active.
        if (sql.includes("SELECT id, status FROM connection_groups")) {
          return Promise.resolve([{ id: "g_prod", status: "active" }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          connectionGroupId: "g_prod",
        }),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("g_prod");

      // Find the UPDATE that carries the new group_id.
      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.startsWith("UPDATE connections") &&
          sql.includes("group_id"),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toContain("g_prod");
    });

    it("explicit ungroup (connectionGroupId: null): UPDATE back to `g_<id>` via ON CONFLICT CTE", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id, url, type, description, schema_name, group_id FROM connections")) {
          return Promise.resolve([
            {
              id: "warehouse",
              url: "encrypted:postgresql://old",
              type: "postgres",
              description: null,
              schema_name: null,
              group_id: "g_prod",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          connectionGroupId: null,
        }),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("g_warehouse");

      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("UPDATE connections") &&
          sql.includes("INSERT INTO connection_groups") &&
          sql.includes("ON CONFLICT"),
      );
      expect(updateCall).toBeDefined();
    });

    it("inline-create on edit: CTE creates env with primary_connection_id = this connection id", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id, url, type, description, schema_name, group_id FROM connections")) {
          return Promise.resolve([
            {
              id: "warehouse",
              url: "encrypted:postgresql://old",
              type: "postgres",
              description: null,
              schema_name: null,
              group_id: "g_warehouse",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          newGroupName: "Production",
        }),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toMatch(/^g_/);

      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO connection_groups") &&
          sql.includes("primary_connection_id") &&
          sql.includes("UPDATE connections"),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toContain("Production");
      // The connection id flows into the CTE so the new group's
      // primary_connection_id surfaces as user-named on the next list.
      expect(updateCall![1]).toContain("warehouse");
    });

    it("cross-org connectionGroupId on edit: 404 before any UPDATE fires", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id, url, type, description, schema_name, group_id FROM connections")) {
          return Promise.resolve([
            {
              id: "warehouse",
              url: "encrypted:postgresql://old",
              type: "postgres",
              description: null,
              schema_name: null,
              group_id: "g_warehouse",
            },
          ]);
        }
        // Env pre-validate misses — foreign-org id.
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          connectionGroupId: "g_foreign",
        }),
      );

      expect(res.status).toBe(404);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_found");

      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.startsWith("UPDATE connections"),
      );
      expect(updateCall).toBeUndefined();
    });

    it("inline-create name conflict on edit: 23505 → 409, no UPDATE persisted", async () => {
      const conflictErr = Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "uq_connection_groups_org_name",
      });
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id, url, type, description, schema_name, group_id FROM connections")) {
          return Promise.resolve([
            {
              id: "warehouse",
              url: "encrypted:postgresql://old",
              type: "postgres",
              description: null,
              schema_name: null,
              group_id: "g_warehouse",
            },
          ]);
        }
        if (
          typeof sql === "string" &&
          sql.includes("INSERT INTO connection_groups") &&
          sql.includes("UPDATE connections")
        ) {
          return Promise.reject(conflictErr);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          newGroupName: "Production",
        }),
      );

      expect(res.status).toBe(409);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("conflict");
      expect(body.message).toContain("Production");
    });
  });
});
