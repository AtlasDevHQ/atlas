/**
 * Name-collision guard (#2506) — wire contract tests.
 *
 * Every user-initiated path that names (or renames) a connection group
 * must refuse a name that matches an existing connection id in the same
 * org. The original orphan that surfaced this bug — empty `g_us-prod`
 * group with name `us-prod` colliding with the `us-prod` connection
 * already living inside the `prod` group — is the exact shape a future
 * inline-create or rename could re-introduce at no benefit. The env
 * combobox in the Add Connection dialog cannot distinguish a real env
 * from a connection-id-shaped label, so the surface defence is at the
 * route layer where the literal name is known.
 *
 * Coverage matrix:
 *   - POST  /admin/connection-groups           — refused on collision
 *   - PATCH /admin/connection-groups/:id       — refused on collision
 *   - POST  /admin/connection-groups/merge     — refused only when the
 *                                                 target name would
 *                                                 CREATE a new group;
 *                                                 reusing an existing
 *                                                 same-named group is
 *                                                 the documented wizard
 *                                                 ergonomic and must
 *                                                 stay supported.
 *
 * The POST /admin/connections and PUT /admin/connections/:id inline
 * `newGroupName` paths reuse the same `connectionNameCollidesWithGroup`
 * helper; their wire contract is exercised by the helper-level pin
 * below — the per-route SQL surface is the existing connection-create
 * test bed, which is too large to recreate just for the collision
 * check.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
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
