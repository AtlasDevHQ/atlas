/**
 * executeSQL per-query GROUP target + reach bounding (ADR-0022, slice (a)
 * #3893). The keystone security change: the agent names which Connection
 * group a query runs against, validation uses THAT group's whitelist, and a
 * group outside the conversation's reach is rejected — a hard error, never a
 * silent re-route to another source (the #3867(b) fix at the execution
 * layer).
 *
 * The pure reach resolver (`resolveReach`/`isReachable`) runs for real here;
 * only the impure visible-groups lookup is mocked, so these assert real
 * end-to-end reach behavior. Prior art: `sql-org-routing.test.ts` harness +
 * `createConnectionMock`.
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Per-group whitelist: keyed by the resolved connection id so a query
// validated against group A's connection only sees group A's tables. ---
const GROUP_TABLES: Record<string, Set<string>> = {
  postgres: new Set(["companies"]),
  clickhouse: new Set(["events"]),
  // Members of the multi-member `postgres` group register the group's tables
  // under their own connection id too (the dual-key whitelist model).
  "pg-us": new Set(["companies"]),
  "pg-eu": new Set(["companies"]),
};
mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: (_orgId: string, connId: string) =>
    GROUP_TABLES[connId] ?? new Set<string>(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: (connId: string) => GROUP_TABLES[connId] ?? new Set<string>(),
  _resetWhitelists: () => {},
}));

// --- Visible groups for reach. Two reachable group-of-one datasources;
// "secret-db" is deliberately absent (out of reach). ---
let visibleGroups: Array<{ id: string; members: string[]; primary: string }>;
const mockLoadVisibleGroups: Mock<() => Promise<unknown>> = mock(async () => visibleGroups);
mock.module("@atlas/api/lib/group-reach/lookup", () => ({
  loadVisibleGroups: mockLoadVisibleGroups,
}));

// --- Connection registry: spy on getForWorkspace to assert the resolved
// member; query records calls so we can prove a rejected group never ran. ---
const mockQuery: Mock<() => Promise<unknown>> = mock(async () => ({
  columns: ["id"],
  rows: [{ id: 1 }],
}));
const mockDBConnection = { query: mockQuery, close: async () => {} };
const mockGetForWorkspace: Mock<(workspaceId: string, installId: string) => unknown> = mock(
  () => mockDBConnection,
);

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
      getDBType: () => "postgres" as const,
      isOrgPoolingEnabled: () => false,
      getForWorkspace: mockGetForWorkspace,
      // A per-workspace config backs the read → getForWorkspace(org, connId)
      // routes by the resolved member, letting us assert which one was used.
      hasForWorkspace: () => true,
      recordQuery: () => {},
      recordSuccess: () => {},
      recordError: () => {},
    },
  }),
);

let mockRequestContext: Record<string, unknown> | undefined;
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getRequestContext: () => mockRequestContext,
}));

mock.module("@atlas/api/lib/auth/audit", () => ({ logQueryAudit: () => {} }));
mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: /password|secret/i,
  maskConnectionUrl: (url: string) => url,
}));
mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_n: string, _a: unknown, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));
mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));
mock.module("@atlas/api/lib/config", () => ({ getConfig: () => ({}) }));
mock.module("@atlas/api/lib/rls", () => ({
  resolveRLSFilters: () => ({ groups: [] }),
  injectRLSConditions: (sql: string) => sql,
}));
mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (k: string) => (k === "ATLAS_ROW_LIMIT" ? "1000" : k === "ATLAS_QUERY_TIMEOUT" ? "30000" : undefined),
  getSettingAuto: (k: string) => (k === "ATLAS_ROW_LIMIT" ? "1000" : k === "ATLAS_QUERY_TIMEOUT" ? "30000" : undefined),
  getSettingLive: async (k: string) => (k === "ATLAS_ROW_LIMIT" ? "1000" : k === "ATLAS_QUERY_TIMEOUT" ? "30000" : undefined),
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));
mock.module("@atlas/api/lib/cache/index", () => ({
  cacheEnabled: () => false,
  getCache: () => ({ get: () => null, set: () => {} }),
  buildCacheKey: () => "",
  getDefaultTtl: () => 60000,
}));
mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_n: string, ctx: { sql: string }) => ctx.sql,
}));

const { executeSQL } = await import("@atlas/api/lib/tools/sql");

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

type ToolResult = { success: boolean; error?: string; [key: string]: unknown };
const executeTool = executeSQL.execute as unknown as (
  args: { sql: string; explanation: string; group?: string; connectionId?: string; scope?: string },
  ctx: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
) => Promise<ToolResult>;

const run = (args: { sql: string; explanation?: string; group?: string; connectionId?: string }) =>
  executeTool(
    { explanation: "test", ...args },
    { toolCallId: "tc", messages: [], abortSignal: undefined as unknown as AbortSignal },
  );

describe("executeSQL — per-query group target + reach bounding", () => {
  beforeEach(() => {
    mockRequestContext = { user: { id: "u1", activeOrganizationId: "org-1" } };
    visibleGroups = [
      { id: "postgres", members: ["postgres"], primary: "postgres" },
      { id: "clickhouse", members: ["clickhouse"], primary: "clickhouse" },
    ];
    mockQuery.mockClear();
    mockGetForWorkspace.mockClear();
    mockLoadVisibleGroups.mockClear();
  });

  it("runs a query against the agent-named reachable group's connection", async () => {
    const result = await run({ sql: "SELECT id FROM events", group: "clickhouse" });
    expect(result.success).toBe(true);
    // Resolved to clickhouse's connection — proven by the routed member id.
    expect(mockGetForWorkspace.mock.calls.length).toBe(1);
    expect((mockGetForWorkspace.mock.calls as unknown[][])[0]?.[1]).toBe("clickhouse");
    expect(mockQuery.mock.calls.length).toBe(1);
  });

  it("validates against THAT group's whitelist — a table from another group is rejected (unknown_entity)", async () => {
    // `companies` lives in the postgres group, not clickhouse. Targeting
    // clickhouse must validate against clickhouse's whitelist and reject it.
    const result = await run({ sql: "SELECT id FROM companies", group: "clickhouse" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not in the allowed list");
    // The wrong-group table is caught at validation — no query is executed.
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  it("accepts the same table when the correct group is targeted", async () => {
    const result = await run({ sql: "SELECT id FROM companies", group: "postgres" });
    expect(result.success).toBe(true);
    expect((mockGetForWorkspace.mock.calls as unknown[][])[0]?.[1]).toBe("postgres");
  });

  it("REJECTS an out-of-reach group — hard error, never re-routed to another source", async () => {
    const result = await run({ sql: "SELECT id FROM events", group: "secret-db" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not within this conversation's reach");
    expect(result.error).toContain("secret-db");
    // The crux of #3867(b): no connection was resolved, NO query ran. The
    // out-of-reach group is not silently swapped for a reachable one.
    expect(mockGetForWorkspace.mock.calls.length).toBe(0);
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  it("rejected error names the reachable groups so the agent can self-correct", async () => {
    const result = await run({ sql: "SELECT id FROM events", group: "secret-db" });
    expect(result.error).toContain("postgres");
    expect(result.error).toContain("clickhouse");
  });

  it("rejects a `group` when the workspace has no reachable groups", async () => {
    // No activeOrganizationId → loadVisibleGroups returns []; reach is empty,
    // so any named group is rejected (degenerate workspace rejects, never
    // silently falls through to the default connection).
    mockRequestContext = { user: { id: "u1" } };
    visibleGroups = [];
    const result = await run({ sql: "SELECT id FROM events", group: "postgres" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not within this conversation's reach");
    expect(result.error).toContain("none");
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  describe("multi-member group — member pinning via connectionId", () => {
    beforeEach(() => {
      // A real multi-member group (env replicas) plus a separate group.
      visibleGroups = [
        { id: "postgres", members: ["pg-eu", "pg-us"], primary: "pg-eu" },
        { id: "clickhouse", members: ["clickhouse"], primary: "clickhouse" },
      ];
    });

    it("targets the group's primary member when only `group` is given", async () => {
      const result = await run({ sql: "SELECT id FROM companies", group: "postgres" });
      expect(result.success).toBe(true);
      expect((mockGetForWorkspace.mock.calls as unknown[][])[0]?.[1]).toBe("pg-eu");
    });

    it("honors a `connectionId` that is a member of the targeted group (member pin)", async () => {
      const result = await run({ sql: "SELECT id FROM companies", group: "postgres", connectionId: "pg-us" });
      expect(result.success).toBe(true);
      expect((mockGetForWorkspace.mock.calls as unknown[][])[0]?.[1]).toBe("pg-us");
    });

    it("IGNORES a foreign `connectionId` (member of another group) — falls back to primary, no cross-group escape", async () => {
      // `clickhouse` is a member of a DIFFERENT group; pairing it with
      // group=postgres must NOT execute against clickhouse — it falls back to
      // postgres's primary. This is the cross-group-escape guard.
      const result = await run({ sql: "SELECT id FROM companies", group: "postgres", connectionId: "clickhouse" });
      expect(result.success).toBe(true);
      const routedTo = (mockGetForWorkspace.mock.calls as unknown[][])[0]?.[1];
      expect(routedTo).toBe("pg-eu");
      expect(routedTo).not.toBe("clickhouse");
    });

    it("rejects a `group` that names a MEMBER id, not the canonical group", async () => {
      // `pg-us` is a member of `postgres`, not a group of its own. Naming it
      // as `group` is out of reach (reach is a group axis) → hard reject.
      const result = await run({ sql: "SELECT id FROM companies", group: "pg-us" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not within this conversation's reach");
      expect(mockQuery.mock.calls.length).toBe(0);
    });
  });

  it("omitting `group` keeps legacy single-connection behavior — no reach lookup", async () => {
    // The chat route stamps the conversation's connection into RequestContext;
    // omitting `group` binds to it exactly as before this slice.
    mockRequestContext = { user: { id: "u1", activeOrganizationId: "org-1" }, connectionId: "postgres" };
    const result = await run({ sql: "SELECT id FROM companies" });
    expect(result.success).toBe(true);
    // Under All-sources reach with no named group, the degenerate
    // single-reachable case stays on the fast path: no visible-groups
    // enumeration, runs against the stamped connection.
    expect(mockLoadVisibleGroups.mock.calls.length).toBe(0);
    expect((mockGetForWorkspace.mock.calls as unknown[][])[0]?.[1]).toBe("postgres");
  });

  // #3895 (ADR-0022 slice (c)) — the conversation's persisted Group reach
  // (stamped into RequestContext.groupReach by the chat route) now bounds
  // executeSQL. Under Focus → X, only X is reachable even though other groups
  // are visible; the omitted-group default binds to X (never a stale member
  // outside it). Rejection-path assertions (no query runs) exercise the bound.
  describe("Focus reach — conversation groupReach bounds executeSQL (#3895)", () => {
    it("REJECTS a query to a different VISIBLE group when the conversation is Focused — only the focused group is reachable", async () => {
      // postgres + clickhouse are both visible workspace groups, but the
      // conversation is Focused on postgres → clickhouse is out of reach. Hard
      // reject, never a silent re-route (the #3867(b) fix, now Focus-driven).
      mockRequestContext = {
        user: { id: "u1", activeOrganizationId: "org-1" },
        groupReach: "postgres",
      };
      const result = await run({ sql: "SELECT id FROM events", group: "clickhouse" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not within this conversation's reach");
      expect(mockQuery.mock.calls.length).toBe(0);
    });

    it("rejects an omitted-group query when Focused on a group that is no longer visible — no substitution", async () => {
      // group_reach points at a group content-mode has since hidden / removed.
      // Reach resolves to empty; the agent omits `group` → we must NOT fall back
      // to a default connection outside the (now-invisible) focus.
      mockRequestContext = {
        user: { id: "u1", activeOrganizationId: "org-1" },
        connectionId: "postgres",
        groupReach: "gone",
      };
      const result = await run({ sql: "SELECT id FROM companies" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("focused on group");
      expect(mockGetForWorkspace.mock.calls.length).toBe(0);
      expect(mockQuery.mock.calls.length).toBe(0);
    });

    it("binds an omitted-group query to the focused group's member (no `group` arg needed under Focus)", async () => {
      // Focused on clickhouse, agent omits `group` → execution binds to
      // clickhouse's member, not the stamped/default connection.
      mockRequestContext = {
        user: { id: "u1", activeOrganizationId: "org-1" },
        connectionId: "postgres",
        groupReach: "clickhouse",
      };
      const result = await run({ sql: "SELECT id FROM events" });
      expect(result.success).toBe(true);
      expect((mockGetForWorkspace.mock.calls as unknown[][])[0]?.[1]).toBe("clickhouse");
    });
  });
});
