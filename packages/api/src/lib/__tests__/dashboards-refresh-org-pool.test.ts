import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";

type QueryCall = { sql: string; params?: unknown[] };

const queryCalls: QueryCall[] = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryResultIndex = 0;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

const mockOrgQuery = mock(async () => ({ columns: ["total"], rows: [{ total: 1 }] }));
const mockGlobalQuery = mock(async () => ({ columns: ["total"], rows: [{ total: 2 }] }));
const mockGetForOrg: Mock<(orgId: string, connectionId?: string) => { query: typeof mockOrgQuery }> = mock(
  () => ({ query: mockOrgQuery }),
);
const mockGet: Mock<(connectionId: string) => { query: typeof mockGlobalQuery }> = mock(
  () => ({ query: mockGlobalQuery }),
);
const mockGetDefault: Mock<() => { query: typeof mockGlobalQuery }> = mock(
  () => ({ query: mockGlobalQuery }),
);
const mockValidateSQL = mock(async () => ({ valid: true as const }));

mock.module("@atlas/api/lib/db/connection", () => ({
  connections: {
    getForOrg: mockGetForOrg,
    get: mockGet,
    getDefault: mockGetDefault,
  },
}));

mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: mockValidateSQL,
}));

const { refreshDashboardCards } = await import("@atlas/api/lib/dashboards");

function dashboardRow(orgId: string | null): Record<string, unknown> {
  return {
    id: "dash-1",
    org_id: orgId,
    owner_id: "user-1",
    title: "Refresh me",
    description: null,
    share_token: null,
    share_expires_at: null,
    share_mode: "public",
    refresh_schedule: "*/5 * * * *",
    last_refresh_at: null,
    next_refresh_at: null,
    card_count: 1,
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
  };
}

function cardRow(connectionGroupId: string | null): Record<string, unknown> {
  return {
    id: "card-1",
    dashboard_id: "dash-1",
    position: 0,
    title: "Total",
    sql: "SELECT 1 AS total",
    chart_config: null,
    cached_columns: null,
    cached_rows: null,
    cached_at: null,
    connection_group_id: connectionGroupId,
    layout: null,
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
  };
}

/** Two rows the group snapshot loader expects: a primary lookup, then a member list. */
function groupSnapshotRows(primaryConnectionId: string, memberIds: string[]): Array<{ rows: Record<string, unknown>[] }> {
  return [
    { rows: [{ primary_connection_id: primaryConnectionId }] },
    {
      rows: memberIds.map((id, idx) => ({
        id,
        created_at: `2026-05-13T00:00:0${idx}.000Z`,
      })),
    },
  ];
}

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  queryResults = results;
  queryResultIndex = 0;
}

describe("refreshDashboardCards org-scoped pool selection", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    queryCalls.length = 0;
    queryResults = [];
    queryResultIndex = 0;
    mockOrgQuery.mockClear();
    mockGlobalQuery.mockClear();
    mockGetForOrg.mockClear();
    mockGet.mockClear();
    mockGetDefault.mockClear();
    mockValidateSQL.mockClear();
  });

  afterEach(() => {
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  it("resolves the group's primary member when opening a scheduled refresh pool", async () => {
    setResults(
      { rows: [dashboardRow("org-1")] },
      { rows: [cardRow("g-warehouse")] },
      ...groupSnapshotRows("warehouse", ["warehouse"]),
      { rows: [{ id: "card-1" }] },
      { rows: [] },
    );

    const result = await refreshDashboardCards("dash-1");

    expect(result).toEqual({ refreshed: 1, failed: 0, total: 1 });
    expect(mockValidateSQL).toHaveBeenCalledWith("SELECT 1 AS total", "warehouse");
    expect(mockGetForOrg).toHaveBeenCalledWith("org-1", "warehouse");
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockGetDefault).not.toHaveBeenCalled();
    expect(mockOrgQuery).toHaveBeenCalledWith("SELECT 1 AS total", 30000);
  });

  it("uses the org default pool for org-scoped cards without a connection group", async () => {
    setResults(
      { rows: [dashboardRow("org-1")] },
      { rows: [cardRow(null)] },
      { rows: [{ id: "card-1" }] },
      { rows: [] },
    );

    const result = await refreshDashboardCards("dash-1");

    expect(result).toEqual({ refreshed: 1, failed: 0, total: 1 });
    expect(mockGetForOrg).toHaveBeenCalledWith("org-1", undefined);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockGetDefault).not.toHaveBeenCalled();
  });
});
