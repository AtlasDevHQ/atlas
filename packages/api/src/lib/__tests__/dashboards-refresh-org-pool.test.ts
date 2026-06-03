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

/**
 * Single query the post-#2744 `loadGroupSnapshot` expects: a SELECT against
 * `workspace_plugins` returning every install in the group, ordered by
 * `(installed_at ASC, install_id ASC)`. There's no separate
 * `primary_connection_id` lookup any more — the snapshot's
 * `primaryConnectionId` is always null and the resolver falls through to
 * the deterministic first-by-installed_at member.
 */
function groupSnapshotRows(memberIds: string[]): Array<{ rows: Record<string, unknown>[] }> {
  return [
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

  it("resolves the group's first member (deterministic by installed_at) when opening a scheduled refresh pool", async () => {
    // Post-#2744 there's no `primary_connection_id` — the resolver falls
    // through to the deterministic first-by-(installed_at, install_id)
    // member. Single-member group → `warehouse` is both first AND only.
    setResults(
      { rows: [dashboardRow("org-1")] },
      { rows: [cardRow("g-warehouse")] },
      ...groupSnapshotRows(["warehouse"]),
      { rows: [{ id: "card-1" }] },
      { rows: [] },
    );

    const result = await refreshDashboardCards("dash-1");

    expect(result).toEqual({ refreshed: 1, failed: 0, total: 1 });
    // Validation is workspace-scoped (#3109) so a shared install_id validates
    // against the dashboard workspace's dialect — matches the getForOrg routing.
    expect(mockValidateSQL).toHaveBeenCalledWith("SELECT 1 AS total", "warehouse", "org-1");
    expect(mockGetForOrg).toHaveBeenCalledWith("org-1", "warehouse");
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockGetDefault).not.toHaveBeenCalled();
    // Non-parameterized card → no bind values (#2267 added the optional 3rd arg).
    expect(mockOrgQuery).toHaveBeenCalledWith("SELECT 1 AS total", 30000, undefined);
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

  // #3138 — the scheduled-refresh path skips text / section-block cards (they
  // have no SQL): no validation, no datasource query, but still counted in
  // `total`. Same guard as the route-level bulk refresh.
  it("skips a text / section-block card — no validation, no query, still in total", async () => {
    const textCardRow = { ...cardRow(null), id: "card-text", position: 0, title: "Header", sql: "", content: "## Section" };
    setResults(
      { rows: [dashboardRow("org-1")] },
      { rows: [textCardRow, { ...cardRow(null), position: 1 }] },
      { rows: [{ id: "card-1" }] }, // refreshCard RETURNING (chart card only)
      { rows: [] }, // touch parent dashboard
    );

    const result = await refreshDashboardCards("dash-1");

    expect(result).toEqual({ refreshed: 1, failed: 0, total: 2 });
    // Only the chart card was validated + executed; the text card was skipped.
    expect(mockValidateSQL).toHaveBeenCalledTimes(1);
    expect(mockValidateSQL).toHaveBeenCalledWith("SELECT 1 AS total", undefined, "org-1");
    expect(mockOrgQuery).toHaveBeenCalledTimes(1);
  });
});
