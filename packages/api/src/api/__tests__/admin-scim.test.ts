/**
 * Tests for admin SCIM audit emission (F-23 / #1778).
 *
 * Covers the three write routes under /api/v1/admin/scim:
 *   - DELETE /connections/:id
 *   - POST   /group-mappings
 *   - DELETE /group-mappings/:id
 *
 * Verifies that every write handler emits exactly one logAdminAction with
 * the correct action type + metadata shape on success, that SCIMError paths
 * emit a failure-status audit row, and that bearer tokens never land in
 * audit metadata.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { Effect } from "effect";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks ---

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
});

// --- Audit mock: spy on logAdminAction, real ADMIN_ACTIONS values ---

const mockLogAdminAction: Mock<(entry: Record<string, unknown>) => void> = mock(() => {});

// Keep the action-type string values in lockstep with actions.ts — the route
// code imports these from @atlas/api/lib/audit so the mock must export
// matching constants. A drift here would silently weaken assertions.
const MOCK_ADMIN_ACTIONS = {
  scim: {
    connectionDelete: "scim.connection_delete",
    groupMappingCreate: "scim.group_mapping_create",
    groupMappingDelete: "scim.group_mapping_delete",
  },
} as const;

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  ADMIN_ACTIONS: MOCK_ADMIN_ACTIONS,
}));

// --- SCIM mock: stable error class + per-test Effect mocks ---

// Stable SCIMError class — domainError() uses instanceof, so the class
// referenced by the route code at module load time must match instances
// produced inside test-supplied mock implementations.
class MockSCIMError extends Error {
  public readonly code: "not_found" | "conflict" | "validation";
  constructor(message: string, code: "not_found" | "conflict" | "validation") {
    super(message);
    this.name = "SCIMError";
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocks flex across success/failure Effects
const mockListConnections: Mock<(orgId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed([]),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockDeleteConnection: Mock<(orgId: string, connectionId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed(true),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockGetSyncStatus: Mock<(orgId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed({ connections: 0, provisionedUsers: 0, lastSyncAt: null }),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockListGroupMappings: Mock<(orgId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed([]),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockCreateGroupMapping: Mock<(orgId: string, groupName: string, roleName: string) => Effect.Effect<any, any>> = mock(
  () => Effect.die(new Error("not configured")),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockDeleteGroupMapping: Mock<(orgId: string, mappingId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed(true),
);

mock.module("@atlas/ee/auth/scim", () => ({
  // Error class — same reference used by route module and tests.
  SCIMError: MockSCIMError,
  // CRUD operations.
  listConnections: mockListConnections,
  deleteConnection: mockDeleteConnection,
  getSyncStatus: mockGetSyncStatus,
  listGroupMappings: mockListGroupMappings,
  createGroupMapping: mockCreateGroupMapping,
  deleteGroupMapping: mockDeleteGroupMapping,
  // Helpers — defaults good enough for these tests.
  resolveGroupToRole: mock(() => Effect.succeed(null)),
  isValidScimGroupName: () => true,
  _resetTableEnsured: () => {},
}));

// --- Import app AFTER mocks ---

const { app } = await import("../index");

// --- Helpers ---

// Bearer tokens should NEVER be passed to logAdminAction; the tests use a
// sentinel value so an accidental Authorization-header leak into audit
// metadata is easy to spot.
const BEARER_TOKEN_SENTINEL = "scim-bearer-SHOULD-NOT-APPEAR-IN-AUDIT";

function scimRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN_SENTINEL}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${urlPath}`, opts);
}

// Flatten the keys of the audit entry + its metadata for key-presence checks.
function collectKeys(entry: Record<string, unknown>): string[] {
  const keys = Object.keys(entry);
  const metadata = entry.metadata;
  if (metadata && typeof metadata === "object") {
    keys.push(...Object.keys(metadata as Record<string, unknown>));
  }
  return keys;
}

// Serialize the audit payload so we can assert on raw string content:
// even if the bearer token sneaks into metadata under an unexpected key,
// this catches it.
function serializeAudit(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

// --- Cleanup ---

afterAll(() => mocks.cleanup());

// --- Reset state between tests ---

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setOrgAdmin("org-alpha");
  mockLogAdminAction.mockReset();
  mockListConnections.mockReset();
  mockDeleteConnection.mockReset();
  mockGetSyncStatus.mockReset();
  mockListGroupMappings.mockReset();
  mockCreateGroupMapping.mockReset();
  mockDeleteGroupMapping.mockReset();
  // Sensible defaults re-applied per test.
  mockListConnections.mockImplementation(() => Effect.succeed([]));
  mockGetSyncStatus.mockImplementation(() =>
    Effect.succeed({ connections: 0, provisionedUsers: 0, lastSyncAt: null }),
  );
  mockListGroupMappings.mockImplementation(() => Effect.succeed([]));
});

// ---------------------------------------------------------------------------
// DELETE /connections/:id
// ---------------------------------------------------------------------------

describe("admin SCIM — DELETE /connections/:id", () => {
  it("emits scim.connection_delete audit on success", async () => {
    mockDeleteConnection.mockImplementation(() => Effect.succeed(true));

    const res = await app.fetch(
      scimRequest("/api/v1/admin/scim/connections/conn_abc123", "DELETE"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "scim.connection_delete",
      targetType: "scim",
      targetId: "conn_abc123",
      metadata: { connectionId: "conn_abc123" },
    });
    expect(entry.status).toBeUndefined(); // default "success"
  });

  it("does not include bearer token in audit metadata", async () => {
    mockDeleteConnection.mockImplementation(() => Effect.succeed(true));

    await app.fetch(
      scimRequest("/api/v1/admin/scim/connections/conn_abc123", "DELETE"),
    );

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];

    // Assert key absence, not just empty — a `token: ""` would slip past.
    const keys = collectKeys(entry);
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("authorization");
    expect(keys).not.toContain("bearer");
    // Full-payload check — bearer-token bytes must not appear anywhere.
    expect(serializeAudit(entry)).not.toContain(BEARER_TOKEN_SENTINEL);
  });

  it("emits status:failure audit when SCIMError is thrown", async () => {
    mockDeleteConnection.mockImplementation(() =>
      Effect.fail(new MockSCIMError("Connection not found.", "not_found")),
    );

    const res = await app.fetch(
      scimRequest("/api/v1/admin/scim/connections/conn_abc123", "DELETE"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "scim.connection_delete",
      targetType: "scim",
      targetId: "conn_abc123",
      status: "failure",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.connectionId).toBe("conn_abc123");
    expect(metadata.error).toBe("Connection not found.");
    // Still no bearer token on failure paths.
    expect(serializeAudit(entry)).not.toContain(BEARER_TOKEN_SENTINEL);
  });

  it("skips audit on 404 when the service returns false", async () => {
    // Service returned false (no rows deleted) — the route returns 404 but
    // nothing actually changed, so no audit row is expected. This prevents
    // scanning the audit log for "deleted" and hitting phantom no-ops.
    mockDeleteConnection.mockImplementation(() => Effect.succeed(false));

    const res = await app.fetch(
      scimRequest("/api/v1/admin/scim/connections/conn_abc123", "DELETE"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /group-mappings
// ---------------------------------------------------------------------------

describe("admin SCIM — POST /group-mappings", () => {
  it("emits scim.group_mapping_create audit on success", async () => {
    const mapping = {
      id: "map_abc123",
      orgId: "org-alpha",
      scimGroupName: "platform-admins",
      roleName: "platform_admin",
      createdAt: "2026-04-23T00:00:00.000Z",
    };
    mockCreateGroupMapping.mockImplementation(() => Effect.succeed(mapping));

    const res = await app.fetch(
      scimRequest("/api/v1/admin/scim/group-mappings", "POST", {
        scimGroupName: "platform-admins",
        roleName: "platform_admin",
      }),
    );

    expect(res.status).toBe(201);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "scim.group_mapping_create",
      targetType: "scim",
      targetId: "map_abc123",
      metadata: {
        mappingId: "map_abc123",
        scimGroupName: "platform-admins",
        roleName: "platform_admin",
        orgId: "org-alpha",
      },
    });
    expect(entry.status).toBeUndefined();
  });

  it("does not include bearer token in audit metadata", async () => {
    const mapping = {
      id: "map_abc123",
      orgId: "org-alpha",
      scimGroupName: "platform-admins",
      roleName: "platform_admin",
      createdAt: "2026-04-23T00:00:00.000Z",
    };
    mockCreateGroupMapping.mockImplementation(() => Effect.succeed(mapping));

    await app.fetch(
      scimRequest("/api/v1/admin/scim/group-mappings", "POST", {
        scimGroupName: "platform-admins",
        roleName: "platform_admin",
      }),
    );

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    const keys = collectKeys(entry);
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("authorization");
    expect(keys).not.toContain("bearer");
    expect(serializeAudit(entry)).not.toContain(BEARER_TOKEN_SENTINEL);
  });

  it("emits status:failure audit when SCIMError.conflict is thrown", async () => {
    mockCreateGroupMapping.mockImplementation(() =>
      Effect.fail(
        new MockSCIMError(
          "A mapping for SCIM group \"platform-admins\" already exists in this organization.",
          "conflict",
        ),
      ),
    );

    const res = await app.fetch(
      scimRequest("/api/v1/admin/scim/group-mappings", "POST", {
        scimGroupName: "platform-admins",
        roleName: "platform_admin",
      }),
    );

    expect(res.status).toBe(409);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "scim.group_mapping_create",
      targetType: "scim",
      status: "failure",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.scimGroupName).toBe("platform-admins");
    expect(metadata.roleName).toBe("platform_admin");
    expect(metadata.error).toContain("already exists");
    expect(serializeAudit(entry)).not.toContain(BEARER_TOKEN_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// DELETE /group-mappings/:id
// ---------------------------------------------------------------------------

describe("admin SCIM — DELETE /group-mappings/:id", () => {
  const existingMapping = {
    id: "map_abc123",
    orgId: "org-alpha",
    scimGroupName: "platform-admins",
    roleName: "platform_admin",
    createdAt: "2026-04-23T00:00:00.000Z",
  };

  it("emits scim.group_mapping_delete audit with group name + role on success", async () => {
    mockListGroupMappings.mockImplementation(() => Effect.succeed([existingMapping]));
    mockDeleteGroupMapping.mockImplementation(() => Effect.succeed(true));

    const res = await app.fetch(
      scimRequest("/api/v1/admin/scim/group-mappings/map_abc123", "DELETE"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "scim.group_mapping_delete",
      targetType: "scim",
      targetId: "map_abc123",
      metadata: {
        mappingId: "map_abc123",
        scimGroupName: "platform-admins",
        roleName: "platform_admin",
      },
    });
    expect(entry.status).toBeUndefined();
  });

  it("emits audit with found:false when mapping does not exist", async () => {
    mockListGroupMappings.mockImplementation(() => Effect.succeed([]));

    const res = await app.fetch(
      scimRequest("/api/v1/admin/scim/group-mappings/map_missing", "DELETE"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "scim.group_mapping_delete",
      targetType: "scim",
      targetId: "map_missing",
      metadata: { mappingId: "map_missing", found: false },
    });
    // deleteGroupMapping should NOT have been called when the pre-fetch
    // shows no existing row — otherwise the audit is speculative.
    expect(mockDeleteGroupMapping).not.toHaveBeenCalled();
  });

  it("does not include bearer token in audit metadata", async () => {
    mockListGroupMappings.mockImplementation(() => Effect.succeed([existingMapping]));
    mockDeleteGroupMapping.mockImplementation(() => Effect.succeed(true));

    await app.fetch(
      scimRequest("/api/v1/admin/scim/group-mappings/map_abc123", "DELETE"),
    );

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    const keys = collectKeys(entry);
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("authorization");
    expect(keys).not.toContain("bearer");
    expect(serializeAudit(entry)).not.toContain(BEARER_TOKEN_SENTINEL);
  });

  it("emits status:failure audit when SCIMError is thrown", async () => {
    mockListGroupMappings.mockImplementation(() =>
      Effect.fail(new MockSCIMError("DB offline.", "not_found")),
    );

    const res = await app.fetch(
      scimRequest("/api/v1/admin/scim/group-mappings/map_abc123", "DELETE"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "scim.group_mapping_delete",
      targetType: "scim",
      targetId: "map_abc123",
      status: "failure",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.mappingId).toBe("map_abc123");
    expect(metadata.error).toBe("DB offline.");
    expect(serializeAudit(entry)).not.toContain(BEARER_TOKEN_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Regression — read routes stay silent
// ---------------------------------------------------------------------------

describe("admin SCIM — read routes don't emit audit", () => {
  it("GET / does not call logAdminAction", async () => {
    const res = await app.fetch(scimRequest("/api/v1/admin/scim"));
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("GET /group-mappings does not call logAdminAction", async () => {
    const res = await app.fetch(scimRequest("/api/v1/admin/scim/group-mappings"));
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
