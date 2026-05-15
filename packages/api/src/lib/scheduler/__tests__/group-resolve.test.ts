import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import {
  NoScheduledTaskGroupMembersError,
  loadScheduledTaskGroupSnapshot,
  resolveScheduledTaskConnection,
  selectScheduledTaskGroupMember,
  type SchedulerGroupSnapshot,
} from "../group-resolve";

const MEMBERS = [
  { id: "us-int", createdAt: "2026-04-01T00:00:00Z" },
  { id: "eu", createdAt: "2026-04-15T00:00:00Z" },
  { id: "apac", createdAt: "2026-05-01T00:00:00Z" },
] as const;

describe("selectScheduledTaskGroupMember", () => {
  it("returns the primary member when it is still in the group", () => {
    const snap: SchedulerGroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: "eu",
      members: [...MEMBERS],
    };

    expect(selectScheduledTaskGroupMember(snap)).toBe("eu");
  });

  it("falls back to the first member by (created_at ASC, id ASC) when primary is missing", () => {
    const snap: SchedulerGroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: "ghost",
      members: [...MEMBERS],
    };

    expect(selectScheduledTaskGroupMember(snap)).toBe("us-int");
  });

  it("breaks fallback ties by id", () => {
    const snap: SchedulerGroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: null,
      members: [
        { id: "zeta", createdAt: "2026-04-01T00:00:00Z" },
        { id: "alpha", createdAt: "2026-04-01T00:00:00Z" },
      ],
    };

    expect(selectScheduledTaskGroupMember(snap)).toBe("alpha");
  });

  it("sorts Date-created members chronologically", () => {
    const snap: SchedulerGroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: null,
      members: [
        { id: "may", createdAt: new Date("2026-05-01T00:00:00Z") },
        { id: "apr", createdAt: new Date("2026-04-01T00:00:00Z") },
      ],
    };

    expect(selectScheduledTaskGroupMember(snap)).toBe("apr");
  });

  it("throws when the group has no members", () => {
    expect(() =>
      selectScheduledTaskGroupMember({
        groupId: "g_empty",
        orgId: "org-1",
        primaryConnectionId: null,
        members: [],
      }),
    ).toThrow(NoScheduledTaskGroupMembersError);
  });
});

// ── SQL-path coverage (#2416) ────────────────────────────────────────
//
// The in-memory picker tests above don't exercise loadScheduledTaskGroupSnapshot —
// the function that issues SQL through internalQuery. An earlier cross-org
// fallback widened the org filter to '__global__' when a tenant's group had
// zero non-archived members; no test caught it because callers mocked the
// SQL-touching function away. These tests run the real SQL builder against a
// captured mock pool so tenant isolation is asserted on actual SQL: NO
// __global__ parameter ever flows to the DB for a tenant caller, regardless
// of group/member state.

interface CapturedQuery {
  readonly sql: string;
  readonly params?: unknown[];
}

let queryCalls: CapturedQuery[] = [];
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

function enableInternalDB(): void {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>): void {
  queryResults = results;
  queryResultIndex = 0;
}

const origDbUrl = process.env.DATABASE_URL;

describe("loadScheduledTaskGroupSnapshot (SQL path)", () => {
  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  it("returns null when no internal DB is configured", async () => {
    const snap = await loadScheduledTaskGroupSnapshot("g_prod", "org-1");
    expect(snap).toBeNull();
    expect(queryCalls.length).toBe(0);
  });

  it("returns a snapshot with all non-archived members for a tenant group", async () => {
    enableInternalDB();
    setResults(
      { rows: [{ primary_connection_id: "us-int" }] },
      {
        rows: [
          { id: "us-int", created_at: "2026-04-01T00:00:00Z" },
          { id: "eu", created_at: "2026-04-15T00:00:00Z" },
        ],
      },
    );

    const snap = await loadScheduledTaskGroupSnapshot("g_prod", "org-1");
    expect(snap).not.toBeNull();
    expect(snap!.orgId).toBe("org-1");
    expect(snap!.primaryConnectionId).toBe("us-int");
    expect(snap!.members.map((m) => m.id)).toEqual(["us-int", "eu"]);

    // Every query must scope to the tenant org. NO __global__ widening.
    expect(queryCalls.length).toBe(2);
    for (const call of queryCalls) {
      expect(call.params).toContain("org-1");
      expect(call.params).not.toContain("__global__");
      expect(call.sql).not.toContain("'__global__'");
    }
  });

  it("returns an empty-members snapshot when a tenant's group has zero non-archived members — does NOT cross into __global__", async () => {
    enableInternalDB();
    setResults(
      { rows: [{ primary_connection_id: null }] },
      { rows: [] }, // every member archived in this tenant
    );

    const snap = await loadScheduledTaskGroupSnapshot("g_prod", "org-1");
    expect(snap).not.toBeNull();
    expect(snap!.orgId).toBe("org-1");
    expect(snap!.members).toEqual([]);

    // Tenant isolation check: exactly two scoped queries — no __global__ peek.
    expect(queryCalls.length).toBe(2);
    for (const call of queryCalls) {
      expect(call.params).not.toContain("__global__");
      expect(call.sql).not.toContain("'__global__'");
    }
  });

  it("selectScheduledTaskGroupMember on an empty-members snapshot throws NoScheduledTaskGroupMembersError", async () => {
    enableInternalDB();
    setResults(
      { rows: [{ primary_connection_id: null }] },
      { rows: [] },
    );

    const snap = await loadScheduledTaskGroupSnapshot("g_prod", "org-1");
    expect(snap).not.toBeNull();
    expect(() => selectScheduledTaskGroupMember(snap!)).toThrow(NoScheduledTaskGroupMembersError);
  });

  it("resolveScheduledTaskConnection throws NoScheduledTaskGroupMembersError when the tenant's group is empty (no __global__ peek)", async () => {
    enableInternalDB();
    setResults(
      { rows: [{ primary_connection_id: null }] },
      { rows: [] },
    );

    let captured: unknown = null;
    try {
      await resolveScheduledTaskConnection({
        taskId: "task-1",
        orgId: "org-1",
        connectionGroupId: "g_prod",
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(NoScheduledTaskGroupMembersError);
    expect(queryCalls.length).toBe(2);
    for (const call of queryCalls) {
      expect(call.params).not.toContain("__global__");
    }
  });

  it("falls back to first-member (created_at ASC, id ASC) when primary_connection_id is null — in-org fallback", async () => {
    enableInternalDB();
    setResults(
      { rows: [{ primary_connection_id: null }] },
      {
        rows: [
          { id: "us-int", created_at: "2026-04-01T00:00:00Z" },
          { id: "eu", created_at: "2026-04-15T00:00:00Z" },
        ],
      },
    );

    const resolved = await resolveScheduledTaskConnection({
      taskId: "task-1",
      orgId: "org-1",
      connectionGroupId: "g_prod",
    });
    expect(resolved).toBe("us-int");

    for (const call of queryCalls) {
      expect(call.params).toContain("org-1");
      expect(call.params).not.toContain("__global__");
    }
  });

  it("__global__ caller (orgId = null) reads __global__ group rows directly — the legitimate path", async () => {
    enableInternalDB();
    setResults(
      { rows: [{ primary_connection_id: "g-conn" }] },
      { rows: [{ id: "g-conn", created_at: "2026-04-01T00:00:00Z" }] },
    );

    const snap = await loadScheduledTaskGroupSnapshot("g_global", null);
    expect(snap).not.toBeNull();
    expect(snap!.orgId).toBeNull();
    expect(snap!.members.map((m) => m.id)).toEqual(["g-conn"]);
    expect(queryCalls.length).toBe(2);
    for (const call of queryCalls) {
      expect(call.params).toContain("__global__");
    }
  });

  it("__global__ caller passing the literal string is identical to passing null", async () => {
    // Production code coalesces orgId via `orgId ?? "__global__"`, so a
    // caller that already holds the literal "__global__" string flows through
    // the same SQL as a null caller. Asserting both shapes match prevents a
    // future refactor (e.g. replacing the ?? with a strict null check) from
    // silently splitting the global-org path in two.
    enableInternalDB();
    setResults(
      { rows: [{ primary_connection_id: "g-conn" }] },
      { rows: [{ id: "g-conn", created_at: "2026-04-01T00:00:00Z" }] },
    );

    const snap = await loadScheduledTaskGroupSnapshot("g_global", "__global__");
    expect(snap).not.toBeNull();
    expect(snap!.orgId).toBe("__global__");
    expect(snap!.members.map((m) => m.id)).toEqual(["g-conn"]);
    expect(queryCalls.length).toBe(2);
    for (const call of queryCalls) {
      expect(call.params).toContain("__global__");
    }
  });

  it("returns null when the group does not exist for this org — no cross-org peek", async () => {
    enableInternalDB();
    setResults({ rows: [] });

    const snap = await loadScheduledTaskGroupSnapshot("g_missing", "org-1");
    expect(snap).toBeNull();
    expect(queryCalls.length).toBe(1);
    expect(queryCalls[0].params).not.toContain("__global__");
  });
});
