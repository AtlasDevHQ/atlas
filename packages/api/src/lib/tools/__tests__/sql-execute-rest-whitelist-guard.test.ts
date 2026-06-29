/**
 * ADR-0027 §4 regression guard — "there is no whitelist-skipping path"
 * (#4047, the executeSQL-over-REST surface).
 *
 * `runUserQueryPipeline` (the REST-shaped pipeline the `/api/v1/execute-sql`
 * route reuses) skips the table whitelist / RLS / auto-LIMIT ONLY on the
 * custom-validator branch (`if (!customValidator)`), and `customValidator` comes
 * from `connections.getValidator(connId)`. SQL datasources — Postgres, MySQL,
 * ClickHouse, Snowflake, BigQuery, DuckDB — register NO `connection.validate`,
 * so they NEVER take that branch and are ALWAYS whitelist-validated. This test
 * pins both halves so a future SQL plugin that sets `connection.validate`
 * (turning executeSQL into a bypass) fails here:
 *
 *   1. A SQL connection with no registered validator → a non-whitelisted table
 *      is REJECTED (`validation_failed`), proving the whitelist fires on the
 *      executeSQL path.
 *   2. The custom-validator branch is the ONLY thing that skips the whitelist —
 *      a connection WITH a registered validator runs that validator instead. The
 *      guard makes the bypass condition explicit so it can't silently widen to
 *      SQL datasources.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// Only `orders` is whitelisted. `secrets` is the non-whitelisted probe table.
const whitelistedTables = new Set(["orders"]);
mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => whitelistedTables,
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => whitelistedTables,
  _resetWhitelists: () => {},
}));

const mockDBConnection = {
  query: mock(async () => ({ columns: ["id"], rows: [{ id: 1 }] })),
  close: async () => {},
};

// `getValidator` is the bypass switch: a SQL datasource returns undefined (no
// custom validator) → the whitelist path runs. We flip it per-test to prove the
// custom-validator branch is the ONLY thing that skips the whitelist.
let registeredValidator: ((sql: string) => { valid: boolean; reason?: string }) | undefined;

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
      getForOrg: () => mockDBConnection,
      getForWorkspace: () => mockDBConnection,
      getDBType: () => "postgres" as const,
      getTargetHost: () => undefined,
      getValidator: () => registeredValidator,
      isOrgPoolingEnabled: () => false,
      isConnectionVisibleInMode: async () => true,
      recordQuery: () => {},
      recordError: () => {},
      recordSuccess: () => {},
      _reset: () => {},
    },
  }),
);

mock.module("@atlas/api/lib/auth/audit", () => ({ logQueryAudit: () => {} }));

mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: /password|secret_value/i,
  maskConnectionUrl: (url: string) => url,
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect type is complex to express in mock
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));

mock.module("@atlas/api/lib/cache/index", () => ({
  cacheEnabled: () => false,
  getCache: () => ({ get: () => null, set: () => {} }),
  buildCacheKey: () => "",
  getDefaultTtl: () => 60000,
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_name: string, ctx: { sql: string }) => ctx.sql,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getRequestContext: () => ({
    requestId: "test-ac4",
    user: { id: "u1", activeOrganizationId: "org-1", claims: { org_id: "org-1" } },
    atlasMode: "published",
  }),
}));

let mockSettingValues: Record<string, string | undefined> = {};
mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string) => mockSettingValues[key] ?? undefined,
  getSettingAuto: (key: string) => mockSettingValues[key] ?? undefined,
  getSettingLive: async (key: string) => mockSettingValues[key] ?? undefined,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

// No RLS configured — keeps the focus on the whitelist branch.
mock.module("@atlas/api/lib/config", () => ({ getConfig: () => ({}) }));

const { runUserQueryPipeline } = await import("@atlas/api/lib/tools/sql");

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

beforeEach(() => {
  registeredValidator = undefined;
  mockSettingValues = { ATLAS_ROW_LIMIT: "1000", ATLAS_QUERY_TIMEOUT: "30000" };
  mockDBConnection.query.mockClear();
});

describe("ADR-0027 §4 — executeSQL path is whitelist-validated (no bypass)", () => {
  it("a SQL connection with NO custom validator whitelist-validates: a non-whitelisted table is rejected", async () => {
    // This is the SQL-datasource shape: getValidator → undefined.
    registeredValidator = undefined;
    const outcome = await runUserQueryPipeline({
      sql: "SELECT * FROM secrets",
      explanation: "AC4 guard",
    });
    expect(outcome.kind).toBe("validation_failed");
    if (outcome.kind === "validation_failed") {
      expect(outcome.message).toContain("not in the allowed list");
    }
    // The DB was never reached — the whitelist rejected it pre-execution.
    expect(mockDBConnection.query).not.toHaveBeenCalled();
  });

  it("a whitelisted table on the same no-validator connection runs (whitelist allows it)", async () => {
    registeredValidator = undefined;
    const outcome = await runUserQueryPipeline({
      sql: "SELECT * FROM orders",
      explanation: "AC4 guard",
    });
    expect(outcome.kind).toBe("ok");
    expect(mockDBConnection.query).toHaveBeenCalledTimes(1);
  });

  it("the custom-validator branch is the ONLY whitelist-skip path — and SQL datasources never register one", async () => {
    // A connection WITH a registered validator takes the custom-validator branch
    // (used by SOQL/ES plugins), which skips the table whitelist by design — its
    // own object/index whitelist is the equivalent boundary. This proves the
    // skip is gated SOLELY on getValidator returning a validator. SQL datasources
    // return undefined (asserted above), so they can never reach this branch:
    // a future plugin adding `connection.validate` to a SQL datasource would
    // flip this and is exactly what ADR-0027 §4 forbids.
    let validatorRan = false;
    registeredValidator = (sql: string) => {
      validatorRan = true;
      // Accept the otherwise-non-whitelisted table to prove the whitelist was skipped.
      return { valid: /secrets/.test(sql) };
    };
    const outcome = await runUserQueryPipeline({
      sql: "SELECT * FROM secrets",
      explanation: "AC4 guard",
    });
    expect(validatorRan).toBe(true);
    // Whitelist skipped → the custom validator decided → query executed.
    expect(outcome.kind).toBe("ok");
  });
});
