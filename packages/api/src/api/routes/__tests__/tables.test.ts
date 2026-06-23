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

// resolveAllowedTables is the shared seam (also used by the schema diff) that
// returns the SAME whitelist set executeSQL enforces. The route's job is to
// call it with the right (groupKey, { orgId, atlasMode }) and feed the result
// to discoverTables — so the route test asserts that wiring; the org-vs-file
// resolution itself is covered in allowed-tables.test.ts.
const mockResolveAllowedTables: Mock<
  (connectionId: string, scope: { orgId?: string; atlasMode?: string }) => Promise<Set<string>>
> = mock(async () => new Set(["resolved_table"]));
// shouldUseOrgSemanticMirror gates the column source on the same predicate the
// whitelist resolution uses (org + internal DB). The route reads it through the
// allowed-tables module so the test never has to mock the heavy db/internal.
const mockShouldUseOrgSemanticMirror: Mock<(orgId: string | undefined) => boolean> = mock(() => false);

mock.module("@atlas/api/lib/semantic/allowed-tables", () => ({
  resolveAllowedTables: mockResolveAllowedTables,
  shouldUseOrgSemanticMirror: mockShouldUseOrgSemanticMirror,
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
    mockResolveAllowedTables.mockReset();
    mockResolveAllowedTables.mockResolvedValue(new Set(["resolved_table"]));
    mockShouldUseOrgSemanticMirror.mockReset();
    mockShouldUseOrgSemanticMirror.mockReturnValue(false);
    mockGetSettingAuto.mockReset();
    mockGetSettingAuto.mockReturnValue(undefined);
    mockGetDBType.mockReset();
    mockGetDBType.mockReturnValue("postgres");
  });

  it("self-hosted, no connectionId: scopes to the default-group whitelist", async () => {
    mockResolveAllowedTables.mockResolvedValue(new Set(["staging_products"]));

    const res = await app.fetch(makeRequest());
    expect(res.status).toBe(200);
    expect(await tableNames(res)).toEqual(["staging_products"]);
    // The default group is the lookup key, and the resolved set is the filter.
    expect(mockResolveAllowedTables).toHaveBeenCalledWith("default", { orgId: undefined, atlasMode: undefined });
    const allowedArg = mockDiscoverTables.mock.calls[0][1];
    expect([...(allowedArg as Set<string>)]).toEqual(["staging_products"]);
    // Self-hosted reads the base root, never the per-org mode mirror.
    expect(mockEnsureOrgModeSemanticRoot).not.toHaveBeenCalled();
  });

  it("self-hosted, connectionId: scopes to that connection's whitelist (not the global list)", async () => {
    mockResolveAllowedTables.mockResolvedValue(new Set(["payments"]));

    const res = await app.fetch(makeRequest("connectionId=clickhouse"));
    expect(res.status).toBe(200);
    expect(await tableNames(res)).toEqual(["payments"]);
    expect(mockGetDBType).toHaveBeenCalledWith("clickhouse", undefined);
    expect(mockResolveAllowedTables).toHaveBeenCalledWith("clickhouse", { orgId: undefined, atlasMode: undefined });
    expect(mockEnsureOrgModeSemanticRoot).not.toHaveBeenCalled();
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
    // It must NOT have advertised any tables OR even resolved a whitelist.
    expect(mockDiscoverTables).not.toHaveBeenCalled();
    expect(mockResolveAllowedTables).not.toHaveBeenCalled();
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
    // The whitelist is not resolved when enforcement is disabled.
    expect(mockResolveAllowedTables).not.toHaveBeenCalled();
  });

  it("SaaS (orgId present, internal DB): resolves the org whitelist + reads the mode mirror", async () => {
    mockGetRequestContext.mockReturnValue({
      requestId: "r1",
      user: { activeOrganizationId: "org_42" },
      atlasMode: "developer",
    });
    mockShouldUseOrgSemanticMirror.mockReturnValue(true);
    mockResolveAllowedTables.mockResolvedValue(new Set(["org_orders"]));

    const res = await app.fetch(makeRequest("connectionId=ch"));
    expect(res.status).toBe(200);
    expect(await tableNames(res)).toEqual(["org_orders"]);
    expect(mockGetDBType).toHaveBeenCalledWith("ch", "org_42");
    // Raw atlasMode is threaded — never defaulted — into the whitelist resolution.
    expect(mockResolveAllowedTables).toHaveBeenCalledWith("ch", { orgId: "org_42", atlasMode: "developer" });
    expect(mockEnsureOrgModeSemanticRoot).toHaveBeenCalledWith("org_42", "developer");
  });

  it("SaaS resolution threads a missing atlasMode as undefined (matching validateSQL), defaulting only the column mirror to published", async () => {
    mockGetRequestContext.mockReturnValue({
      requestId: "r2",
      user: { activeOrganizationId: "org_7" },
    });
    mockShouldUseOrgSemanticMirror.mockReturnValue(true);

    const res = await app.fetch(makeRequest());
    expect(res.status).toBe(200);
    // Whitelist resolution gets the RAW (undefined) mode — same as validateSQL,
    // so the advertised set can't diverge from the enforced one.
    expect(mockResolveAllowedTables).toHaveBeenCalledWith("default", { orgId: "org_7", atlasMode: undefined });
    // Only the column mirror needs a concrete mode; it defaults to published.
    expect(mockEnsureOrgModeSemanticRoot).toHaveBeenCalledWith("org_7", "published");
  });

  it("org without an internal DB falls back to the base root (mirrors resolveAllowedTables's file fallback)", async () => {
    mockGetRequestContext.mockReturnValue({
      requestId: "r3",
      user: { activeOrganizationId: "org_nodb" },
      atlasMode: "published",
    });
    mockShouldUseOrgSemanticMirror.mockReturnValue(false);

    const res = await app.fetch(makeRequest());
    expect(res.status).toBe(200);
    // No internal DB → no org mode mirror; columns come from the base root.
    expect(mockEnsureOrgModeSemanticRoot).not.toHaveBeenCalled();
  });

  it("empty whitelist yields an empty table list (deny-all, not the global list)", async () => {
    mockResolveAllowedTables.mockResolvedValue(new Set());

    const res = await app.fetch(makeRequest("connectionId=clickhouse"));
    expect(res.status).toBe(200);
    expect(await tableNames(res)).toEqual([]);
  });
});
