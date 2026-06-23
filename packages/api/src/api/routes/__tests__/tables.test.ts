/**
 * Unit tests for GET /api/v1/tables.
 *
 * Tests the route in isolation by mounting only the tables route on a minimal
 * Hono app. The focus is the #3898 fix: the advertised table set must match the
 * per-connection (group-scoped) whitelist that validate-sql / executeSQL
 * enforce, and an unknown connectionId must be a clear 404 — never a silent
 * fallback to the global/demo list.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import type { TableInfo } from "@useatlas/types";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mocks ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<AuthResult>> = mock(() =>
  Promise.resolve({ authenticated: true as const, mode: "none" as const, user: undefined }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

interface ReqCtx {
  requestId: string;
  user?: { activeOrganizationId?: string };
  atlasMode?: "published" | "developer";
}
const mockGetRequestContext: Mock<() => ReqCtx | undefined> = mock(() => undefined);

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: mockGetRequestContext,
    redactPaths: [],
  };
});

// discoverTables echoes the `allowed` set it received so tests can assert the
// route passed the correct per-connection whitelist (or none, when disabled).
// The real filtering behavior is covered in semantic-files-tables.test.ts.
const mockDiscoverTables: Mock<
  (root: string, allowed?: ReadonlySet<string>) => { tables: TableInfo[]; warnings: string[] }
> = mock((_root, allowed) => ({
  tables: allowed
    ? [...allowed].map((t) => ({ table: t, description: "", columns: [] }))
    : [{ table: "__all__", description: "", columns: [] }],
  warnings: [],
}));

mock.module("@atlas/api/lib/semantic/files", () => ({
  discoverTables: mockDiscoverTables,
  getSemanticRoot: () => "/semantic",
}));

const mockEnsureOrgModeSemanticRoot: Mock<(orgId: string, mode: string) => Promise<string>> = mock(
  async (orgId, mode) => `/semantic/.orgs/${orgId}/modes/${mode}`,
);

mock.module("@atlas/api/lib/semantic/sync", () => ({
  ensureOrgModeSemanticRoot: mockEnsureOrgModeSemanticRoot,
}));

const mockGetWhitelistedTables: Mock<(connectionId?: string) => Set<string>> = mock(
  () => new Set(["default_table"]),
);
const mockLoadOrgWhitelist: Mock<(orgId: string, mode?: string) => Promise<Map<string, Set<string>>>> = mock(
  async () => new Map(),
);
const mockGetOrgWhitelistedTables: Mock<
  (orgId: string, connectionId?: string, mode?: string) => Set<string>
> = mock(() => new Set(["org_table"]));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: mockGetWhitelistedTables,
  loadOrgWhitelist: mockLoadOrgWhitelist,
  getOrgWhitelistedTables: mockGetOrgWhitelistedTables,
}));

const mockGetSettingAuto: Mock<(key: string) => string | undefined> = mock(() => undefined);

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: mockGetSettingAuto,
}));

const mockGetDBType: Mock<(id: string, workspaceId?: string) => string> = mock(() => "postgres");

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      getDBType: mockGetDBType,
      get: mock(() => ({})),
      getDefault: mock(() => ({})),
      list: mock(() => ["default"]),
      getTargetHost: mock(() => null),
      getParserDialect: mock(() => null),
      getForbiddenPatterns: mock(() => []),
      getValidator: mock(() => null),
      getForOrg: () => ({}),
    },
    detectDBType: mock(() => "postgres"),
    getDB: mock(() => ({})),
    resolveDatasourceUrl: mock(() => "postgresql://test"),
  }),
);

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

// Import after mocks
const { Hono } = await import("hono");
const { tables: tablesRoute } = await import("../tables");
const { ConnectionNotRegisteredError } = await import("@atlas/api/lib/db/connection");

const app = new Hono();
app.route("/api/v1/tables", tablesRoute);

// --- Helpers ---

function makeRequest(query?: string): Request {
  const qs = query ? `?${query}` : "";
  return new Request(`http://localhost/api/v1/tables${qs}`, { method: "GET" });
}

async function tableNames(res: Response): Promise<string[]> {
  const body = (await res.json()) as { tables: Array<{ table: string }> };
  return body.tables.map((t) => t.table);
}

// --- Tests ---

describe("GET /api/v1/tables", () => {
  beforeEach(() => {
    mockGetRequestContext.mockReset();
    mockGetRequestContext.mockReturnValue(undefined);
    mockDiscoverTables.mockClear();
    mockEnsureOrgModeSemanticRoot.mockClear();
    mockGetWhitelistedTables.mockReset();
    mockGetWhitelistedTables.mockReturnValue(new Set(["default_table"]));
    mockLoadOrgWhitelist.mockClear();
    mockGetOrgWhitelistedTables.mockReset();
    mockGetOrgWhitelistedTables.mockReturnValue(new Set(["org_table"]));
    mockGetSettingAuto.mockReset();
    mockGetSettingAuto.mockReturnValue(undefined);
    mockGetDBType.mockReset();
    mockGetDBType.mockReturnValue("postgres");
  });

  it("self-hosted, no connectionId: scopes to the default-group whitelist", async () => {
    mockGetWhitelistedTables.mockReturnValue(new Set(["staging_products"]));

    const res = await app.fetch(makeRequest());
    expect(res.status).toBe(200);
    expect(await tableNames(res)).toEqual(["staging_products"]);
    // The default group is the lookup key, and the filter is applied.
    expect(mockGetWhitelistedTables).toHaveBeenCalledWith("default");
    const allowedArg = mockDiscoverTables.mock.calls[0][1];
    expect([...(allowedArg as Set<string>)]).toEqual(["staging_products"]);
  });

  it("self-hosted, connectionId: scopes to that connection's whitelist (not the global list)", async () => {
    mockGetWhitelistedTables.mockReturnValue(new Set(["payments"]));

    const res = await app.fetch(makeRequest("connectionId=clickhouse"));
    expect(res.status).toBe(200);
    expect(await tableNames(res)).toEqual(["payments"]);
    expect(mockGetDBType).toHaveBeenCalledWith("clickhouse", undefined);
    expect(mockGetWhitelistedTables).toHaveBeenCalledWith("clickhouse");
  });

  it("unknown connectionId is a clear 404, never a silent fallback to the global list", async () => {
    mockGetDBType.mockImplementation((id: string) => {
      throw new ConnectionNotRegisteredError({ message: `Connection "${id}" is not registered.`, id });
    });

    const res = await app.fetch(makeRequest("connectionId=nope"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("connection_not_found");
    expect(body.message).toBe('Connection "nope" is not registered.');
    // It must NOT have advertised any tables.
    expect(mockDiscoverTables).not.toHaveBeenCalled();
  });

  it("whitelist disabled: returns the unfiltered list (matches the enforcement layer allowing any table)", async () => {
    mockGetSettingAuto.mockImplementation((key: string) =>
      key === "ATLAS_TABLE_WHITELIST" ? "false" : undefined,
    );

    const res = await app.fetch(makeRequest("connectionId=clickhouse"));
    expect(res.status).toBe(200);
    // discoverTables called with NO allowed set → unfiltered.
    expect(mockDiscoverTables.mock.calls[0][1]).toBeUndefined();
    expect(await tableNames(res)).toEqual(["__all__"]);
    // The whitelist resolvers are not consulted when enforcement is disabled.
    expect(mockGetWhitelistedTables).not.toHaveBeenCalled();
  });

  it("SaaS (orgId present): reads the per-org whitelist + mode mirror", async () => {
    mockGetRequestContext.mockReturnValue({
      requestId: "r1",
      user: { activeOrganizationId: "org_42" },
      atlasMode: "developer",
    });
    mockGetOrgWhitelistedTables.mockReturnValue(new Set(["org_orders"]));

    const res = await app.fetch(makeRequest("connectionId=ch"));
    expect(res.status).toBe(200);
    expect(await tableNames(res)).toEqual(["org_orders"]);
    expect(mockGetDBType).toHaveBeenCalledWith("ch", "org_42");
    expect(mockLoadOrgWhitelist).toHaveBeenCalledWith("org_42", "developer");
    expect(mockGetOrgWhitelistedTables).toHaveBeenCalledWith("org_42", "ch", "developer");
    expect(mockEnsureOrgModeSemanticRoot).toHaveBeenCalledWith("org_42", "developer");
    // Self-hosted resolver is not used in org mode.
    expect(mockGetWhitelistedTables).not.toHaveBeenCalled();
  });

  it("SaaS without an explicit atlasMode defaults to published", async () => {
    mockGetRequestContext.mockReturnValue({
      requestId: "r2",
      user: { activeOrganizationId: "org_7" },
    });

    const res = await app.fetch(makeRequest());
    expect(res.status).toBe(200);
    expect(mockLoadOrgWhitelist).toHaveBeenCalledWith("org_7", "published");
    expect(mockGetOrgWhitelistedTables).toHaveBeenCalledWith("org_7", "default", "published");
    expect(mockEnsureOrgModeSemanticRoot).toHaveBeenCalledWith("org_7", "published");
  });

  it("empty whitelist yields an empty table list (deny-all, not the global list)", async () => {
    mockGetWhitelistedTables.mockReturnValue(new Set());

    const res = await app.fetch(makeRequest("connectionId=clickhouse"));
    expect(res.status).toBe(200);
    expect(await tableNames(res)).toEqual([]);
  });
});
