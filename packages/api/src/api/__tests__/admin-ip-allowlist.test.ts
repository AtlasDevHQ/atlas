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
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// --- Import the app AFTER all mocks ---
const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// --- Helpers ---

function adminRequest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
      ...extraHeaders,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  ipAddress?: string | null;
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
      mockAddEntry.mockImplementation(() =>
        Effect.fail(new MockIPAllowlistError("CIDR already in allowlist", "conflict")),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/ip-allowlist", {
          cidr: "10.0.0.0/8",
          description: "Office",
        }),
      );

      expect(res.status).toBe(409);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

      const entry = lastAuditCall();
      expect(entry.actionType).toBe("ip_allowlist.add");
      expect(entry.status).toBe("failure");
      expect(entry.metadata).toMatchObject({
        cidr: "10.0.0.0/8",
        description: "Office",
        error: "CIDR already in allowlist",
      });
      // Audit message must be the clean IPAllowlistError.message — regression
      // guard against FiberFailure unwrapping leaking Cause formatting or
      // stack frames into the audit column.
      expect(entry.metadata?.error).toBe("CIDR already in allowlist");
      expect(JSON.stringify(entry.metadata ?? {})).not.toContain("at ");
      expect(JSON.stringify(entry.metadata ?? {})).not.toContain("FiberFailure");
    });

    it("threads client IP into the audit row from x-forwarded-for", async () => {
      const res = await app.fetch(
        adminRequest(
          "POST",
          "/api/v1/admin/ip-allowlist",
          { cidr: "10.0.0.0/8", description: "Office" },
          { "X-Forwarded-For": "203.0.113.9" },
        ),
      );

      expect(res.status).toBe(201);
      const entry = lastAuditCall();
      // The attacker's source IP is the load-bearing forensic field for
      // F-24. A refactor that drops the header plumbing must fail here.
      expect(entry.ipAddress).toBe("203.0.113.9");
    });
  });

  describe("DELETE /api/v1/admin/ip-allowlist/:id", () => {
    it("captures the pre-deletion CIDR in the audit row (forensic anti-cover-up)", async () => {
      // Use a distinctive CIDR that appears ONLY in the pre-delete list
      // response — nothing in the request or delete response references it.
      // If the audit handler reads from the wrong source (request body, a
      // post-delete re-query, or the delete return value) the `cidr` here
      // will not be `192.0.2.0/24` and this test fails. This is the
      // anti-cover-up mechanism at the heart of F-24: the CIDR must be
      // captured BEFORE the row is gone.
      mockListEntries.mockImplementation(() =>
        Effect.succeed([
          {
            id: "entry-1",
            orgId: "org-1",
            cidr: "192.0.2.0/24",
            description: "Pre-delete witness",
            createdAt: "2026-04-23T00:00:00Z",
            createdBy: "admin-1",
          },
        ]),
      );

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
        cidr: "192.0.2.0/24",
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
