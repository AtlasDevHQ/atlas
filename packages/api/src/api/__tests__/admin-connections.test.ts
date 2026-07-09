/**
 * Tests for admin connection CRUD against the post-#2744 `workspace_plugins`
 * (pillar='datasource') world. The route layer in `admin-connections.ts`
 * scopes by workspace, delegates writes to `WorkspaceInstaller`, and
 * decorates list responses with `config->>'group_id'`. These tests focus on
 * the route-level contract:
 *
 *   1. Visibility filter — workspace admins only see installs scoped to
 *      `workspace_id`; platform admins do NOT bypass the filter (cross-org
 *      views live under `/platform/*`).
 *   2. List decoration — `groupId` / `groupName` mirror `config->>'group_id'`
 *      verbatim post-cutover; `billable` flips on workspace-owned rows.
 *   3. Mode-aware status clause — published mode restricts to `'published'`,
 *      developer mode expands to `('published', 'draft')`.
 *   4. Write delegation — POST/PUT/DELETE flow through the installer; the
 *      installer's `loadCatalogRowForInstall` + `workspace_plugins` write
 *      SQL is exercised end-to-end. The route owns the cross-org group
 *      check, the archive-aware existing-row check, and the test-connect
 *      / audit / rollback dances around the installer call.
 *   5. F-44 DSN scrub — error response bodies never echo URL userinfo.
 *   6. #2483 — SaaS suppresses the `default` fallback for fresh-signup
 *      workspaces with zero owned rows.
 *   7. #2490 — `billable` signal matches the billing counter exactly.
 *
 * The lower-level installer SQL (catalog lookup, singleton pre-check,
 * encrypt + INSERT/UPDATE/DELETE) is covered by
 * `lib/effect/__tests__/workspace-installer.test.ts`. Migration-level
 * invariants (constraint order, JSONB key shape, NOT NULL on pillar) are
 * covered by `lib/db/__tests__/migrate-pg.test.ts`'s `0096: cutover`
 * describe. The `connection_groups` table is gone — every test below
 * uses the JSONB `config->>'group_id'` shape.
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

// #3853 — workspace-scoped probe used by the list route's plugin-pool health
// enrichment and the `POST /:id/test` route. Returns a distinct latency so
// tests can assert the route used THIS path (not the bare `healthCheck`).
const mockHealthCheckForWorkspace = mock(() =>
  Promise.resolve({ status: "healthy" as const, latencyMs: 7, checkedAt: new Date() }),
);

// Captured so tests can assert on register-call sequences (e.g. the
// registry-rollback contract on PUT). Without a captured reference,
// inline `mock(() => {})` is unobservable from `.mock.calls`.
const mockRegister = mock(() => {});

// Plugin-datasource re-registration bridge (#3852). The PUT handler routes
// plugin dbTypes (clickhouse / elasticsearch / …) through
// `registerDatasourceInstall` (ADR-0013 `createFromConfig` seam) instead of the
// core `connections.register`, which only understands postgresql:// / mysql://.
// Captured + mocked so the regression test asserts the bridge is used and the
// real `findDatasourcePluginConnection` (which would throw "no plugin
// registered" in a unit test) is never reached.
// Default `false` mirrors the dominant real-world plugin-update case: the
// bridge ALWAYS rebuilds the live connection but returns `!already`, so an
// in-place rebuild of an existing (workspace, install_id) returns `false`. The
// probe must NOT be gated on this boolean (#3852 round-2 fix) — it's gated on
// `hasDirectForWorkspace` instead.
const mockRegisterDatasourceInstall = mock(() => Promise.resolve(false));

// The post-update plugin-adapter liveness probe (#3852) runs
// `connections.getForWorkspace(orgId, id).query("SELECT 1", …)` (or `ping()`).
// Capture the query so a test can (a) assert the probe fired and (b) make it
// reject to drive the rollback path.
const mockProbeQuery = mock(() =>
  Promise.resolve({ columns: [] as string[], rows: [] as Record<string, unknown>[] }),
);
const mockGetForWorkspace = mock(() => ({
  query: mockProbeQuery,
  close: () => Promise.resolve(),
}));

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
      // The list route reads through `describeForWorkspace(orgId)` (#3844) so
      // a published plugin datasource — which lives ONLY in the per-workspace
      // direct-plugin map — appears alongside native pools. The fixture unions
      // the bare entries with one such plugin pool (`clickhouse-staging`) so a
      // test can assert it survives the `visible ∩ describe` intersection.
      describeForWorkspace: () => [
        { id: "default", dbType: "postgres", description: "Default config connection" },
        { id: "warehouse", dbType: "postgres", description: "Warehouse" },
        { id: "other-org-conn", dbType: "mysql", description: "Other org connection" },
        { id: "clickhouse-staging", dbType: "clickhouse", description: "ClickHouse" },
      ],
      healthCheck: mockHealthCheck,
      // #3853 — the `/test` route and list health-enrichment resolve plugin
      // pools through the workspace-scoped probe / presence check, not the bare
      // `entries`. `clickhouse-staging` is a plugin pool (present in
      // describeForWorkspace, absent from `list()`), so the fixture wires the
      // workspace-scoped helpers to recognise it.
      healthCheckForWorkspace: mockHealthCheckForWorkspace,
      // A connection is a per-workspace plugin pool iff it's NOT one of the
      // native/bare pools (`default` / `warehouse` / `other-org-conn`, the
      // `list()` + `has()` set). This unifies two needs after the #3852 merge:
      //   #3853 list/health tests — only `clickhouse-staging` (a plugin pool)
      //     is actively probed; native `warehouse` is left to the cached fiber.
      //   #3852 PUT tests — the plugin re-registration probe (`getForWorkspace`)
      //     fires for plugin install ids (`clickhouse`, `analytics`, …).
      // A single predicate avoids the duplicate-key footgun (last-key-wins
      // silently made every row a plugin pool, double-probing the list).
      hasDirectForWorkspace: (_orgId: string, id: string) =>
        !["default", "warehouse", "other-org-conn"].includes(id),
      register: mockRegister,
      // #3852 — plugin pools live in the per-workspace direct map, not the bare
      // `entries`. The PUT handler probes the freshly-built plugin connection
      // via `getForWorkspace(orgId, id)` (default mock returns a working query
      // stub) gated on `hasDirectForWorkspace`.
      getForWorkspace: mockGetForWorkspace,
      unregisterDirectForWorkspace: mock(() => true),
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

// `getConfig` is `null` by default in the test factory. Override here so
// tests can flip deployMode for the #2483 SaaS-gate branch on the
// `default` connection fallback.
let mockConfigOverride: { deployMode?: "saas" | "self-hosted" } | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfigOverride,
  defineConfig: (c: unknown) => c,
}));

// Mock the datasource-registry bridge (#3852) — the PUT handler's plugin
// re-registration seam. All value exports are mocked (mock-all-exports
// discipline); the route only calls `registerDatasourceInstall`, the rest are
// inert stubs so a partial mock can't leave a real export wired.
mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  registerDatasourceInstall: mockRegisterDatasourceInstall,
  unregisterDatasourceInstall: mock(() => true),
  findDatasourcePluginConnection: mock(() => Promise.resolve(undefined)),
  probePluginDatasourceConnection: mock(() => Promise.resolve({ kind: "ok" })),
  probeNativeDatasourceConnection: mock(() => Promise.resolve({ kind: "ok" })),
  isHandlerManagedDatasourceDbType: () => false,
}));

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helpers ---

// The plugin_catalog row the installer's `loadCatalogRowForInstall` reads
// for a postgres datasource. Used as the default fixture so installer
// round-trips succeed in tests that don't care about catalog details.
// `config_schema` mirrors what migration 0093 seeds — `url` is the lone
// `secret: true` field that drives `encryptSecretFields` walking.
const POSTGRES_CATALOG_ROW = {
  id: "cat_postgres",
  slug: "postgres",
  install_model: "form",
  pillar: "datasource",
  // Mirrors the migration-0093 seed shape verbatim: a top-level JSONB
  // array of fields keyed by `key` (NOT `name`). `parseConfigSchema`
  // returns `state: "corrupt"` for any other shape — which then fails
  // closed in `encryptSecretFields` / `decryptSecretFields` (every string
  // value gets encrypted/decrypted, not just `secret: true` ones).
  config_schema: [
    { key: "url", type: "string", required: true, secret: true },
    { key: "schema", type: "string" },
    { key: "description", type: "string" },
  ],
  enabled: true,
};

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

// SQL substring matchers — centralized so a future shape change has one
// place to edit. Every test below dispatches via these helpers.
const sqlIs = {
  /** Route's visibility query — `getVisibleConnectionIds`. */
  visibility: (sql: string): boolean =>
    sql.includes("FROM workspace_plugins wp") &&
    sql.includes("DISTINCT wp.install_id") &&
    sql.includes("wp.pillar = 'datasource'"),
  /** Route's group decoration query — list endpoint, after visibility. */
  decoration: (sql: string): boolean =>
    sql.includes("FROM workspace_plugins wp") &&
    sql.includes("config->>'group_id' AS group_id") &&
    sql.includes("ANY"),
  /**
   * Lib seam's single-install load (`loadInstalledConnection`, #4194) in
   * its default not-archived form — the PUT load and the GET /:id detail
   * load share this exact SQL now.
   */
  detail: (sql: string): boolean => sqlIs.putLoad(sql),
  /** Route's plan-limit count (`countActiveDatasourceInstalls`). */
  planCount: (sql: string): boolean =>
    sql.includes("SELECT COUNT") &&
    sql.includes("FROM workspace_plugins") &&
    sql.includes("status != 'archived'"),
  /**
   * Lib seam's single-install load with `includeArchived` — the POST
   * archive-aware existence check and the DELETE load share this SQL.
   */
  archiveCheck: (sql: string): boolean => sqlIs.deleteLoad(sql),
  /** Lib seam's single-install load, default (not-archived) form. */
  putLoad: (sql: string): boolean =>
    sql.includes("pc.slug AS catalog_slug") &&
    sql.includes("wp.install_id = $2") &&
    sql.includes("status != 'archived'"),
  /** Lib seam's single-install load with `includeArchived` (no status clause). */
  deleteLoad: (sql: string): boolean =>
    sql.includes("pc.slug AS catalog_slug") &&
    sql.includes("wp.install_id = $2") &&
    !sql.includes("status != 'archived'"),
  /** Lib seam's cross-org group existence check (`datasourceGroupExists`). */
  groupExists: (sql: string): boolean =>
    sql.includes("install_id FROM workspace_plugins") &&
    sql.includes("config->>'group_id' = $2"),
  /** Route's scheduled-task references check (DELETE). */
  schedRefs: (sql: string): boolean => sql.includes("FROM scheduled_tasks st"),
  /** Installer's `loadCatalogRowForInstall` / `loadCatalogRowForDisconnect`. */
  catalogLookup: (sql: string): boolean =>
    sql.includes("FROM plugin_catalog") &&
    sql.includes("install_model"),
  /**
   * Installer's singleton pre-check during installDatasource — distinguished
   * from the chat/action `findInstallRow` SELECT (which projects
   * `config->>'team_id' AS team_id`) by the bare `SELECT install_id`
   * projection. Matching on column names rather than param positions so
   * a future param-list reshuffle in the installer doesn't silently break
   * the dispatch and let tests fall through to the empty default.
   */
  installerSingleton: (sql: string): boolean =>
    /SELECT\s+install_id\s+FROM workspace_plugins/i.test(sql) &&
    sql.includes("catalog_id") &&
    sql.includes("install_id"),
  /** Installer's existing-row read during updateDatasourceConfig. */
  installerLoadForUpdate: (sql: string): boolean =>
    sql.includes("SELECT id, install_id, config, status") &&
    sql.includes("FROM workspace_plugins"),
  /**
   * Installer's INSERT during installDatasource. Other call sites
   * (`onboarding.ts`, `cli/seed.ts`, `auth/migrate.ts`) emit the same
   * column list but hard-code `'published'` for status; the installer
   * is the only one parameterising status as `$6`. The `NOW(), $6)`
   * suffix uniquely identifies the installer's INSERT — important so
   * that `param[5] === "draft"` assertions never silently misread a
   * different-INSERT's params.
   */
  installerInsert: (sql: string): boolean =>
    sql.includes("INSERT INTO workspace_plugins") &&
    sql.includes("NOW(), $6)"),
  /** Installer's UPDATE during updateDatasourceConfig. */
  installerUpdate: (sql: string): boolean =>
    sql.includes("UPDATE workspace_plugins") &&
    sql.includes("SET config = $1::jsonb"),
  /** Installer's soft uninstall — sets status='archived'. */
  installerSoftArchive: (sql: string): boolean =>
    sql.includes("UPDATE workspace_plugins") &&
    sql.includes("status = 'archived'") &&
    sql.includes("RETURNING id"),
};

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

// --- Tests ---

describe("admin connections — org scoping (workspace_plugins)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    mockHealthCheck.mockClear();
    mockRegister.mockClear();
    mockRegisterDatasourceInstall.mockClear();
    mockRegisterDatasourceInstall.mockImplementation(() => Promise.resolve(false));
    mockGetForWorkspace.mockClear();
    mockProbeQuery.mockClear();
    mockProbeQuery.mockImplementation(() =>
      Promise.resolve({ columns: [] as string[], rows: [] as Record<string, unknown>[] }),
    );
    mockConfigOverride = null;
    setOrgAdmin("org-alpha");
  });

  // ─── 1. Create persists workspace_id via installer INSERT ──────────

  describe("POST /connections — create persists workspace_id", () => {
    it("passes orgId to the installer's INSERT INTO workspace_plugins call", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSingleton(sql)) return Promise.resolve([]);
        if (sqlIs.installerInsert(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
        }),
      );

      expect(res.status).toBe(201);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("analytics");

      // INSERT INTO workspace_plugins must carry workspace_id at param index 1
      // (after the rowId at index 0). Installer params order is fixed:
      // `[rowId, workspaceId, catalogId, installId, config, status]`.
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(insertCall).toBeDefined();
      const params = insertCall![1] as unknown[];
      expect(params[1]).toBe("org-alpha"); // workspace_id
      expect(params[3]).toBe("analytics"); // install_id
      // POST always passes atlasMode='draft' to the installer (#2177) — the
      // route-level invariant, not a universal installer property. The
      // installer itself happily writes any status the caller supplies.
      expect(params[5]).toBe("draft");
    });

    it("stores a different workspace_id for a different workspace admin", async () => {
      setOrgAdmin("org-beta");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSingleton(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "reporting",
          url: "postgresql://user:pass@host/reporting",
        }),
      );

      expect(res.status).toBe(201);

      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(insertCall).toBeDefined();
      expect((insertCall![1] as unknown[])[1]).toBe("org-beta");
    });
  });

  // ─── 2. List filters by workspace_id ─────────────────────────────────

  describe("GET /connections — list filters by workspace", () => {
    it("workspace admin sees only their workspace's installs — default suppressed when org owns rows", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([{ install_id: "warehouse", group_id: null }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toContain("warehouse");
      // Owned-row branch suppresses the lazy `default` so the admin UI
      // doesn't show two cards on SaaS (#2483).
      expect(ids).not.toContain("default");
      expect(ids).not.toContain("other-org-conn");
    });

    it("workspace with no installs falls back to default and emits null group fields", async () => {
      // Self-hosted single-tenant path keeps working because `default` is
      // the only registered connection. The decoration fallback must still
      // emit `groupId`/`groupName` as null on every row.
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["default"]);
      const defaultRow = body.connections[0];
      expect(defaultRow.groupId).toBeNull();
      expect(defaultRow.groupName).toBeNull();
    });

    it("#2490 — workspace-owned row reports billable: true", async () => {
      // Workspace owns one install. The decoration query returns a row for
      // it, so `groupInfoByConnection.has(id)` is true and `billable: true`
      // — same predicate billing uses for the plan-limit count.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([{ install_id: "warehouse", group_id: null }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const warehouse = body.connections.find((c: { id: string }) => c.id === "warehouse");
      expect(warehouse).toBeDefined();
      expect(warehouse.billable).toBe(true);
    });

    it("#2490 — lone lazy `default` (pre-provision workspace) reports billable: false", async () => {
      // Pre-provision self-hosted demo: zero workspace_plugins rows for this
      // org. `getVisibleConnectionIds` adds `default` from the in-memory
      // registry. The list response must mark it `billable: false` so the
      // admin header agrees with the billing usage panel (which counts the
      // same SQL predicate and reports 0).
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.connections).toHaveLength(1);
      expect(body.connections[0].id).toBe("default");
      expect(body.connections[0].billable).toBe(false);
    });

    it("decorates each row with groupId + groupName from the JSONB group_id read", async () => {
      // Post-cutover groupName mirrors groupId verbatim (a string IS a name
      // now — the `connection_groups.name` join is gone). The list
      // endpoint's `groupInfoByConnection` map carries both for wire-shape
      // backwards compatibility with the admin UI.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([{ install_id: "warehouse", group_id: "prod" }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const warehouse = body.connections.find((c: { id: string }) => c.id === "warehouse");
      expect(warehouse).toBeDefined();
      expect(warehouse.groupId).toBe("prod");
      expect(warehouse.groupName).toBe("prod");
    });

    it("emits groupName: null when a visible install has no group_id JSONB key", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([{ install_id: "warehouse", group_id: null }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const warehouse = body.connections.find((c: { id: string }) => c.id === "warehouse");
      expect(warehouse).toBeDefined();
      expect(warehouse.groupId).toBeNull();
      expect(warehouse.groupName).toBeNull();
    });

    it("#3844 — a published plugin datasource (clickhouse) appears in the list", async () => {
      // The plugin pool registers ONLY in the per-workspace direct-plugin map,
      // never in the bare `entries` — so it's absent from `describe()` but
      // present in `describeForWorkspace()`. `getVisibleConnectionIds` lists it
      // (it owns a `workspace_plugins` row), so the `visible ∩ describe`
      // intersection in the route keeps it only because the route now reads the
      // workspace-scoped describe. Pre-fix it was dropped (invisible-but-queryable).
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) {
          return Promise.resolve([{ install_id: "warehouse" }, { install_id: "clickhouse-staging" }]);
        }
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([
            { install_id: "warehouse", group_id: null },
            { install_id: "clickhouse-staging", group_id: null },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const clickhouse = body.connections.find((c: { id: string }) => c.id === "clickhouse-staging");
      expect(clickhouse).toBeDefined();
      expect(clickhouse.dbType).toBe("clickhouse");
      // It owns a workspace_plugins row, so it counts toward the plan/billing.
      expect(clickhouse.billable).toBe(true);
    });

    it("#3853 — list actively probes a plugin pool so it carries a health object", async () => {
      // The plugin pool (clickhouse-staging) arrives from describeForWorkspace
      // with no cached `health` (the periodic fiber probes only bare entries).
      // The list route must probe it via healthCheckForWorkspace so the row
      // shows latency instead of "Status unknown" and the aggregate reaches
      // full count.
      mockHealthCheckForWorkspace.mockClear();
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) {
          return Promise.resolve([{ install_id: "warehouse" }, { install_id: "clickhouse-staging" }]);
        }
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([
            { install_id: "warehouse", group_id: null },
            { install_id: "clickhouse-staging", group_id: null },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const clickhouse = body.connections.find((c: { id: string }) => c.id === "clickhouse-staging");
      expect(clickhouse.health).toBeDefined();
      expect(clickhouse.health.status).toBe("healthy");
      expect(clickhouse.health.latencyMs).toBe(7);
      // The plugin pool was the only one probed (warehouse is a native id whose
      // health comes from the cached fiber, not this active probe).
      expect(mockHealthCheckForWorkspace).toHaveBeenCalledWith("org-alpha", "clickhouse-staging");
    });

    it("#3860 — one throwing plugin probe degrades its row, never 500s the whole list", async () => {
      // TOCTOU defense-in-depth: `healthCheckForWorkspace` is contractually
      // "never throws", but the list route still wraps each probe so that even
      // an unexpected rejection (e.g. a race-removed pool reaching the native
      // fallback's `ConnectionNotRegisteredError`) is contained to a single
      // `degraded` row rather than rejecting the route's `Promise.allSettled`
      // and failing the entire connections list with a 500.
      mockHealthCheckForWorkspace.mockClear();
      mockHealthCheckForWorkspace.mockImplementationOnce(() =>
        Promise.reject(new Error('Connection "clickhouse-staging" is not registered.')),
      );
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) {
          return Promise.resolve([{ install_id: "warehouse" }, { install_id: "clickhouse-staging" }]);
        }
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([
            { install_id: "warehouse", group_id: null },
            { install_id: "clickhouse-staging", group_id: null },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      // The list survives — no 500 — despite the throwing probe.
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const clickhouse = body.connections.find((c: { id: string }) => c.id === "clickhouse-staging");
      // The bad row is degraded, not absent or fatal.
      expect(clickhouse).toBeDefined();
      expect(clickhouse.health.status).toBe("degraded");
      // Native rows are unaffected.
      const warehouse = body.connections.find((c: { id: string }) => c.id === "warehouse");
      expect(warehouse).toBeDefined();
    });
  });

  // ─── 3. PUT 404s for wrong workspace ──────────────────────────────────

  describe("PUT /connections/:id — workspace isolation", () => {
    it("returns 404 when install belongs to another workspace", async () => {
      setOrgAdmin("org-alpha");
      // putLoad → empty (no install in org-alpha for other-org-conn)
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn", "PUT", {
          description: "hacked",
        }),
      );

      expect(res.status).toBe(404);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_found");

      // The route's PUT load query must filter by workspace_id.
      const selectCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.putLoad(sql),
      );
      expect(selectCall).toBeDefined();
      expect(selectCall![0]).toContain("wp.workspace_id = $1");
      expect(selectCall![1]).toContain("org-alpha");
    });

    it("succeeds when install belongs to the admin's workspace", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.putLoad(sql)) {
          return Promise.resolve([
            {
              catalog_slug: "postgres",
              config: { url: "encrypted:postgresql://user:pass@host/db" },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: null,
            },
          ]);
        }
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_warehouse",
              install_id: "warehouse",
              config: { url: "encrypted:postgresql://user:pass@host/db" },
              status: "published",
            },
          ]);
        }
        if (sqlIs.installerUpdate(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          description: "Updated warehouse",
        }),
      );

      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("warehouse");
    });

    // ─── #3852 — plugin datasource metadata update ────────────────────
    // The keystone bug: setting a Connection group (or any metadata) on a
    // plugin datasource (clickhouse:// / elasticsearch://) 500'd because the
    // handler re-registered via the core `connections.register`, which only
    // accepts postgresql:// / mysql://. The fix routes plugin re-registration
    // through the `createFromConfig` bridge (`registerDatasourceInstall`).
    describe("PUT /connections/:id — plugin datasource (#3852)", () => {
      // Plugin catalog row — `url` is the lone secret field, mirroring the
      // seeded built-in datasource catalog shape. `decryptSecretFields` uses the
      // REAL (unmocked) `decryptSecret` from `db/secret-encryption`, which leaves
      // a non-`enc:v1:` value verbatim, so the fixture stores PLAINTEXT URLs —
      // no `encrypted:` sentinel needed (and none to confuse the assertion).
      function pluginCatalogRow(slug: string) {
        return {
          id: `cat_${slug}`,
          slug,
          install_model: "form",
          pillar: "datasource",
          config_schema: [
            { key: "url", type: "string", required: true, secret: true },
            { key: "description", type: "string" },
          ],
          enabled: true,
        };
      }

      function mockPluginPut(slug: string, storedUrl: string): void {
        const row = pluginCatalogRow(slug);
        mocks.mockInternalQuery.mockImplementation((sql: string) => {
          if (sqlIs.putLoad(sql)) {
            return Promise.resolve([
              {
                catalog_slug: slug,
                config: { url: storedUrl },
                config_schema: row.config_schema,
                group_id: null,
              },
            ]);
          }
          if (sqlIs.groupExists(sql)) {
            // newGroupName creates inline — no cross-org existence check fires,
            // but a defensive stub keeps the dispatch total.
            return Promise.resolve([{ install_id: slug }]);
          }
          if (sqlIs.catalogLookup(sql)) return Promise.resolve([row]);
          if (sqlIs.installerLoadForUpdate(sql)) {
            return Promise.resolve([
              {
                id: `cn_org-alpha_${slug}`,
                install_id: slug,
                config: { url: storedUrl },
                status: "published",
              },
            ]);
          }
          if (sqlIs.installerUpdate(sql)) return Promise.resolve([]);
          return Promise.resolve([]);
        });
      }

      it("setting a Connection group on a clickhouse datasource succeeds (no core-scheme 500)", async () => {
        setOrgAdmin("org-alpha");
        mockPluginPut("clickhouse", "clickhouse://user:pass@host:8443/db");

        const res = await app.fetch(
          adminRequest("/api/v1/admin/connections/clickhouse", "PUT", {
            newGroupName: "clickhouse",
          }),
        );

        expect(res.status).toBe(200);
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
        const body = (await res.json()) as any;
        expect(body.id).toBe("clickhouse");
        // dbType is the plugin slug, not a core-detected scheme.
        expect(body.dbType).toBe("clickhouse");
        expect(body.groupId).toBe("clickhouse");

        // Re-registration went through the createFromConfig bridge…
        expect(mockRegisterDatasourceInstall).toHaveBeenCalled();
        const [row, config] = mockRegisterDatasourceInstall.mock.calls[0] as unknown as [
          { workspaceId: string; catalogSlug: string; installId: string },
          Record<string, unknown>,
        ];
        expect(row.workspaceId).toBe("org-alpha");
        expect(row.catalogSlug).toBe("clickhouse");
        expect(row.installId).toBe("clickhouse");
        // The plaintext clickhouse:// URL reaches `createFromConfig` — proving
        // the plugin scheme survives to the bridge, not the core adapter.
        expect(config.url).toBe("clickhouse://user:pass@host:8443/db");

        // …and NOT through the core adapter, which would have thrown on the
        // clickhouse:// scheme (the 500 this fixes).
        expect(mockRegister).not.toHaveBeenCalled();

        // This is a metadata-only change (group rename, no URL) — the live
        // connection is rebuilt but the liveness PROBE must NOT fire, matching
        // the core path's `urlChanged` gate and ADR-0007. A transiently
        // unreachable datasource must not 500 a valid rename (#3852, round-2
        // review). The rebuild still happened (bridge called above) so the live
        // pool reflects the new config.
        expect(mockProbeQuery).not.toHaveBeenCalled();

        // group_id is persisted into config (criterion #3): the installer's
        // UPDATE writes the merged config JSON with the group_id key.
        const installerUpdateCall = mocks.mockInternalQuery.mock.calls.find(
          ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
        );
        expect(installerUpdateCall).toBeDefined();
        const configJson = (installerUpdateCall![1] as unknown[])[0] as string;
        expect(configJson).toContain("group_id");
        expect(configJson).toContain("clickhouse");
      });

      it("changing the clickhouse URL re-registers via the bridge and probes the plugin adapter", async () => {
        setOrgAdmin("org-alpha");
        mockPluginPut("clickhouse", "clickhouse://user:pass@host:8443/db");

        const res = await app.fetch(
          adminRequest("/api/v1/admin/connections/clickhouse", "PUT", {
            url: "clickhouse://user:pass@newhost:8443/db",
          }),
        );

        expect(res.status).toBe(200);
        expect(mockRegisterDatasourceInstall).toHaveBeenCalled();
        const [, config] = mockRegisterDatasourceInstall.mock.calls[0] as unknown as [
          unknown,
          Record<string, unknown>,
        ];
        expect(config.url).toBe("clickhouse://user:pass@newhost:8443/db");
        expect(mockProbeQuery).toHaveBeenCalled();
        expect(mockRegister).not.toHaveBeenCalled();
      });

      it("setting a group on an elasticsearch datasource also succeeds (not clickhouse-special-cased)", async () => {
        setOrgAdmin("org-alpha");
        mockPluginPut("elasticsearch", "elasticsearch://user:pass@host:9200");

        const res = await app.fetch(
          adminRequest("/api/v1/admin/connections/elasticsearch", "PUT", {
            newGroupName: "elasticsearch",
          }),
        );

        expect(res.status).toBe(200);
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
        const body = (await res.json()) as any;
        expect(body.dbType).toBe("elasticsearch");
        expect(body.groupId).toBe("elasticsearch");
        expect(mockRegisterDatasourceInstall).toHaveBeenCalled();
        expect(mockRegister).not.toHaveBeenCalled();
        // Metadata-only change: no URL ⇒ no probe (URL-change-gated, ADR-0007).
        expect(mockProbeQuery).not.toHaveBeenCalled();
      });

      it("a metadata-only group rename succeeds even when the datasource is unreachable (no probe)", async () => {
        // Round-2 review regression (#3852): a group rename with NO URL change
        // must not run the liveness probe, so a transiently-unreachable plugin
        // datasource (maintenance window) can still be renamed. If the probe
        // fired here it would reject and 500 the rename — the bug this guards.
        setOrgAdmin("org-alpha");
        mockPluginPut("clickhouse", "clickhouse://user:pass@host:8443/db");
        mockProbeQuery.mockImplementation(() =>
          Promise.reject(new Error("ECONNREFUSED 10.0.0.1:8443")),
        );

        const res = await app.fetch(
          adminRequest("/api/v1/admin/connections/clickhouse", "PUT", {
            newGroupName: "clickhouse",
          }),
        );

        // Succeeds despite the unreachable host — the probe was never invoked.
        expect(res.status).toBe(200);
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
        const body = (await res.json()) as any;
        expect(body.groupId).toBe("clickhouse");
        // The liveness probe was never invoked — that is what lets the rename
        // succeed against an unreachable host.
        expect(mockProbeQuery).not.toHaveBeenCalled();
        // The live pool was still rebuilt via the bridge (not the core adapter).
        expect(mockRegisterDatasourceInstall).toHaveBeenCalled();
        expect(mockRegister).not.toHaveBeenCalled();
      });

      it("a metadata-only rebuild failure (bridge throws, not the probe) 500s internal_error", async () => {
        // The companion to the no-probe success case: on a metadata-only change
        // the probe is skipped, but the in-place REBUILD still runs — if the
        // bridge itself throws, that is a genuine server-side failure and must
        // map to 500 internal_error (not the 400 connection_failed reserved for
        // a URL-change probe rejection). Guards the asymmetric error mapping.
        setOrgAdmin("org-alpha");
        mockPluginPut("clickhouse", "clickhouse://user:pass@host:8443/db");
        // First call (the rebuild) throws; the rollback re-register succeeds.
        let call = 0;
        mockRegisterDatasourceInstall.mockImplementation(() => {
          call += 1;
          return call === 1
            ? Promise.reject(new Error("createFromConfig blew up"))
            : Promise.resolve(false);
        });

        const res = await app.fetch(
          adminRequest("/api/v1/admin/connections/clickhouse", "PUT", {
            newGroupName: "clickhouse",
          }),
        );

        expect(res.status).toBe(500);
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
        const body = (await res.json()) as any;
        expect(body.error).toBe("internal_error");
        expect(body.requestId).toBeDefined();
        // Probe never fires on a metadata-only change, even on the failure path.
        expect(mockProbeQuery).not.toHaveBeenCalled();
        // Rollback re-registered the pre-update config via the bridge.
        expect(mockRegisterDatasourceInstall.mock.calls.length).toBe(2);
      });

      it("a URL change whose probe fails rolls back to the pre-update config and 400s", async () => {
        setOrgAdmin("org-alpha");
        mockPluginPut("clickhouse", "clickhouse://user:pass@host:8443/db");
        // The freshly-built connection is registered, then the liveness probe
        // rejects (unreachable host) — the handler must roll back and 400.
        mockProbeQuery.mockImplementation(() =>
          Promise.reject(new Error("ECONNREFUSED 10.0.0.1:8443")),
        );

        const res = await app.fetch(
          adminRequest("/api/v1/admin/connections/clickhouse", "PUT", {
            url: "clickhouse://user:pass@unreachable:8443/db",
          }),
        );

        expect(res.status).toBe(400);
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
        const body = (await res.json()) as any;
        expect(body.error).toBe("connection_failed");
        expect(body.requestId).toBeDefined();

        // The bridge was called twice: once for the attempted new URL, once for
        // the rollback to the pre-update URL.
        expect(mockRegisterDatasourceInstall.mock.calls.length).toBe(2);
        const [, attemptedConfig] = mockRegisterDatasourceInstall.mock.calls[0] as unknown as [
          unknown,
          Record<string, unknown>,
        ];
        const [, rolledBackConfig] = mockRegisterDatasourceInstall.mock.calls[1] as unknown as [
          unknown,
          Record<string, unknown>,
        ];
        expect(attemptedConfig.url).toBe("clickhouse://user:pass@unreachable:8443/db");
        // Rollback re-registers the ORIGINAL stored URL, not the rejected one.
        expect(rolledBackConfig.url).toBe("clickhouse://user:pass@host:8443/db");
        expect(mockRegister).not.toHaveBeenCalled();
      });
    });
  });

  // ─── 4. DELETE 404s for wrong workspace + soft archives ──────────────

  describe("DELETE /connections/:id — workspace isolation", () => {
    it("returns 404 when install belongs to another workspace", async () => {
      setOrgAdmin("org-alpha");
      // deleteLoad → empty (no install for other-org-conn in org-alpha)
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn", "DELETE"),
      );

      expect(res.status).toBe(404);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_found");
    });

    it("succeeds when install belongs to the admin's workspace — soft-archives via installer", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.deleteLoad(sql)) return Promise.resolve([{ catalog_slug: "postgres" }]);
        if (sqlIs.schedRefs(sql)) return Promise.resolve([{ count: "0" }]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSoftArchive(sql)) {
          return Promise.resolve([{ id: "cn_org-alpha_warehouse" }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "DELETE"),
      );

      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Verify the soft-archive UPDATE fired (no hard DELETE on the
      // workspace_plugins row — the install row stays for audit).
      const archiveCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerSoftArchive(sql),
      );
      expect(archiveCall).toBeDefined();
      const hardDelete = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("DELETE FROM workspace_plugins") &&
          sql.includes("install_id"),
      );
      expect(hardDelete).toBeUndefined();
    });

    it("cannot delete the default connection", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/default", "DELETE"),
      );

      expect(res.status).toBe(403);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("forbidden");
    });
  });

  // ─── 3b. Health-check workspace isolation ────────────────────────────

  describe("POST /connections/:id/test — workspace isolation", () => {
    it("returns 404 when health-checking an install not visible to workspace", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn/test", "POST"),
      );

      expect(res.status).toBe(404);
    });

    it("succeeds when health-checking an install visible to workspace", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse/test", "POST"),
      );

      expect(res.status).toBe(200);
    });

    it("#3853 — health-checks a plugin datasource (no 404) via the workspace-scoped probe", async () => {
      // clickhouse-staging is a plugin pool: present in describeForWorkspace,
      // absent from the bare `list()`. Pre-fix the route gated on `list()` →
      // 404; now it gates on describeForWorkspace and probes via
      // healthCheckForWorkspace, returning a real reachability result.
      setOrgAdmin("org-alpha");
      mockHealthCheckForWorkspace.mockClear();
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "clickhouse-staging" }]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/clickhouse-staging/test", "POST"),
      );

      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.status).toBe("healthy");
      expect(body.latencyMs).toBe(7);
      expect(mockHealthCheckForWorkspace).toHaveBeenCalledWith("org-alpha", "clickhouse-staging");
    });

    it("platform admin health-checking an install not in their active workspace gets 404", async () => {
      // Per-connection routes use active-workspace visibility for everyone
      // post-#2303. Switch active workspace via setPlatformAdmin to reach
      // another tenant's install.
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn/test", "POST"),
      );

      expect(res.status).toBe(404);
    });
  });

  // ─── 3c. Drain endpoint workspace isolation ──────────────────────────

  describe("POST /connections/:id/drain — workspace isolation", () => {
    it("returns 404 when draining an install not visible to workspace", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn/drain", "POST"),
      );

      expect(res.status).toBe(404);
    });

    it("platform admin draining an install not in their active workspace gets 404", async () => {
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse/drain", "POST"),
      );

      expect(res.status).toBe(404);
    });
  });

  // ─── 3d. Org drain cross-workspace restriction ───────────────────────

  describe("POST /connections/pool/orgs/:orgId/drain — cross-workspace guard", () => {
    it("workspace admin gets 403 when draining another workspace's pools", async () => {
      setOrgAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/pool/orgs/org-beta/drain", "POST"),
      );

      expect(res.status).toBe(403);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("forbidden");
    });

    it("workspace admin can drain their own workspace's pools", async () => {
      setOrgAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/pool/orgs/org-alpha/drain", "POST"),
      );

      expect(res.status).toBe(200);
    });

    it("platform admin can drain any workspace's pools", async () => {
      setPlatformAdmin("org-alpha");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/pool/orgs/org-beta/drain", "POST"),
      );

      expect(res.status).toBe(200);
    });
  });

  // ─── 4. Platform admin still scoped to active workspace ──────────────

  describe("platform admin — list still workspace-scoped", () => {
    it("list is scoped to the active workspace (no cross-workspace bypass)", async () => {
      // Pre-#2303 the visibility helper short-circuited for platform admins
      // → leaked every tenant's installs into every workspace's admin page.
      // Post-fix, platform admins see the same scoped set as workspace
      // admins; cross-workspace views live in `/platform/*`.
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([{ install_id: "warehouse", group_id: null }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["warehouse"]);

      // Workspace filter SQL was issued (no platform_admin bypass).
      const visCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.visibility(sql),
      );
      expect(visCall).toBeDefined();
      expect(visCall![1]).toContain("org-alpha");
    });

    it("update scopes by active workspace even for platform admin", async () => {
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.putLoad(sql)) {
          return Promise.resolve([
            {
              catalog_slug: "postgres",
              config: { url: "encrypted:postgresql://user:pass@host/db" },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: null,
            },
          ]);
        }
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_other-org-conn",
              install_id: "other-org-conn",
              config: { url: "encrypted:postgresql://user:pass@host/db" },
              status: "published",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn", "PUT", {
          description: "Updated by platform admin",
        }),
      );

      expect(res.status).toBe(200);

      // The PUT load query must filter by workspace_id (composite scoping).
      const selectCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.putLoad(sql),
      );
      expect(selectCall).toBeDefined();
      expect(selectCall![0]).toContain("wp.workspace_id");
    });

    it("delete scopes by active workspace even for platform admin", async () => {
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.deleteLoad(sql)) return Promise.resolve([{ catalog_slug: "postgres" }]);
        if (sqlIs.schedRefs(sql)) return Promise.resolve([{ count: "0" }]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSoftArchive(sql)) {
          return Promise.resolve([{ id: "cn_org-alpha_other-org-conn" }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn", "DELETE"),
      );

      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Soft-archive UPDATE must scope by workspace_id (composite PK).
      const archiveCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerSoftArchive(sql),
      );
      expect(archiveCall).toBeDefined();
      expect(archiveCall![0]).toContain("workspace_id");
    });
  });

  // ─── 5. getVisibleConnectionIds + GET /:id detail correctness ────────

  describe("getVisibleConnectionIds — via list/detail endpoint behavior", () => {
    it("falls back to 'default' when the workspace owns no installs", async () => {
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toContain("default");
    });

    it("self-hosted (explicit deployMode) still surfaces 'default' when org owns no rows (#2483)", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["default"]);
    });

    it("SaaS suppresses the 'default' fallback for a fresh-signup workspace (#2483)", async () => {
      // Smoking gun: a freshly-signed-up workspace has zero workspace_plugins
      // rows. The runtime registry has `default` bound to the shared
      // ATLAS_DATASOURCE_URL demo. Without the SaaS gate, that demo would
      // surface as "your default Atlas connection" in every fresh-signup
      // workspace — tenant-isolation smell + chat-routing risk.
      mockConfigOverride = { deployMode: "saas" };
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).not.toContain("default");
      expect(ids).toEqual([]);
    });

    it("SaaS gate is orthogonal to owned rows — owned installs still surface on SaaS (#2483)", async () => {
      // Closes the gate × owned-rows matrix. Guards against an inverted-
      // boolean regression (e.g. `if (visible.size === 0 || !isSaas)`) that
      // would accidentally drop owned rows on SaaS.
      mockConfigOverride = { deployMode: "saas" };
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([{ install_id: "warehouse", group_id: null }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["warehouse"]);
    });

    it("suppresses 'default' once the workspace has its own installs", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([{ install_id: "warehouse", group_id: null }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["warehouse"]);
    });

    it("scopes platform admin to active workspace's installs (no bypass)", async () => {
      setPlatformAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.decoration(sql)) {
          return Promise.resolve([{ install_id: "warehouse", group_id: null }]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      const ids = body.connections.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["warehouse"]);
    });

    it("get-by-id returns 404 for an install not visible to workspace", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/other-org-conn"),
      );

      expect(res.status).toBe(404);
    });

    it("get-by-id succeeds for an install visible to workspace", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.detail(sql)) {
          return Promise.resolve([
            {
              config: { url: "encrypted:postgresql://user:pass@host/db" },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: null,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections/warehouse"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("warehouse");
      expect(body.managed).toBe(true);
      expect(body.groupId).toBeNull();
      expect(body.groupName).toBeNull();
    });

    it("#3866 — get-by-id resolves a plugin datasource, not just native pools", async () => {
      // A published plugin datasource (clickhouse-staging) registers ONLY in the
      // per-workspace plugin map — present in describeForWorkspace, absent from
      // the bare `has()`/`describe()`/`list()`. The detail route gated existence
      // on `connections.has(id)` (core registry), so it 404'd every plugin
      // datasource → the admin "Edit" dialog could never load its details
      // ("Failed to load connection details: HTTP 404"). It must gate on the
      // workspace-scoped describe, mirroring the list (#3844) and /test (#3853)
      // endpoints; the `visible` set remains the authorization gate.
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "clickhouse-staging" }]);
        if (sqlIs.detail(sql)) {
          return Promise.resolve([
            {
              config: { url: "encrypted:clickhouse://user:pass@host:8123/db" },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: "clickhouse",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections/clickhouse-staging"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("clickhouse-staging");
      // dbType comes from describeForWorkspace meta (the plugin pool), proving the
      // route resolved the per-workspace registry rather than the bare describe().
      expect(body.dbType).toBe("clickhouse");
      expect(body.managed).toBe(true);
      expect(body.groupId).toBe("clickhouse");
      expect(body.groupName).toBe("clickhouse");
    });

    it("get-by-id surfaces groupId + groupName when config carries group_id", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.visibility(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.detail(sql)) {
          return Promise.resolve([
            {
              config: { url: "encrypted:postgresql://user:pass@host/db" },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: "warehouse-env",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/connections/warehouse"));
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("warehouse-env");
      // Post-cutover groupName mirrors groupId verbatim — `connection_groups.name`
      // is gone, a string IS a name now.
      expect(body.groupName).toBe("warehouse-env");
    });
  });

  // ─── GET /connections — mode-aware status clause (#1427 / #1455) ─────

  describe("GET /connections — mode-aware status filter", () => {
    function findVisibilityCall(): [string, unknown[]] | undefined {
      const call = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.visibility(sql),
      );
      return call as [string, unknown[]] | undefined;
    }

    it("published mode restricts visible installs to status = 'published'", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
      expect(res.status).toBe(200);

      const call = findVisibilityCall();
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

      const call = findVisibilityCall();
      expect(call).toBeDefined();
      expect(call![0]).toContain("status IN ('published', 'draft')");
      expect(call![0]).not.toContain("status = 'published'");
      // Archived rows are excluded in both modes — the readFilter never
      // surfaces 'archived' in normal reads.
      expect(call![0]).not.toContain("'archived'");
    });
  });

  // ─── Write-path mode-awareness (#1428 / #2177) ────────────────────────

  describe("POST /connections — always stamps status='draft' (#2177)", () => {
    beforeEach(() => {
      setOrgAdmin("org-alpha");
    });

    it("published mode (default) inserts status='draft'", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSingleton(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
        }),
      );
      expect(res.status).toBe(201);
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(insertCall).toBeDefined();
      // Installer params: [rowId, workspaceId, catalogId, installId, config, status]
      expect((insertCall![1] as unknown[])[5]).toBe("draft");
    });

    it("developer mode also inserts status='draft' (header is irrelevant for POST)", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSingleton(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });
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
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(insertCall).toBeDefined();
      expect((insertCall![1] as unknown[])[5]).toBe("draft");
    });

    it("revives an archived row via updateDatasourceConfig (not installDatasource) when PK collides", async () => {
      // After a DELETE archives an install, the (workspace_id, catalog_id,
      // install_id) row remains with `status='archived'`. Recreating with
      // the same install_id must revive via UPDATE rather than 409 — the
      // archive-aware existing check at the route layer routes the call
      // through `updateDatasourceConfig` with `status: 'draft'`.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([{ status: "archived" }]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_analytics",
              install_id: "analytics",
              config: { url: "encrypted:postgresql://old" },
              status: "archived",
            },
          ]);
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

      // The revival path must use UPDATE (not INSERT) — the PK row exists.
      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeDefined();
      // Update params: [config, status, workspaceId, catalogId, installId]
      const updateParams = updateCall![1] as unknown[];
      expect(updateParams[1]).toBe("draft");  // revives to draft per #2177
      expect(updateParams[2]).toBe("org-alpha");
      expect(updateParams[4]).toBe("analytics");

      const staleInsert = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(staleInsert).toBeUndefined();
    });

    it("non-demo PUT in developer mode is immediate direct UPDATE (not staged)", async () => {
      // AC: connection edits are immediate per PRD — even in developer mode.
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.putLoad(sql)) {
          return Promise.resolve([
            {
              catalog_slug: "postgres",
              config: { url: "encrypted:postgresql://user:pass@host/db" },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: null,
            },
          ]);
        }
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_warehouse",
              install_id: "warehouse",
              config: { url: "encrypted:postgresql://user:pass@host/db" },
              status: "published",
            },
          ]);
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
      // Verify we ran UPDATE — not an INSERT (draft-copy semantics would
      // be wrong for connections; the connection IS the working copy).
      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeDefined();
      const staleInsert = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(staleInsert).toBeUndefined();
    });

    it("returns 409 when PK collides with a non-archived row", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([{ status: "published" }]);
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
      // Pre-#2177 this 403'd in published mode. Post-#2177 every write is
      // a draft regardless of mode, so the demo carve-out is gone. The
      // workspace_id filter on the load query then returns no row (this
      // workspace doesn't own a `__demo__` install in our fixture), so the
      // response is 404 — the point is: NOT 403.
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockResolvedValue([]);
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/__demo__", "PUT", { description: "tampered" }),
      );
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

  describe("DELETE /connections — soft archive via installer", () => {
    it("soft-archives via the installer (status='archived') instead of hard delete", async () => {
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.deleteLoad(sql)) return Promise.resolve([{ catalog_slug: "postgres" }]);
        if (sqlIs.schedRefs(sql)) return Promise.resolve([{ count: "0" }]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSoftArchive(sql)) {
          return Promise.resolve([{ id: "cn_org-alpha_warehouse" }]);
        }
        return Promise.resolve([]);
      });
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "DELETE"),
      );
      expect(res.status).toBe(200);
      const archiveCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerSoftArchive(sql),
      );
      expect(archiveCall).toBeDefined();
      const hardDelete = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("DELETE FROM workspace_plugins") &&
          sql.includes("install_id"),
      );
      expect(hardDelete).toBeUndefined();
    });

    it("DELETE on workspace-owned __demo__ soft-archives in place (per-workspace ownership)", async () => {
      // Post-cutover each workspace owns its own `__demo__` install
      // outright (migration 0094 backfilled per-workspace rows; the global
      // shadow is gone). DELETE on it follows the same soft-archive path
      // as any other install — no per-org tombstone INSERT exists anymore.
      setOrgAdmin("org-alpha");
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.deleteLoad(sql)) return Promise.resolve([{ catalog_slug: "demo-postgres" }]);
        if (sqlIs.schedRefs(sql)) return Promise.resolve([{ count: "0" }]);
        if (sqlIs.catalogLookup(sql)) {
          return Promise.resolve([{ ...POSTGRES_CATALOG_ROW, slug: "demo-postgres" }]);
        }
        if (sqlIs.installerSoftArchive(sql)) {
          return Promise.resolve([{ id: "cn_org-alpha___demo__" }]);
        }
        return Promise.resolve([]);
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
        ([sql]) => typeof sql === "string" && sqlIs.installerSoftArchive(sql),
      );
      expect(archiveCall).toBeDefined();
    });
  });

  // ─── F-44 regression — response bodies scrub DSN userinfo ────────────
  //
  // The test-connection + create-connection + update-connection endpoints
  // used to interpolate raw `err.message` into the 400/500 response body
  // on driver failure. pg / mysql2 sometimes echo the full DSN into
  // `err.message` (`connect ECONNREFUSED for postgres://user:pass@host`),
  // leaking the password to whatever consumed the response. Log lines are
  // scrubbed by the pino serializer; the HTTP body needs the same.

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

    it("POST /test 4xx/5xx never echoes DSN userinfo", async () => {
      const res = await app.fetch(
        adminRequest(
          "/api/v1/admin/connections/test",
          "POST",
          { url: "postgres://admin:hunter2@db.example.com/invalid" },
        ),
      );

      const raw = await res.text();
      if (res.status >= 400) {
        expect(raw).not.toContain("hunter2");
      }
    });
  });

  // ─── #2484 — Add Connection Env Field (post-cutover JSONB group_id) ──
  //
  // Post-#2744 a connection's env is a JSONB string under
  // `config->>'group_id'`. The `connection_groups` table is gone, so a
  // "name" and an "id" are the same string. The route's POST/PUT carry
  // the same `connectionGroupId` / `newGroupName` API on the wire, but
  // the writes flow through `WorkspaceInstaller.installDatasource` /
  // `updateDatasourceConfig` which write the JSONB key. Cross-workspace
  // `connectionGroupId` still rejects with 404 — same B2B isolation
  // guarantee.

  describe("POST /connections — env field (#2484, post-cutover)", () => {
    beforeEach(() => {
      setOrgAdmin("org-alpha");
    });

    it("attach to existing env: installer receives groupId on installDatasource", async () => {
      // Cross-org check returns a row → the workspace already has at least
      // one install in the "prod" env, so the attach is legal.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.groupExists(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSingleton(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          connectionGroupId: "prod",
        }),
      );

      expect(res.status).toBe(201);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("prod");

      // The installer's INSERT must carry the config JSONB with group_id.
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(insertCall).toBeDefined();
      const configJson = (insertCall![1] as unknown[])[4] as string;
      expect(JSON.parse(configJson)).toMatchObject({ group_id: "prod" });
    });

    it("inline-create env: newGroupName becomes the config.group_id verbatim", async () => {
      // The legacy CTE that inserted a `connection_groups` row + set
      // `primary_connection_id` is gone — `newGroupName` is just a string
      // written into the JSONB `config->>'group_id'`. The locked decision
      // (#2744) is that group "names" and "ids" are the same thing now.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSingleton(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          newGroupName: "Production",
        }),
      );

      expect(res.status).toBe(201);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("Production");

      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(insertCall).toBeDefined();
      const configJson = (insertCall![1] as unknown[])[4] as string;
      expect(JSON.parse(configJson)).toMatchObject({ group_id: "Production" });
    });

    it("ungrouped (no env field): config carries no group_id key", async () => {
      // Post-cutover the auto-`g_<id>` self-singleton group is gone. An
      // ungrouped install means `config.group_id` is absent (encryption
      // walker skips a missing key cleanly).
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerSingleton(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
        }),
      );

      expect(res.status).toBe(201);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBeNull();

      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(insertCall).toBeDefined();
      const configJson = (insertCall![1] as unknown[])[4] as string;
      const parsed = JSON.parse(configJson) as Record<string, unknown>;
      expect(parsed.group_id).toBeUndefined();
    });

    it("cross-workspace connectionGroupId: groupExists returns no rows → 404", async () => {
      // Foreign-workspace group_id values look identical to ids that don't
      // exist anywhere; the route's group-existence check (scoped to the
      // caller's workspace_id) returns empty → 404 either way. B2B
      // isolation guarantee — no information disclosure across workspaces.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.groupExists(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          connectionGroupId: "foreign",
        }),
      );

      expect(res.status).toBe(404);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_found");

      // No installer INSERT should have fired — pre-validation rejected.
      const insertCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerInsert(sql),
      );
      expect(insertCall).toBeUndefined();
    });

    it("both env fields together: 400 invalid_request (mutually exclusive)", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          connectionGroupId: "prod",
          newGroupName: "Production",
        }),
      );

      expect(res.status).toBe(400);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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

    it("revive archived row with newGroupName: updateDatasourceConfig carries group_id and status=draft", async () => {
      // The PK row exists (status='archived'); the route routes to
      // updateDatasourceConfig with status: 'draft', and the merged
      // config carries the new group_id key.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([{ status: "archived" }]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_analytics",
              install_id: "analytics",
              config: { url: "encrypted:postgresql://old" },
              status: "archived",
            },
          ]);
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

      expect(res.status).toBe(201);
      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeDefined();
      const updateParams = updateCall![1] as unknown[];
      expect(updateParams[1]).toBe("draft");
      const mergedConfig = JSON.parse(updateParams[0] as string) as Record<string, unknown>;
      expect(mergedConfig.group_id).toBe("Production");
    });

    it("revive archived row with connectionGroupId: updateDatasourceConfig carries the attached group_id", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.groupExists(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([{ status: "archived" }]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_analytics",
              install_id: "analytics",
              config: { url: "encrypted:postgresql://old" },
              status: "archived",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections", "POST", {
          id: "analytics",
          url: "postgresql://user:pass@host/db",
          connectionGroupId: "prod",
        }),
      );

      expect(res.status).toBe(201);
      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeDefined();
      const mergedConfig = JSON.parse((updateCall![1] as unknown[])[0] as string) as Record<string, unknown>;
      expect(mergedConfig.group_id).toBe("prod");
    });

    it("revive archived row with no env field: updateDatasourceConfig clears the existing group_id", async () => {
      // The route's POST `resolvedGroupId` defaults to `null` when no env
      // field is supplied; the installer's `patch.groupId === null` branch
      // then deletes the existing group_id key. So POST-revive without an
      // env field is an explicit "clear my env" intent at the wire level —
      // distinct from PUT, which uses `undefined` (no change) when no
      // env field is supplied. Documented here so an inverted-default
      // regression (e.g. switching POST to `undefined`) fails fast.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.planCount(sql)) return Promise.resolve([{ count: 0 }]);
        if (sqlIs.archiveCheck(sql)) return Promise.resolve([{ status: "archived" }]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_analytics",
              install_id: "analytics",
              config: {
                url: "encrypted:postgresql://old",
                group_id: "stale-env",
              },
              status: "archived",
            },
          ]);
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
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeDefined();
      const mergedConfig = JSON.parse((updateCall![1] as unknown[])[0] as string) as Record<string, unknown>;
      expect(mergedConfig.group_id).toBeUndefined();
    });
  });

  describe("PUT /connections/:id — env field (#2484, post-cutover)", () => {
    beforeEach(() => {
      setOrgAdmin("org-alpha");
    });

    it("reattach to existing env: installer merges group_id into config; response carries new groupId", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.putLoad(sql)) {
          return Promise.resolve([
            {
              catalog_slug: "postgres",
              config: {
                url: "encrypted:postgresql://old",
                group_id: "warehouse-env",
              },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: "warehouse-env",
            },
          ]);
        }
        if (sqlIs.groupExists(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_warehouse",
              install_id: "warehouse",
              config: {
                url: "encrypted:postgresql://old",
                group_id: "warehouse-env",
              },
              status: "published",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          connectionGroupId: "prod",
        }),
      );

      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("prod");

      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeDefined();
      const mergedConfig = JSON.parse((updateCall![1] as unknown[])[0] as string) as Record<string, unknown>;
      expect(mergedConfig.group_id).toBe("prod");
    });

    it("explicit ungroup (connectionGroupId: null): removes group_id from config", async () => {
      // Post-cutover ungroup means deleting the JSONB key — no auto self-
      // group reinstated, no CTE. The installer's `patch.groupId === null`
      // branch handles the `delete merged.group_id` cleanup.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.putLoad(sql)) {
          return Promise.resolve([
            {
              catalog_slug: "postgres",
              config: {
                url: "encrypted:postgresql://old",
                group_id: "prod",
              },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: "prod",
            },
          ]);
        }
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_warehouse",
              install_id: "warehouse",
              config: {
                url: "encrypted:postgresql://old",
                group_id: "prod",
              },
              status: "published",
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBeNull();

      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeDefined();
      const mergedConfig = JSON.parse((updateCall![1] as unknown[])[0] as string) as Record<string, unknown>;
      expect(mergedConfig.group_id).toBeUndefined();
    });

    it("inline-create on edit: newGroupName becomes the new config.group_id verbatim", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.putLoad(sql)) {
          return Promise.resolve([
            {
              catalog_slug: "postgres",
              config: { url: "encrypted:postgresql://old" },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: null,
            },
          ]);
        }
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([POSTGRES_CATALOG_ROW]);
        if (sqlIs.installerLoadForUpdate(sql)) {
          return Promise.resolve([
            {
              id: "cn_org-alpha_warehouse",
              install_id: "warehouse",
              config: { url: "encrypted:postgresql://old" },
              status: "published",
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.groupId).toBe("Production");

      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeDefined();
      const mergedConfig = JSON.parse((updateCall![1] as unknown[])[0] as string) as Record<string, unknown>;
      expect(mergedConfig.group_id).toBe("Production");
    });

    it("cross-workspace connectionGroupId on edit: 404 before any UPDATE fires", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.putLoad(sql)) {
          return Promise.resolve([
            {
              catalog_slug: "postgres",
              config: { url: "encrypted:postgresql://old" },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: null,
            },
          ]);
        }
        // groupExists → empty (foreign-workspace id)
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          connectionGroupId: "foreign",
        }),
      );

      expect(res.status).toBe(404);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_found");

      const updateCall = mocks.mockInternalQuery.mock.calls.find(
        ([sql]) => typeof sql === "string" && sqlIs.installerUpdate(sql),
      );
      expect(updateCall).toBeUndefined();
    });

    it("installer tagged error on env reassign: registry rolls back to previous URL", async () => {
      // Asserts the registry-rollback contract: when the installer returns
      // a tagged InstallError (e.g. ConfigSchemaError because the merged
      // config violates the catalog schema), the route's rollback fires
      // and re-registers the previous URL. A regression that drops the
      // `register(id, { url: currentUrl, ... })` from the error branch
      // would silently strand the registry on the new URL while the DB
      // carries the old one — the agent would query the wrong DB.
      //
      // Tagged errors (not raw SQL defects) are the rollback trigger
      // post-cutover: the installer's UPDATE-throw path goes through
      // `Effect.die` and surfaces as a 500 defect that bypasses
      // `result.kind === "error"`. The route's rollback is the
      // `result.kind === "error"` branch.
      mockRegister.mockClear();

      // Note: stored `url` here is plaintext (no `enc:v1:` prefix) so the
      // real `decryptSecret` from `db/secret-encryption.ts` returns it
      // verbatim — the route's `currentUrl` then comes through clean for
      // the rollback-register assertion below. The factory's `db/internal`
      // mock overrides `encryptSecret`/`decryptSecret` there, but
      // `decryptSecretFields` imports from `db/secret-encryption` which is
      // intentionally left unmocked.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sqlIs.putLoad(sql)) {
          return Promise.resolve([
            {
              catalog_slug: "postgres",
              config: {
                url: "postgresql://old",
                description: "old desc",
                group_id: "warehouse-env",
              },
              config_schema: POSTGRES_CATALOG_ROW.config_schema,
              group_id: "warehouse-env",
            },
          ]);
        }
        if (sqlIs.groupExists(sql)) return Promise.resolve([{ install_id: "warehouse" }]);
        // Catalog lookup misses → installer fails with CatalogNotFoundError
        // (tagged, 404). The route's error branch then runs the rollback.
        if (sqlIs.catalogLookup(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
          url: "postgresql://new",
          connectionGroupId: "prod",
        }),
      );

      // CatalogNotFoundError → tagged InstallError → 404 → rollback path.
      expect(res.status).toBe(404);
      // register call sequence on a urlChanged + tagged-error path:
      //   1. register(id, { url: newUrl, ... })           — fresh URL for the test-connect
      //   2. register(id, { url: currentUrl, ... })       — rollback after installer rejects
      const registerCalls = mockRegister.mock.calls;
      expect(registerCalls.length).toBeGreaterThanOrEqual(2);
      const rollbackCall = registerCalls[registerCalls.length - 1] as Array<unknown>;
      const rollbackOpts = rollbackCall[1] as { url?: string };
      expect(rollbackOpts.url).toBe("postgresql://old");
    });
  });
});
