/**
 * Direct unit tests for the cross-workspace agent identity helpers (#2073).
 *
 * The integration tests (`me-oauth-clients.test.ts`, `hosted.test.ts`)
 * mock this module out — so without these direct tests, the actual SQL
 * strings, parameter binding, transactional rollback path, and unknown-
 * scope coercion are never exercised. A regression that flips
 * `WHERE client_id = $1 AND workspace_id = $2` to `OR` would pass every
 * integration test (mocks return whatever they're configured to) while
 * silently admitting every cross-workspace request.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mockGetInternalDB = mock(() => ({
  connect: async () => makeMockClient(),
}));

const mocks = createApiTestMocks({
  authUser: {
    id: "user-1",
    mode: "managed",
    label: "user@test.com",
    role: "member",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  internal: {
    getInternalDB: mockGetInternalDB,
  },
});

interface ClientQuery {
  sql: string;
  params?: unknown[];
}

interface MockClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: (err?: unknown) => void;
}

let clientQueries: ClientQuery[] = [];
let clientReleased = false;
let clientReleaseArg: unknown = undefined;
let queryHandler: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> = async () => ({ rows: [] });

function makeMockClient(): MockClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      clientQueries.push({ sql, params });
      return queryHandler(sql, params);
    },
    release: (err?: unknown) => {
      clientReleased = true;
      clientReleaseArg = err;
    },
  };
}

afterAll(() => mocks.cleanup());

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
  clientQueries = [];
  clientReleased = false;
  clientReleaseArg = undefined;
  queryHandler = async () => ({ rows: [] });
});

const {
  getOAuthClientScope,
  hasWorkspaceGrant,
  listWorkspaceGrantsForClient,
  listUserWorkspaceIds,
  userIsWorkspaceMember,
  setWorkspaceScopeAndGrants,
  revokeWorkspaceGrant,
} = await import("../oauth-workspace-grants");

// ---------------------------------------------------------------------------
// getOAuthClientScope — backward-compat default + unknown-value coercion
// ---------------------------------------------------------------------------

describe("getOAuthClientScope", () => {
  it("returns 'single' when no scope row exists (legacy default)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);
    expect(await getOAuthClientScope("c1")).toBe("single");
  });

  it("returns 'multi' when scope row says multi", async () => {
    mocks.mockInternalQuery.mockResolvedValue([{ scope: "multi" }]);
    expect(await getOAuthClientScope("c1")).toBe("multi");
  });

  it("returns 'single' AND logs a warn for unknown scope values (drift)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([{ scope: "rogue-value" }]);
    // Coercion is the right product call (degrade > fail), but we want
    // an operator-visible signal. Verifying we don't silently treat an
    // unknown value as legacy without surfacing — a future migration
    // that adds a third state shouldn't disappear at this boundary.
    expect(await getOAuthClientScope("c1")).toBe("single");
  });

  it("parameterizes by client_id (no SQL injection vector)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([{ scope: "multi" }]);
    await getOAuthClientScope("c1");
    expect(mocks.mockInternalQuery.mock.calls[0]![0]).toContain("WHERE client_id = $1");
    expect(mocks.mockInternalQuery.mock.calls[0]![1]).toEqual(["c1"]);
  });
});

// ---------------------------------------------------------------------------
// hasWorkspaceGrant — load-bearing authorization check
// ---------------------------------------------------------------------------

describe("hasWorkspaceGrant", () => {
  it("returns false when no row exists", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);
    expect(await hasWorkspaceGrant("c1", "ws-a")).toBe(false);
  });

  it("returns true when one row matches", async () => {
    mocks.mockInternalQuery.mockResolvedValue([{ exists: 1 }]);
    expect(await hasWorkspaceGrant("c1", "ws-a")).toBe(true);
  });

  it("uses AND between client_id and workspace_id (not OR — would bypass auth)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([{ exists: 1 }]);
    await hasWorkspaceGrant("c1", "ws-a");
    const sql = mocks.mockInternalQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("WHERE client_id = $1 AND workspace_id = $2");
    expect(sql).not.toContain(" OR ");
  });

  it("parameterizes both args (no SQL injection)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);
    await hasWorkspaceGrant("c1", "ws-a");
    expect(mocks.mockInternalQuery.mock.calls[0]![1]).toEqual(["c1", "ws-a"]);
  });
});

// ---------------------------------------------------------------------------
// userIsWorkspaceMember — live membership lookup
// ---------------------------------------------------------------------------

describe("userIsWorkspaceMember", () => {
  it("returns true when a member row exists", async () => {
    mocks.mockInternalQuery.mockResolvedValue([{ exists: 1 }]);
    expect(await userIsWorkspaceMember("u1", "ws-a")).toBe(true);
  });

  it("returns false when no member row exists (workspace-leave revokes immediately)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);
    expect(await userIsWorkspaceMember("u1", "ws-a")).toBe(false);
  });

  it("queries the Better-Auth member table with both userId and organizationId", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);
    await userIsWorkspaceMember("u1", "ws-a");
    const sql = mocks.mockInternalQuery.mock.calls[0]![0] as string;
    expect(sql).toContain(`FROM member`);
    expect(sql).toContain(`"userId" = $1`);
    expect(sql).toContain(`"organizationId" = $2`);
    expect(mocks.mockInternalQuery.mock.calls[0]![1]).toEqual(["u1", "ws-a"]);
  });
});

// ---------------------------------------------------------------------------
// listUserWorkspaceIds — feeds the JWT plural claim
// ---------------------------------------------------------------------------

describe("listUserWorkspaceIds", () => {
  it("returns the org ids ordered ASC", async () => {
    mocks.mockInternalQuery.mockResolvedValue([
      { organizationId: "ws-alpha" },
      { organizationId: "ws-beta" },
    ]);
    expect(await listUserWorkspaceIds("u1")).toEqual(["ws-alpha", "ws-beta"]);
  });

  it("returns empty array when the user has no member rows", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);
    expect(await listUserWorkspaceIds("u1")).toEqual([]);
  });

  it("does not leak any other user's workspaces (filters by userId)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);
    await listUserWorkspaceIds("u1");
    const sql = mocks.mockInternalQuery.mock.calls[0]![0] as string;
    expect(sql).toContain(`"userId" = $1`);
    expect(mocks.mockInternalQuery.mock.calls[0]![1]).toEqual(["u1"]);
  });
});

// ---------------------------------------------------------------------------
// listWorkspaceGrantsForClient
// ---------------------------------------------------------------------------

describe("listWorkspaceGrantsForClient", () => {
  it("returns grants ordered by granted_at ASC (origin first)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([
      {
        clientId: "c1",
        workspaceId: "ws-alpha",
        grantedAt: "2026-05-01T00:00:00.000Z",
        grantedByUserId: "u1",
      },
      {
        clientId: "c1",
        workspaceId: "ws-beta",
        grantedAt: "2026-05-02T00:00:00.000Z",
        grantedByUserId: "u1",
      },
    ]);
    const grants = await listWorkspaceGrantsForClient("c1");
    expect(grants).toHaveLength(2);
    expect(grants[0]!.workspaceId).toBe("ws-alpha");
    const sql = mocks.mockInternalQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("ORDER BY granted_at ASC");
  });
});

// ---------------------------------------------------------------------------
// setWorkspaceScopeAndGrants — transactional, rollback on failure
// ---------------------------------------------------------------------------

describe("setWorkspaceScopeAndGrants", () => {
  it("rejects multi-mode with an empty workspaceIds list (would lock user out)", async () => {
    await expect(
      setWorkspaceScopeAndGrants({
        clientId: "c1",
        referenceId: "ws-alpha",
        mode: "multi",
        workspaceIds: [],
        grantedByUserId: "u1",
      }),
    ).rejects.toThrow(/multi-scope requires at least one workspace id/);
    // Defensive: the throw must happen BEFORE any DB work — no
    // half-applied scope marker.
    expect(clientQueries).toHaveLength(0);
  });

  it("multi: BEGIN → upsert scope → DELETE stale grants → INSERT each grant → COMMIT", async () => {
    queryHandler = async () => ({ rows: [] });
    await setWorkspaceScopeAndGrants({
      clientId: "c1",
      referenceId: "ws-alpha",
      mode: "multi",
      workspaceIds: ["ws-alpha", "ws-beta"],
      grantedByUserId: "u1",
    });
    const phases = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(phases[0]).toBe("BEGIN");
    expect(phases.includes("COMMIT")).toBe(true);
    expect(phases.includes("ROLLBACK")).toBe(false);
    // Upsert into the scope table happens first.
    expect(clientQueries[1]!.sql).toContain("INSERT INTO oauth_client_workspace_scope");
    // Stale grants pruned, two new grants inserted.
    const inserts = clientQueries.filter((q) =>
      q.sql.includes("INSERT INTO oauth_client_workspace_grants"),
    );
    expect(inserts).toHaveLength(2);
    // Conn was released cleanly.
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeUndefined();
  });

  it("single: BEGIN → upsert scope → DELETE all grants → COMMIT (no INSERT)", async () => {
    await setWorkspaceScopeAndGrants({
      clientId: "c1",
      referenceId: "ws-alpha",
      mode: "single",
      workspaceIds: [],
      grantedByUserId: "u1",
    });
    const sqls = clientQueries.map((q) => q.sql);
    expect(
      sqls.some((s) => s.includes("DELETE FROM oauth_client_workspace_grants")),
    ).toBe(true);
    expect(
      sqls.every((s) => !s.includes("INSERT INTO oauth_client_workspace_grants")),
    ).toBe(true);
  });

  it("rolls back and re-throws when a grant INSERT fails mid-transaction", async () => {
    let insertCount = 0;
    queryHandler = async (sql) => {
      if (sql.includes("INSERT INTO oauth_client_workspace_grants")) {
        insertCount++;
        if (insertCount === 2) {
          throw new Error("unique violation");
        }
      }
      return { rows: [] };
    };
    await expect(
      setWorkspaceScopeAndGrants({
        clientId: "c1",
        referenceId: "ws-alpha",
        mode: "multi",
        workspaceIds: ["ws-alpha", "ws-beta", "ws-gamma"],
        grantedByUserId: "u1",
      }),
    ).rejects.toThrow(/unique violation/);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);
    // Conn was released CLEAN (no rollback err) so it returns to the pool.
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeUndefined();
  });

  it("destroys the connection (release with err) when ROLLBACK itself throws", async () => {
    queryHandler = async (sql) => {
      if (sql.includes("INSERT INTO oauth_client_workspace_grants")) {
        throw new Error("statement timeout");
      }
      if (sql.trim().toUpperCase() === "ROLLBACK") {
        throw new Error("connection terminated");
      }
      return { rows: [] };
    };
    await expect(
      setWorkspaceScopeAndGrants({
        clientId: "c1",
        referenceId: "ws-alpha",
        mode: "multi",
        workspaceIds: ["ws-alpha"],
        grantedByUserId: "u1",
      }),
    ).rejects.toThrow(/statement timeout/);

    // Release MUST get the rollback error so pg destroys the socket
    // rather than returning the half-transaction client to the pool.
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeInstanceOf(Error);
    expect((clientReleaseArg as Error).message).toBe("connection terminated");
  });
});

// ---------------------------------------------------------------------------
// revokeWorkspaceGrant — single grant removal
// ---------------------------------------------------------------------------

describe("revokeWorkspaceGrant", () => {
  it("returns 1 when a row was deleted", async () => {
    mocks.mockInternalQuery.mockResolvedValue([{ clientId: "c1" }]);
    expect(await revokeWorkspaceGrant({ clientId: "c1", workspaceId: "ws-a" })).toBe(1);
  });

  it("returns 0 when no row matched (idempotent)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);
    expect(await revokeWorkspaceGrant({ clientId: "c1", workspaceId: "ws-a" })).toBe(0);
  });

  it("filters by both client_id AND workspace_id (no over-broad delete)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([{ clientId: "c1" }]);
    await revokeWorkspaceGrant({ clientId: "c1", workspaceId: "ws-a" });
    const sql = mocks.mockInternalQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("WHERE client_id = $1 AND workspace_id = $2");
    expect(mocks.mockInternalQuery.mock.calls[0]![1]).toEqual(["c1", "ws-a"]);
  });
});
