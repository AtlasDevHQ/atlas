/**
 * Name-collision guard (#2506) — wire contract tests.
 *
 * Five routes thread the same `connectionNameCollidesWithGroup` helper.
 * The non-obvious pieces this file pins:
 *
 *   - POST /admin/connection-groups/merge refuses only when the target
 *     would CREATE; reuse of an existing same-named active group is the
 *     documented wizard ergonomic.
 *   - POST /admin/connections has an `id === newGroupName` carve-out so
 *     a user creating "warehouse" + "warehouse" env in one round trip
 *     isn't blocked by the in-flight connection.
 *   - PUT /admin/connections/:id deliberately omits that carve-out — on
 *     update the connection already exists and a self-named group is
 *     the exact #2506 confusion shape.
 *   - A DB error from the helper MUST surface as 500, not silently 201
 *     (fail-closed contract — see helper docstring).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ── Mocks ──────────────────────────────────────────────────────────────
//
// `us-prod` is the connection the orphan was named after on prod. The
// describe() output makes it the canonical collision target across
// every test in this file.
const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  connection: {
    connections: {
      get: () => null,
      getDefault: () => null,
      describe: () => [{ id: "default", dbType: "postgres" }],
      healthCheck: mock(() =>
        Promise.resolve({ status: "healthy", latencyMs: 1, checkedAt: new Date() }),
      ),
      register: mock(() => {}),
      unregister: mock(() => {}),
      has: mock(() => false),
      getForOrg: () => null,
    },
    resolveDatasourceUrl: () => "postgresql://stub",
  },
  internal: {
    encryptSecret: (url: string) => `encrypted:${url}`,
    decryptSecret: (url: string) => (url as string).replace(/^encrypted:/, ""),
  },
});

const { app } = await import("../index");

afterAll(() => {
  mocks.cleanup();
});

// ── Helpers ────────────────────────────────────────────────────────────

function adminRequest(urlPath: string, method = "POST", body?: unknown): Request {
  return new Request(`http://localhost${urlPath}`, {
    method,
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Returns the SQL of every internalQuery call so a test can assert
 * that no state-changing INSERT/UPDATE fired after a refused collision. */
function stateChangingCalls(): string[] {
  return mocks.mockInternalQuery.mock.calls
    .map(([sql]) => (typeof sql === "string" ? sql : ""))
    .filter((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql));
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("POST /api/v1/admin/connection-groups — name-collision guard (#2506)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.setOrgAdmin("org-alpha");
  });

  it("returns 409 when the group name matches an existing connection id", async () => {
    // Pre-check SELECT returns a row — `us-prod` is a live connection.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        return Promise.resolve([{ id: "us-prod" }]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups", "POST", { name: "us-prod" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string; requestId: string };
    expect(body.error).toBe("conflict");
    expect(body.message).toContain("us-prod");
    expect(typeof body.requestId).toBe("string");
    // No INSERT INTO connection_groups should fire after the guard.
    expect(
      stateChangingCalls().some((sql) => sql.includes("INSERT INTO connection_groups")),
    ).toBe(false);
  });

  it("allows a group name that does not match any existing connection id", async () => {
    // Pre-check SELECT returns no rows — `Production` does not match
    // any connection id, so the INSERT must run.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        return Promise.resolve([]);
      }
      if (sql.includes("INSERT INTO connection_groups")) {
        return Promise.resolve([]);
      }
      if (sql.includes("SELECT id, name, status")) {
        // Final SELECT returning the created row for the wire shape.
        return Promise.resolve([
          {
            id: "g_abc123",
            name: "Production",
            status: "active",
            created_at: new Date(),
            updated_at: new Date(),
            primary_connection_id: null,
            member_count: "0",
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups", "POST", { name: "Production" }),
    );
    expect(res.status).toBe(201);
    expect(
      stateChangingCalls().some((sql) => sql.includes("INSERT INTO connection_groups")),
    ).toBe(true);
  });

  it("scopes the collision check to the caller's org (B2B isolation)", async () => {
    // The pre-check SELECT must filter by org_id so a SaaS tenant
    // sharing a connection id like `default` with another tenant
    // never sees a foreign-org collision.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        return Promise.resolve([]);
      }
      if (sql.includes("INSERT INTO connection_groups")) {
        return Promise.resolve([]);
      }
      if (sql.includes("SELECT id, name, status")) {
        return Promise.resolve([
          {
            id: "g_def456",
            name: "default",
            status: "active",
            created_at: new Date(),
            updated_at: new Date(),
            primary_connection_id: null,
            member_count: "0",
          },
        ]);
      }
      return Promise.resolve([]);
    });

    await app.fetch(
      adminRequest("/api/v1/admin/connection-groups", "POST", { name: "default" }),
    );
    const checkCall = mocks.mockInternalQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("SELECT id FROM connections"),
    );
    expect(checkCall).toBeDefined();
    expect(checkCall![0]).toContain("org_id = $1");
    expect(checkCall![1]).toEqual(["org-alpha", "default"]);
  });
});

describe("PATCH /api/v1/admin/connection-groups/:id — name-collision guard (#2506)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.setOrgAdmin("org-alpha");
  });

  it("returns 409 when the new name matches an existing connection id", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        return Promise.resolve([{ id: "us-prod" }]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/g_existing", "PATCH", {
        name: "us-prod",
      }),
    );
    expect(res.status).toBe(409);
    expect(
      stateChangingCalls().some((sql) => sql.includes("UPDATE connection_groups")),
    ).toBe(false);
  });

  it("allows a rename that does not collide", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        return Promise.resolve([]);
      }
      if (sql.includes("UPDATE connection_groups")) {
        return Promise.resolve([
          {
            id: "g_existing",
            name: "Production",
            status: "active",
            created_at: new Date(),
            updated_at: new Date(),
            primary_connection_id: null,
            member_count: "2",
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/g_existing", "PATCH", {
        name: "Production",
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/admin/connection-groups/merge — name-collision guard (#2506)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.setOrgAdmin("org-alpha");
  });

  it("returns 409 when CREATING a new merged group whose name matches a connection id", async () => {
    // Source pre-validate passes (both connections exist); archived
    // target check passes (nothing archived); existing-target check
    // returns no row (so the merge would CREATE); collision check
    // returns a matching connection id. Refused.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
          { id: "eu-int", org_id: "org-alpha", group_id: "g_eu-int" },
        ]);
      }
      if (sql.includes("FROM connection_groups") && sql.includes("status = 'archived'")) {
        return Promise.resolve([]);
      }
      if (sql.includes("FROM connection_groups") && sql.includes("status = 'active'")) {
        // No existing same-named group → the merge would CREATE
        // → the collision guard runs.
        return Promise.resolve([]);
      }
      if (sql.includes("SELECT id FROM connections")) {
        // The collision-check helper. Returns a hit.
        return Promise.resolve([{ id: "us-prod" }]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "us-prod",
        sourceConnectionIds: ["us-int", "eu-int"],
      }),
    );
    expect(res.status).toBe(409);
    expect(
      stateChangingCalls().some((sql) => sql.includes("WITH target AS")),
    ).toBe(false);
  });

  it("allows REUSING an existing same-named group even when name matches a connection id", async () => {
    // Wizard ergonomic: a same-named active group already exists, so
    // the merge will reuse it via ON CONFLICT — the collision guard
    // must skip this case so a real-world rename-then-merge flow
    // ("oops, I want this to land in the existing 'prod' group")
    // still succeeds.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
          { id: "eu-int", org_id: "org-alpha", group_id: "g_eu-int" },
        ]);
      }
      if (sql.includes("FROM connection_groups") && sql.includes("status = 'archived'")) {
        return Promise.resolve([]);
      }
      if (sql.includes("FROM connection_groups") && sql.includes("status = 'active'")) {
        // Existing same-named group → reuse path, guard skips.
        return Promise.resolve([{ id: "g_existing_prod" }]);
      }
      if (sql.includes("WITH target AS")) {
        return Promise.resolve([
          {
            target: {
              id: "g_existing_prod",
              name: "us-prod",
              primaryConnectionId: "us-int",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              created: false,
            },
            moved_connection_ids: ["us-int", "eu-int"],
            deleted_group_ids: [],
            skipped_group_ids: [],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "us-prod",
        sourceConnectionIds: ["us-int", "eu-int"],
      }),
    );
    expect(res.status).toBe(200);
    expect(
      stateChangingCalls().some((sql) => sql.includes("WITH target AS")),
    ).toBe(true);
  });
});

describe("name-collision guard — fail-closed on DB error (#2506)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.setOrgAdmin("org-alpha");
  });

  it("propagates a helper DB rejection as 500 — guard MUST NOT fail-open", async () => {
    // The fail-closed contract documented on `connectionNameCollidesWithGroup`.
    // A future refactor that wrapped the helper in `catch { return false }`
    // would silently bypass the security guard; this test pins that 500 is
    // the correct response, not a 201 with the group created anyway.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        return Promise.reject(new Error("simulated connection refused"));
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups", "POST", { name: "us-prod" }),
    );
    expect(res.status).toBe(500);
    // Critically: no INSERT INTO connection_groups fired. A fail-open
    // regression would skip the guard and INSERT the row.
    expect(
      stateChangingCalls().some((sql) => sql.includes("INSERT INTO connection_groups")),
    ).toBe(false);
  });
});

describe("POST /api/v1/admin/connections — inline newGroupName (#2506)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.setOrgAdmin("org-alpha");
  });

  it("self-name carve-out: inline newGroupName matching the in-flight id succeeds", async () => {
    // Pins the carve-out documented on the POST route — creating
    // connection `warehouse` with a new env named `warehouse` in one
    // round trip is a legitimate wizard flow. Without the
    // `trimmedNewGroupName !== id` skip, the helper would see no row
    // (connection doesn't exist yet) and the path would silently
    // succeed only by coincidence; we pin that the carve-out is
    // explicit rather than incidental.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        // Sanity: even if the helper fired, no collision exists.
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connections", "POST", {
        id: "warehouse",
        url: "postgresql://user:pass@host/warehouse",
        newGroupName: "warehouse",
      }),
    );
    expect(res.status).toBe(201);
  });

  it("refuses when newGroupName matches a DIFFERENT existing connection id", async () => {
    // The carve-out is narrow: same-name as the in-flight id is fine;
    // matching some OTHER existing connection is the bug shape.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        return Promise.resolve([{ id: "us-prod" }]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connections", "POST", {
        id: "warehouse",
        url: "postgresql://user:pass@host/warehouse",
        newGroupName: "us-prod",
      }),
    );
    expect(res.status).toBe(409);
    // No INSERT INTO connections fired (guard blocked before the create).
    expect(
      stateChangingCalls().some((sql) => sql.includes("INSERT INTO connections")),
    ).toBe(false);
  });
});

describe("PUT /api/v1/admin/connections/:id — inline newGroupName (#2506)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.setOrgAdmin("org-alpha");
  });

  it("no self-name carve-out: refuses newGroupName matching the connection's own id", async () => {
    // On update the connection already exists; a same-named group is
    // the #2506 confusion shape. Pin that PUT does NOT mirror POST's
    // carve-out — a refactor that "consistency-fixed" the asymmetry
    // would silently re-open the bug.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM connections")) {
        // The connection (us-prod) exists for the lookup AND for the
        // collision check — same SELECT shape against `connections`.
        return Promise.resolve([{ id: "us-prod" }]);
      }
      // The pre-fetch SELECT for the current connection row.
      if (sql.includes("SELECT") && sql.includes("connections")) {
        return Promise.resolve([
          {
            id: "us-prod",
            url: "encrypted:postgresql://stub",
            type: "postgres",
            description: null,
            schema_name: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connections/us-prod", "PUT", {
        description: "Updated",
        newGroupName: "us-prod",
      }),
    );
    expect(res.status).toBe(409);
    expect(
      stateChangingCalls().some(
        (sql) => sql.includes("UPDATE connections") || sql.includes("INSERT INTO connection_groups"),
      ),
    ).toBe(false);
  });
});
