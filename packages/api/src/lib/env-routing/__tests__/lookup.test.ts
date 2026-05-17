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

// Per-test mock state for the internal-DB module.
let mockHasInternalDB = true;
let mockConnRows: { group_id: string | null }[] = [];
let mockMemberRows: { id: string }[] = [];
let mockGroupRows: { primary_connection_id: string | null }[] = [];
let mockShouldThrow: Error | null = null;
let mockQueryCalls: { sql: string; params: unknown[] | undefined }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async (sql: string, params?: unknown[]) => {
    mockQueryCalls.push({ sql, params });
    if (mockShouldThrow) throw mockShouldThrow;
    // Step 1 fetches `group_id` from `connections`.
    if (sql.includes("FROM connections") && sql.includes("group_id") && !sql.includes("WHERE group_id")) {
      return mockConnRows;
    }
    // Step 2a fetches member ids.
    if (sql.includes("FROM connections") && sql.includes("WHERE group_id")) {
      return mockMemberRows;
    }
    // Step 2b fetches the group's primary.
    if (sql.includes("FROM connection_groups")) {
      return mockGroupRows;
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
    mockGroupRows = [];
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

describe("loadGroupRoutingContext — multi-member resolution", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockConnRows = [];
    mockMemberRows = [];
    mockGroupRows = [];
    mockShouldThrow = null;
    mockQueryCalls = [];
  });

  it("3-member group with explicit primary → returns all 3 + named primary", async () => {
    mockConnRows = [{ group_id: "g-prod" }];
    mockMemberRows = [{ id: "apac" }, { id: "eu" }, { id: "us-int" }];
    mockGroupRows = [{ primary_connection_id: "us-int" }];
    const ctx = await loadGroupRoutingContext("org-1", "eu");
    expect(ctx.groupId).toBe("g-prod");
    expect(ctx.members).toEqual(["apac", "eu", "us-int"]);
    expect(ctx.primaryMember).toBe("us-int");
    expect(ctx.currentMember).toBe("eu");
  });

  it("primary_connection_id NOT in members (stale FK) → first member becomes primary", async () => {
    mockConnRows = [{ group_id: "g-prod" }];
    mockMemberRows = [{ id: "apac" }, { id: "eu" }];
    mockGroupRows = [{ primary_connection_id: "us-int" }]; // not in members
    const ctx = await loadGroupRoutingContext("org-1", "eu");
    expect(ctx.primaryMember).toBe("apac"); // first member
  });

  it("group row missing (race with delete) → first member becomes primary", async () => {
    mockConnRows = [{ group_id: "g-prod" }];
    mockMemberRows = [{ id: "us-int" }, { id: "eu" }];
    mockGroupRows = []; // connection_groups deleted before lookup completed
    const ctx = await loadGroupRoutingContext("org-1", "eu");
    expect(ctx.members).toEqual(["us-int", "eu"]);
    expect(ctx.primaryMember).toBe("us-int");
  });

  it("step-2 returns empty members (paranoid) → fallback to currentConnectionId", async () => {
    mockConnRows = [{ group_id: "g-prod" }];
    mockMemberRows = []; // empty even though step 1 said grouped
    mockGroupRows = [{ primary_connection_id: "us-int" }];
    const ctx = await loadGroupRoutingContext("org-1", "eu");
    expect(ctx.members).toEqual(["eu"]);
    expect(ctx.primaryMember).toBe("eu"); // primaryFromGroup not in [], falls to currentMember
  });
});
