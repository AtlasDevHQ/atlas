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
const mockImportFromDisk: Mock<(orgId: string, opts?: { connectionId?: string; sourceDir?: string }) => Promise<unknown>> = mock(
  async () => ({ imported: 12, skipped: 3, total: 15, entries: [] }),
);
mock.module("@atlas/api/lib/semantic/sync", () => ({
  syncEntityToDisk: mock(async () => {}),
  syncEntityDeleteFromDisk: async () => {},
  syncAllEntitiesToDisk: async () => 0,
  getSemanticRoot: () => "/tmp/test-semantic",
  reconcileAllOrgs: async () => {},
  importFromDisk: mockImportFromDisk,
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
  mockImportFromDisk.mockClear();
  mockImportFromDisk.mockImplementation(async () => ({
    imported: 12,
    skipped: 3,
    total: 15,
    entries: [],
  }));
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

  it("does not emit when importFromDisk throws (500 + no audit row)", async () => {
    // A throw from importFromDisk means zero entities were persisted.
    // The audit trail must match the real world: no row for a
    // non-event. The runHandler wrapper surfaces the throw as a 500
    // with a requestId; the emission sits past the throw and never
    // fires.
    mockImportFromDisk.mockImplementation(async () => {
      throw new Error("disk sync failed");
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", {}),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
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

  it("auto-recovers a partial-demo org from the bundled seed", async () => {
    // Reproduces the dharma class of incident: the org has a `__demo__`
    // connection but the org-scoped disk has zero entities (because the
    // pre-#2153 /use-demo flow committed the connection before the import
    // attempt). Clicking "Import from disk" should now silently fall
    // through to the bundled NovaMart seed and recover the workspace —
    // the user gets a coherent state in one click.
    let importCallCount = 0;
    mockImportFromDisk.mockImplementation(async (orgId: string, opts?: { connectionId?: string; sourceDir?: string }) => {
      importCallCount++;
      if (importCallCount === 1) {
        // First call — org-scoped disk yields nothing
        expect(opts?.sourceDir).toBeUndefined();
        return { imported: 0, skipped: 0, total: 0, errors: [] };
      }
      // Second call — bundled-seed fallback
      expect(opts?.connectionId).toBe("__demo__");
      expect(opts?.sourceDir).toBeDefined();
      return { imported: 13, skipped: 0, total: 13, errors: [] };
    });
    // Org owns __demo__ — triggers the auto-recovery branch.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM connections") && sql.includes("__demo__")) {
        return [{ id: "__demo__" }];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", {}),
    );

    expect(res.status).toBe(200);
    expect(importCallCount).toBe(2);
    const data = (await res.json()) as { imported: number };
    expect(data.imported).toBe(13);

    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({
      importedCount: 13,
      sourceRef: "demo-seed:auto-recover",
    });
  });

  it("does not auto-recover when the org has no __demo__ connection", async () => {
    // Wizard org with empty disk — no auto-fallthrough. The user sees the
    // honest 0-imported result rather than a surprise NovaMart import.
    let importCallCount = 0;
    mockImportFromDisk.mockImplementation(async () => {
      importCallCount++;
      return { imported: 0, skipped: 0, total: 0, errors: [] };
    });
    mocks.mockInternalQuery.mockImplementation(async () => []); // no __demo__ row

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", {}),
    );

    expect(res.status).toBe(200);
    expect(importCallCount).toBe(1);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({ sourceRef: "disk:all" });
  });

  it("does not auto-recover when the caller passes an explicit connectionId", async () => {
    // Critical safety: an org might own BOTH `warehouse` and `__demo__`. If
    // the caller asks specifically about `warehouse` and its disk happens
    // to be empty, we MUST NOT silently overwrite/import NovaMart entities
    // — that would corrupt the warehouse semantic layer.
    let importCallCount = 0;
    let lastImportOpts: unknown = null;
    mockImportFromDisk.mockImplementation(async (_orgId: string, opts?: { connectionId?: string; sourceDir?: string }) => {
      importCallCount++;
      lastImportOpts = opts;
      return { imported: 0, skipped: 0, total: 0, errors: [] };
    });
    // Org owns __demo__ — but caller asked about warehouse.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("__demo__")) {
        return [{ id: "__demo__" }];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", { connectionId: "warehouse" }),
    );

    expect(res.status).toBe(200);
    expect(importCallCount).toBe(1);
    expect(lastImportOpts).toMatchObject({ connectionId: "warehouse" });
    const data = (await res.json()) as { imported: number };
    expect(data.imported).toBe(0);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({ sourceRef: "disk:warehouse" });
  });

  it("auto-recovery reports honestly when the bundled seed itself yields zero imports", async () => {
    // A degenerate case: seed dir present but every YAML row fails the
    // upsert. The auto-recovery branch must NOT mis-claim recovery — the
    // sourceRef stays as the original disk:all, no auto-recover audit
    // trail, and the user sees the truthful 0-imported result.
    let importCallCount = 0;
    mockImportFromDisk.mockImplementation(async (_orgId: string, opts?: { sourceDir?: string }) => {
      importCallCount++;
      // First call (org-scoped disk, no sourceDir) → empty.
      // Second call (recovery, sourceDir set) → seed yielded zero.
      if (opts?.sourceDir) {
        return { imported: 0, skipped: 13, total: 13, errors: [] };
      }
      return { imported: 0, skipped: 0, total: 0, errors: [] };
    });
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("__demo__")) {
        return [{ id: "__demo__" }];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", {}),
    );

    expect(res.status).toBe(200);
    expect(importCallCount).toBeGreaterThanOrEqual(2);
    const entry = lastAuditCall();
    // The recovery call happened, but it didn't produce rows — so we
    // must NOT mark this as `demo-seed:auto-recover`.
    expect(entry.metadata).not.toMatchObject({ sourceRef: "demo-seed:auto-recover" });
    expect(entry.metadata).toMatchObject({ sourceRef: "disk:all" });
  });

  it("explicit source=demo-seed forces the bundled seed path", async () => {
    let importedFromSeed = false;
    mockImportFromDisk.mockImplementation(async (_orgId: string, opts?: { connectionId?: string; sourceDir?: string }) => {
      if (opts?.sourceDir) importedFromSeed = true;
      return { imported: 13, skipped: 0, total: 13, errors: [] };
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/semantic/org/import", { source: "demo-seed" }),
    );

    expect(res.status).toBe(200);
    expect(importedFromSeed).toBe(true);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({ sourceRef: "demo-seed" });
  });
});
