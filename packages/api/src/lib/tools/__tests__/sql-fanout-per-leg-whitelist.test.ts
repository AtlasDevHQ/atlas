/**
 * Per-leg execution-target resolution in a cross-environment fanout
 * (SSOT refactor for #3961/#3947/#3109). Each fanout leg MUST resolve its OWN
 * `ExecutionTarget` from ITS connection id — never a single broadcast target
 * across legs. Concretely: under All-sources reach, the leg whose connection
 * id IS the conversation's own connection (`reqCtx.connectionId`) validates
 * against the WIDENED (`unpinned: true`) whitelist bucket, while every sibling
 * leg validates against its own PINNED (`unpinned: false`) bucket — exactly
 * the per-leg re-derivation `validateSQL` did inline before the SSOT extract.
 *
 * We spy on `getOrgWhitelistedTables` and capture the `(connId, unpinned)` pair
 * per leg; a shared broadcast target would make both legs carry the same
 * `unpinned`, which this test forbids.
 *
 * Harness: `sql-group-target.test.ts` mock scaffold + the group-routing lookup
 * mock from `sql-fanout-audit.test.ts` so `scope: "all"` fans out with no real
 * internal DB.
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// Capture every org-whitelist lookup: which connection bucket + widening flag.
const whitelistCalls: Array<{ connId: string; unpinned: boolean }> = [];
void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: (
    _orgId: string,
    connId: string,
    _mode: unknown,
    opts?: { readonly unpinned?: boolean },
  ) => {
    whitelistCalls.push({ connId, unpinned: opts?.unpinned === true });
    // Both legs must pass validation so both reach the whitelist lookup.
    return new Set(["orders"]);
  },
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

const mockQuery: Mock<() => Promise<unknown>> = mock(async () => ({
  columns: ["id"],
  rows: [{ id: 1 }],
}));
const mockDBConnection = { query: mockQuery, close: async () => {} };

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
      getForOrg: () => mockDBConnection,
      getForWorkspace: () => mockDBConnection,
      hasForWorkspace: () => false,
      getDBType: () => "postgres" as const,
      isOrgPoolingEnabled: () => false,
      getTargetHost: () => "localhost:5432",
      recordQuery: () => {},
      recordSuccess: () => {},
      recordError: () => {},
    },
  }),
);

let mockRequestContext: Record<string, unknown> | undefined;
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getRequestContext: () => mockRequestContext,
}));

// Two members so `scope: "all"` produces a real fanout.
void mock.module("@atlas/api/lib/env-routing/lookup", () => ({
  loadGroupRoutingContext: async (_orgId: string | undefined, currentMember: string) => ({
    groupId: "prod",
    members: ["us-int", "eu"] as const,
    primaryMember: "us-int",
    currentMember,
    degraded: false,
  }),
}));

void mock.module("@atlas/api/lib/auth/audit", () => ({ logQueryAudit: () => {} }));
void mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: /password|secret/i,
  maskConnectionUrl: (url: string) => url,
}));
void mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_n: string, _a: unknown, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));
void mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));
void mock.module("@atlas/api/lib/config", () => ({ getConfig: () => ({}) }));
void mock.module("@atlas/api/lib/rls", () => ({
  resolveRLSFilters: () => ({ groups: [] }),
  injectRLSConditions: (sql: string) => sql,
}));
void mock.module("@atlas/api/lib/settings", () => ({
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
void mock.module("@atlas/api/lib/cache/index", () => ({
  cacheEnabled: () => false,
  getCache: () => ({ get: () => null, set: () => {} }),
  buildCacheKey: () => "",
  getDefaultTtl: () => 60000,
}));
void mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_n: string, ctx: { sql: string }) => ctx.sql,
}));

const { executeSQL } = await import("@atlas/api/lib/tools/sql");

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

type ToolResult = { success: boolean; error?: string; [key: string]: unknown };
const executeTool = executeSQL.execute as unknown as (
  args: { sql: string; explanation: string; scope?: string; connectionId?: string },
  ctx: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
) => Promise<ToolResult>;

describe("executeSQL fanout — per-leg execution target (SSOT)", () => {
  beforeEach(() => {
    whitelistCalls.length = 0;
    mockQuery.mockClear();
    // All-sources reach (groupReach null) + the conversation's own connection
    // is `us-int` — so the `us-int` leg is the self leg, `eu` is a sibling.
    mockRequestContext = {
      user: { id: "u1", activeOrganizationId: "org-1" },
      connectionId: "us-int",
      groupReach: null,
    };
  });

  it("resolves each leg's whitelist bucket per-leg — self leg widens (unpinned), sibling does not", async () => {
    const result = await executeTool(
      { sql: "SELECT id FROM orders", explanation: "test", scope: "all" },
      { toolCallId: "tc", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result.success).toBe(true);

    // Both legs validated → both hit the whitelist lookup.
    const byConn = new Map(whitelistCalls.map((c) => [c.connId, c.unpinned]));
    expect(byConn.has("us-int")).toBe(true);
    expect(byConn.has("eu")).toBe(true);

    // The crux: the self leg (connId === reqCtx.connectionId) widens under
    // All-sources reach; the sibling leg stays pinned. A single broadcast
    // target would make these equal.
    expect(byConn.get("us-int")).toBe(true);
    expect(byConn.get("eu")).toBe(false);
    expect(byConn.get("us-int")).not.toBe(byConn.get("eu"));
  });
});
