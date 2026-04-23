/**
 * Tests for admin IP allowlist route audit emission (F-24).
 *
 * POST /api/v1/admin/ip-allowlist and DELETE /api/v1/admin/ip-allowlist/:id
 * must both emit logAdminAction entries so an attacker with stolen admin
 * credentials cannot silently add 0.0.0.0/0, exploit, and remove it with
 * zero forensic trail.
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

// --- Unified mocks with admin user in org-1 ---

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-1",
  },
  authMode: "managed",
});

// --- EE ip-allowlist override: return proper Effect values so the route
// can unwrap them via Effect.runPromise. The defaults in api-test-mocks
// return raw promises, which breaks the real route code path. ---

const mockAddEntry: Mock<(...args: unknown[]) => unknown> = mock(() =>
  Effect.succeed({
    id: "entry-new",
    orgId: "org-1",
    cidr: "10.0.0.0/8",
    description: "Office network",
    createdAt: "2026-04-23T00:00:00Z",
    createdBy: "admin-1",
  }),
);

const mockRemoveEntry: Mock<(...args: unknown[]) => unknown> = mock(() =>
  Effect.succeed(true),
);

const mockListEntries: Mock<(...args: unknown[]) => unknown> = mock(() =>
  Effect.succeed([
    {
      id: "entry-1",
      orgId: "org-1",
      cidr: "10.0.0.0/8",
      description: "Office",
      createdAt: "2026-04-23T00:00:00Z",
      createdBy: "admin-1",
    },
  ]),
);

class MockIPAllowlistError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "IPAllowlistError";
    this.code = code;
  }
}

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: mock(() => Effect.succeed({ allowed: true })),
  listIPAllowlistEntries: mockListEntries,
  addIPAllowlistEntry: mockAddEntry,
  removeIPAllowlistEntry: mockRemoveEntry,
  IPAllowlistError: MockIPAllowlistError,
  invalidateCache: mock(() => {}),
  _clearCache: mock(() => {}),
  parseCIDR: mock(() => null),
  isIPInRange: mock(() => false),
  isIPAllowed: mock(() => true),
}));

// --- Enterprise gate: flip the env var so the real `isEnterpriseEnabled`
// resolves true without having to mock (and thereby reshape) the whole
// `@atlas/ee/index` module surface that other EE modules depend on. ---
process.env.ATLAS_ENTERPRISE_ENABLED = "true";

// --- Audit mock: capture logAdminAction calls. Pass ADMIN_ACTIONS
// through so the handler gets the real enum (including ip_allowlist.*). ---

const mockLogAdminAction: Mock<(entry: unknown) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// --- Import the app AFTER all mocks ---
const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// --- Helpers ---

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  metadata?: Record<string, unknown>;
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0] as AuditEntry;
}

// --- Tests ---

describe("admin IP allowlist audit emission (F-24)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mockLogAdminAction.mockClear();
    mockAddEntry.mockClear();
    mockRemoveEntry.mockClear();
    mockListEntries.mockClear();

    mockAddEntry.mockImplementation(() =>
      Effect.succeed({
        id: "entry-new",
        orgId: "org-1",
        cidr: "10.0.0.0/8",
        description: "Office network",
        createdAt: "2026-04-23T00:00:00Z",
        createdBy: "admin-1",
      }),
    );
    mockRemoveEntry.mockImplementation(() => Effect.succeed(true));
    mockListEntries.mockImplementation(() =>
      Effect.succeed([
        {
          id: "entry-1",
          orgId: "org-1",
          cidr: "10.0.0.0/8",
          description: "Office",
          createdAt: "2026-04-23T00:00:00Z",
          createdBy: "admin-1",
        },
      ]),
    );
  });

  describe("POST /api/v1/admin/ip-allowlist", () => {
    it("emits logAdminAction with ip_allowlist.add on success", async () => {
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/ip-allowlist", {
          cidr: "10.0.0.0/8",
          description: "Office network",
        }),
      );

      expect(res.status).toBe(201);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

      const entry = lastAuditCall();
      expect(entry.actionType).toBe("ip_allowlist.add");
      expect(entry.targetType).toBe("ip_allowlist" as const);
      expect(entry.targetId).toBe("entry-new");
      expect(entry.status ?? "success").toBe("success");
      expect(entry.metadata).toEqual({
        id: "entry-new",
        cidr: "10.0.0.0/8",
        description: "Office network",
      });
    });

    it("emits logAdminAction with status: failure when EE add throws", async () => {
      // FiberFailure surfaces .message but not .code (see route's catchAll),
      // so conflict maps to 500 today — tracked as an incidental status-mapping
      // bug outside F-24. What F-24 requires is the audit row; that's what we pin.
      mockAddEntry.mockImplementation(() =>
        Effect.fail(new MockIPAllowlistError("CIDR already in allowlist", "conflict")),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/ip-allowlist", {
          cidr: "10.0.0.0/8",
          description: "Office",
        }),
      );

      expect([409, 500]).toContain(res.status);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

      const entry = lastAuditCall();
      expect(entry.actionType).toBe("ip_allowlist.add");
      expect(entry.status).toBe("failure");
      expect(entry.metadata).toMatchObject({
        cidr: "10.0.0.0/8",
        description: "Office",
        error: "CIDR already in allowlist",
      });
      // No stack traces / credential-shaped data leak into audit metadata.
      expect(JSON.stringify(entry.metadata ?? {})).not.toContain("at ");
    });
  });

  describe("DELETE /api/v1/admin/ip-allowlist/:id", () => {
    it("emits logAdminAction with ip_allowlist.remove on success, capturing CIDR", async () => {
      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/ip-allowlist/entry-1"),
      );

      expect(res.status).toBe(200);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

      const entry = lastAuditCall();
      expect(entry.actionType).toBe("ip_allowlist.remove");
      expect(entry.targetType).toBe("ip_allowlist" as const);
      expect(entry.targetId).toBe("entry-1");
      expect(entry.status ?? "success").toBe("success");
      expect(entry.metadata).toMatchObject({
        id: "entry-1",
        cidr: "10.0.0.0/8",
        found: true,
      });
    });

    it("emits logAdminAction with found: false when entry id does not exist", async () => {
      mockListEntries.mockImplementation(() => Effect.succeed([]));
      mockRemoveEntry.mockImplementation(() => Effect.succeed(false));

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/ip-allowlist/entry-missing"),
      );

      expect(res.status).toBe(404);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

      const entry = lastAuditCall();
      expect(entry.actionType).toBe("ip_allowlist.remove");
      expect(entry.targetId).toBe("entry-missing");
      expect(entry.metadata).toMatchObject({
        id: "entry-missing",
        found: false,
      });
      // Not found is not a failure — the attempt succeeded in the sense
      // that the route reached the EE layer; we only care that forensic
      // reconstruction sees the attempt.
      expect(entry.status ?? "success").toBe("success");
    });

    it("emits logAdminAction with status: failure when EE remove throws", async () => {
      mockListEntries.mockImplementation(() => Effect.succeed([]));
      mockRemoveEntry.mockImplementation(() =>
        Effect.fail(new Error("internal DB unreachable")),
      );

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/ip-allowlist/entry-1"),
      );

      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

      const entry = lastAuditCall();
      expect(entry.actionType).toBe("ip_allowlist.remove");
      expect(entry.status).toBe("failure");
      expect(entry.metadata).toMatchObject({
        id: "entry-1",
        error: "internal DB unreachable",
      });
    });

  });
});
