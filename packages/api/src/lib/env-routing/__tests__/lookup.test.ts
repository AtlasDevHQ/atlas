/**
 * Unit tests for the impure `loadGroupRoutingContext` helper. The pure
 * `resolveRoutingPlan` module is covered exhaustively in `./index.test.ts`;
 * this file pins the lookup's failure-mode → 1×1-fallback semantics so
 * the routing module never sees an inconsistent input.
 *
 * `internalQuery` and `hasInternalDB` are mocked so the test exercises
 * the helper's branching without spinning up a real internal Postgres.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { REST_DATASOURCE_CATALOG_IDS } from "@atlas/api/lib/openapi/data-candidates";

// Per-test mock state for the internal-DB module.
let mockHasInternalDB = true;
let mockConnRows: { group_id: string | null }[] = [];
let mockMemberRows: { id: string }[] = [];
let mockShouldThrow: Error | null = null;
let mockQueryCalls: { sql: string; params: unknown[] | undefined }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async (sql: string, params?: unknown[]) => {
    mockQueryCalls.push({ sql, params });
    if (mockShouldThrow) throw mockShouldThrow;
    // Post-#2744 the helper hits `workspace_plugins` in two steps:
    //   1. Look up the install's `config->>'group_id'` (matched by install_id).
    //   2. Aggregate sibling installs sharing the same group_id.
    // The legacy `connection_groups` table (and its `primary_connection_id`
    // column) is gone — `members[0]` is the deterministic primary now.
    if (sql.includes("FROM workspace_plugins") && sql.includes("WHERE install_id = $1")) {
      return mockConnRows;
    }
    if (sql.includes("FROM workspace_plugins") && sql.includes("config->>'group_id' = $1")) {
      return mockMemberRows;
    }
    return [];
  },
}));

const { loadGroupRoutingContext } = await import("../lookup");

describe("loadGroupRoutingContext — 1×1 fallback paths", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockConnRows = [];
    mockMemberRows = [];
    mockShouldThrow = null;
    mockQueryCalls = [];
  });

  it("missing orgId → 1×1 fallback, no DB queries", async () => {
    const ctx = await loadGroupRoutingContext(undefined, "conn-a");
    expect(ctx).toEqual({
      members: ["conn-a"],
      primaryMember: "conn-a",
      currentMember: "conn-a",
    });
    expect(mockQueryCalls).toHaveLength(0);
  });

  it("internal DB not configured → 1×1 fallback, no DB queries", async () => {
    mockHasInternalDB = false;
    const ctx = await loadGroupRoutingContext("org-1", "conn-a");
    expect(ctx).toEqual({
      members: ["conn-a"],
      primaryMember: "conn-a",
      currentMember: "conn-a",
    });
    expect(mockQueryCalls).toHaveLength(0);
  });

  it("connection ungrouped (group_id IS NULL) → 1×1 fallback + warn log", async () => {
    mockConnRows = [{ group_id: null }];
    const ctx = await loadGroupRoutingContext("org-1", "conn-a");
    expect(ctx).toEqual({
      members: ["conn-a"],
      primaryMember: "conn-a",
      currentMember: "conn-a",
    });
    // The step-1 connection lookup ran but the step-2 queries didn't.
    expect(mockQueryCalls).toHaveLength(1);
  });

  it("connection not found (zero rows) → 1×1 fallback + suspect-grade warn", async () => {
    mockConnRows = [];
    const ctx = await loadGroupRoutingContext("org-1", "conn-archived");
    expect(ctx).toEqual({
      members: ["conn-archived"],
      primaryMember: "conn-archived",
      currentMember: "conn-archived",
    });
    expect(mockQueryCalls).toHaveLength(1);
  });

  it("internalQuery throws → 1×1 fallback (catch-and-warn)", async () => {
    mockShouldThrow = new Error("internal DB unreachable");
    const ctx = await loadGroupRoutingContext("org-1", "conn-a");
    expect(ctx.members).toEqual(["conn-a"]);
    expect(ctx.primaryMember).toBe("conn-a");
  });
});

describe("loadGroupRoutingContext — multi-member resolution (post-cutover)", () => {
  // Post-#2744 there's no explicit `primary_connection_id` — the primary
  // is always the first member returned by `ORDER BY install_id`. The
  // production SQL sorts alphabetically, so a deterministic mock fixture
  // matches that contract verbatim.
  beforeEach(() => {
    mockHasInternalDB = true;
    mockConnRows = [];
    mockMemberRows = [];
    mockShouldThrow = null;
    mockQueryCalls = [];
  });

  it("3-member group → returns all 3 with first-alphabetical as primary", async () => {
    mockConnRows = [{ group_id: "prod" }];
    // Mock returns rows in the SQL's ORDER BY install_id ordering.
    mockMemberRows = [{ id: "apac" }, { id: "eu" }, { id: "us-int" }];
    const ctx = await loadGroupRoutingContext("org-1", "eu");
    expect(ctx.groupId).toBe("prod");
    expect(ctx.members).toEqual(["apac", "eu", "us-int"]);
    expect(ctx.primaryMember).toBe("apac"); // first by install_id
    expect(ctx.currentMember).toBe("eu");
  });

  it("2-member group → first member is primary, currentMember reflects caller", async () => {
    mockConnRows = [{ group_id: "prod" }];
    mockMemberRows = [{ id: "us-int" }, { id: "eu" }];
    const ctx = await loadGroupRoutingContext("org-1", "eu");
    expect(ctx.members).toEqual(["us-int", "eu"]);
    expect(ctx.primaryMember).toBe("us-int");
  });

  it("step-2 returns empty members (paranoid: step 1 said grouped but row archived) → fallback to currentConnectionId", async () => {
    mockConnRows = [{ group_id: "prod" }];
    mockMemberRows = []; // empty even though step 1 said grouped
    const ctx = await loadGroupRoutingContext("org-1", "eu");
    expect(ctx.members).toEqual(["eu"]);
    expect(ctx.primaryMember).toBe("eu");
  });
});

describe("loadGroupRoutingContext — excludes REST datasource catalogs (#3044)", () => {
  // REST datasources share `pillar = 'datasource'` and CAN carry a
  // `config.group_id` (ADR-0010). Without the `catalog_id <> ALL(...)` guard a
  // REST install sharing a SQL group's id would be returned as a SQL "member"
  // and the agent's `scope: "all"` fanout would try to run SQL against a
  // connection that isn't in the registry. This pins the exclusion on BOTH
  // the install-anchor query and the member-aggregation query.
  beforeEach(() => {
    mockHasInternalDB = true;
    mockConnRows = [{ group_id: "prod" }];
    mockMemberRows = [{ id: "apac" }, { id: "eu" }];
    mockShouldThrow = null;
    mockQueryCalls = [];
  });

  it("passes the REST catalog-id array as the exclusion bind on both queries", async () => {
    await loadGroupRoutingContext("org-1", "eu");

    expect(mockQueryCalls).toHaveLength(2);
    for (const call of mockQueryCalls) {
      const flat = call.sql.replace(/\s+/g, " ");
      expect(flat).toContain("catalog_id <> ALL($3)");
      // The 3rd bind ($3) is the REST datasource catalog-id discriminator —
      // never client input, so a regression that drops it is a routing-pollution hole.
      expect(call.params?.[2]).toEqual([...REST_DATASOURCE_CATALOG_IDS]);
    }
  });
});
