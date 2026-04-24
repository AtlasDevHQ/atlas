/**
 * Audit regression suite for the last two `admin.ts` gaps — F-29 (#1784).
 *
 *   - `POST /me/password` → `user.password_change` (self-action:
 *      targetType="user", targetId=actorId). Critical pin: the targetId
 *      must be the actor's user id so forensic queries can distinguish
 *      self-changes from admin rotations of someone else's password.
 *   - `POST /semantic/org/import` → `semantic.bulk_import` with
 *      `{ importedCount, sourceRef }`.
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
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Mocks — declared before the app import
// ---------------------------------------------------------------------------

const mocks = createApiTestMocks({
  authUser: {
    id: "user-42",
    mode: "managed",
    label: "user@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

// Better Auth instance — the password-change route calls
// `getAuthInstance().api.changePassword(...)`. Mock a successful flow.
const mockChangePassword: Mock<(opts: unknown) => Promise<unknown>> = mock(
  async () => ({ success: true }),
);

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    api: { changePassword: mockChangePassword },
  }),
  listAllUsers: mock(() => Promise.resolve([])),
  setUserRole: mock(async () => {}),
  setBanStatus: mock(async () => {}),
  setPasswordChangeRequired: mock(async () => {}),
  deleteUser: mock(async () => {}),
}));

// importFromDisk — the bulk-import handler dynamically imports it.
mock.module("@atlas/api/lib/semantic/sync", () => ({
  syncEntityToDisk: mock(async () => {}),
  syncEntityDeleteFromDisk: async () => {},
  syncAllEntitiesToDisk: async () => 0,
  getSemanticRoot: () => "/tmp/test-semantic",
  reconcileAllOrgs: async () => {},
  importFromDisk: mock(async () => ({
    imported: 12,
    skipped: 3,
    total: 15,
    entries: [],
  })),
}));

// Audit capture
interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mockChangePassword.mockClear();
  mockChangePassword.mockImplementation(async () => ({ success: true }));
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(async () => []);
  // Default auth: managed user "user-42" admin in org-alpha. Individual
  // tests may narrow this fixture.
  mocks.mockAuthenticateRequest.mockImplementation(async () => ({
    authenticated: true,
    mode: "managed",
    user: {
      id: "user-42",
      mode: "managed",
      label: "user@test.com",
      role: "admin",
      activeOrganizationId: "org-alpha",
    },
  }));
});

// ---------------------------------------------------------------------------
// POST /me/password — self-action
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/me/password — audit emission (F-29)", () => {
  it("emits user.password_change with targetId=actorId (self-action pin)", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/me/password", {
        currentPassword: "oldPa55word!",
        newPassword: "newPa55word!",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.password_change");
    expect(entry.targetType).toBe("user");
    // CRITICAL: the actor IS the target. If a future change sets
    // targetId to null (or any other value), this assertion fails so
    // forensic queries can always distinguish self-service password
    // changes from admin-initiated rotations.
    expect(entry.targetId).toBe("user-42");
    expect(entry.metadata).toMatchObject({ self: true });
  });

  it("never includes password material in the audit metadata", async () => {
    await app.fetch(
      adminRequest("POST", "/api/v1/admin/me/password", {
        currentPassword: "secretOldPa55word!",
        newPassword: "secretNewPa55word!",
      }),
    );

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    const metaJson = JSON.stringify(entry.metadata ?? {});
    expect(metaJson).not.toContain("secretOldPa55word");
    expect(metaJson).not.toContain("secretNewPa55word");
    expect(metaJson).not.toContain("currentPassword");
    expect(metaJson).not.toContain("newPassword");
  });

  it("does not emit when the new password is too short (400)", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/me/password", {
        currentPassword: "ok",
        newPassword: "short",
      }),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("does not emit when Better Auth rejects the current password (400)", async () => {
    mockChangePassword.mockImplementation(async () => {
      throw new Error("invalid password");
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/me/password", {
        currentPassword: "wrong",
        newPassword: "newPa55word!",
      }),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /semantic/org/import — bulk import
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/semantic/org/import — audit emission (F-29)", () => {
  it("emits semantic.bulk_import with importedCount + sourceRef='disk:all' metadata", async () => {
    // Handler tolerates an empty JSON body (no `connectionId` → "disk:all").
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", {}),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("semantic.bulk_import");
    expect(entry.targetType).toBe("semantic");
    expect(entry.targetId).toBe("org-alpha");
    expect(entry.metadata).toMatchObject({
      importedCount: 12,
      sourceRef: "disk:all",
    });
  });

  it("narrows sourceRef to the connection when one is supplied", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", {
        connectionId: "warehouse",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({ sourceRef: "disk:warehouse" });
  });

  it("does not emit when no active org (400)", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(async () => ({
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-42",
        mode: "managed",
        label: "user@test.com",
        role: "admin",
        // activeOrganizationId deliberately omitted
      },
    }));

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", {}),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
