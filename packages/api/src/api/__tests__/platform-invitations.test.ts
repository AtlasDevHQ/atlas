/**
 * Tests for the platform-admin cross-org invite endpoint (#2876).
 *
 * Covers: POST /api/v1/platform/invitations
 * - platform_admin can invite into an org they're not a member of
 * - audit row carries the target orgId (not the caller's active org)
 * - non-platform_admin gets 403
 * - existing-member + pending-invitation dedup
 * - platform_admin role in the body is rejected
 * - seat-limit gate fires on the target org
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

// --- Unified mocks ---

const mocks = createApiTestMocks();

// Audit log capture — recordInvitationCreated routes through this.
const mockLogAdminAction = mock<(args: Record<string, unknown>) => void>(() => {});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: {
    user: {
      invite: "user.invite",
      remove: "user.remove",
      changeRole: "user.change_role",
      revokeInvitation: "user.revoke_invitation",
    },
  },
}));

mock.module("@atlas/api/lib/audit/admin", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
}));

// Email delivery — record the dispatch and treat it as successful.
type SendEmailArgs = { to: string; subject: string; html: string };
const mockSendEmail = mock<(args: SendEmailArgs, orgId?: string) => Promise<{ success: true; provider: string }>>(async () => ({
  success: true as const,
  provider: "mock",
}));

mock.module("@atlas/api/lib/email/delivery", () => ({
  sendEmail: mockSendEmail,
}));

// Onboarding milestone trigger — no-op, just keep the import resolvable.
mock.module("@atlas/api/lib/email/hooks", () => ({
  onTeamMemberInvited: mock(async () => {}),
}));

// Billing enforcement — by default allow every seat check.
const mockCheckResourceLimit = mock<
  (orgId: string, resource: string, count: number) => Promise<{ allowed: boolean; errorMessage?: string }>
>(async () => ({ allowed: true }));

mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkResourceLimit: mockCheckResourceLimit,
  invalidatePlanCache: mock(() => {}),
  getCachedWorkspace: mock(async () => null),
  checkPlanLimits: mock(async () => ({ allowed: true, status: "ok" })),
  buildMetricStatus: mock(() => "ok"),
  severityOf: mock(() => 0),
}));

// --- Import app after mocks ---

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// --- Helpers ---

function platformRequest(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

interface InvitationResponse {
  id: string;
  email: string;
  role: string;
  organizationId: string;
  inviterId: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Default query handler for the success path. Returns:
 * - 1 org match for `FROM organization`
 * - 0 existing members for the member-dedup lookup
 * - 0 pending invitations for the invite-dedup lookup
 * - seat-count 1 for the seat-limit gate
 * - 1 inviter row for the inviter-name lookup
 * - 1 row for the final INSERT … RETURNING
 */
function defaultQueryHandler(
  overrides: Partial<{
    org: Array<Record<string, unknown>>;
    existingMembers: Array<Record<string, unknown>>;
    pending: Array<Record<string, unknown>>;
    seatCount: number;
    inviter: Array<Record<string, unknown>>;
    inserted: Array<Record<string, unknown>>;
  }> = {},
): (sql: string, params?: unknown[]) => Promise<unknown[]> {
  return async (sql, params) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, name FROM organization")) {
      return overrides.org ?? [{ id: "target-org", name: "Target Co" }];
    }
    if (s.includes("FROM member m") && s.includes("JOIN \"user\" u")) {
      return overrides.existingMembers ?? [];
    }
    if (s.includes("FROM invitation") && s.includes("status = 'pending'")) {
      return overrides.pending ?? [];
    }
    if (s.includes("SELECT (") && s.includes("FROM member") && s.includes("FROM invitation")) {
      return [{ count: overrides.seatCount ?? 1 }];
    }
    if (s.startsWith("SELECT name, email FROM \"user\"")) {
      return overrides.inviter ?? [{ name: "Platform Admin", email: "platform@test.com" }];
    }
    if (s.startsWith("INSERT INTO invitation")) {
      if (overrides.inserted) return overrides.inserted;
      // Echo the inserted params so role / orgId / email assertions
      // reflect what the handler actually wrote — hard-coding "member"
      // here would hide role-mapping bugs in the route handler itself.
      const [id, email, role, organizationId, inviterId, expiresAt, createdAt] = params ?? [];
      return [
        {
          id: id ?? "inv-1",
          email: email ?? "newuser@example.com",
          role: role ?? "member",
          organizationId: organizationId ?? "target-org",
          inviterId: inviterId ?? "platform-admin-1",
          status: "pending",
          expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt ?? ""),
          createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt ?? ""),
        },
      ];
    }
    return [];
  };
}

beforeEach(() => {
  mocks.setPlatformAdmin();
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mockSendEmail.mockClear();
  mockCheckResourceLimit.mockClear();
  mockCheckResourceLimit.mockImplementation(async () => ({ allowed: true }));
});

// --- Tests ---

describe("POST /api/v1/platform/invitations", () => {
  it("creates a cross-org invitation when the caller is not a member of the target org", async () => {
    mocks.mockInternalQuery.mockImplementation(defaultQueryHandler());

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as InvitationResponse;
    expect(body.email).toBe("newuser@example.com");
    expect(body.organizationId).toBe("target-org");
    expect(body.inviterId).toBe("platform-admin-1");
    expect(body.status).toBe("pending");
  });

  it("audits with the TARGET orgId, not the caller's active org", async () => {
    // Caller's active org is "org-test" (default setPlatformAdmin value).
    // The invite targets "target-org" — audit must reflect the target.
    mocks.setPlatformAdmin("org-test");
    mocks.mockInternalQuery.mockImplementation(defaultQueryHandler());

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "admin",
      }),
    );
    expect(res.status).toBe(200);

    expect(mockLogAdminAction).toHaveBeenCalled();
    const lastCall = mockLogAdminAction.mock.calls.at(-1)?.[0] as {
      actionType: string;
      metadata?: { orgId?: string; email?: string; role?: string };
    } | undefined;
    expect(lastCall?.actionType).toBe("user.invite");
    expect(lastCall?.metadata?.orgId).toBe("target-org");
    expect(lastCall?.metadata?.email).toBe("newuser@example.com");
    expect(lastCall?.metadata?.role).toBe("admin");
  });

  it("sends the invitation email", async () => {
    mocks.mockInternalQuery.mockImplementation(defaultQueryHandler());

    await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );

    expect(mockSendEmail).toHaveBeenCalled();
    const callArgs = mockSendEmail.mock.calls.at(-1) as [SendEmailArgs, string?] | undefined;
    expect(callArgs?.[0]?.to).toBe("newuser@example.com");
    expect(callArgs?.[1]).toBe("target-org");
  });

  it("returns 403 for non-platform_admin callers", async () => {
    mocks.setOrgAdmin("org-1");

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when role is platform_admin", async () => {
    mocks.mockInternalQuery.mockImplementation(defaultQueryHandler());

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "platform_admin",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("returns 404 when the target org does not exist", async () => {
    mocks.mockInternalQuery.mockImplementation(defaultQueryHandler({ org: [] }));

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "ghost-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when the user is already a member of the target org", async () => {
    mocks.mockInternalQuery.mockImplementation(
      defaultQueryHandler({ existingMembers: [{ id: "mbr-1" }] }),
    );

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "existing@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("already_member");
  });

  it("returns 409 when a pending invitation already exists for the email", async () => {
    mocks.mockInternalQuery.mockImplementation(
      defaultQueryHandler({
        pending: [
          {
            id: "inv-existing",
            email: "newuser@example.com",
            role: "member",
            organizationId: "target-org",
            inviterId: "platform-admin-1",
            status: "pending",
            expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("already_invited");
  });

  it("returns 429 when the target org has hit its seat limit", async () => {
    mocks.mockInternalQuery.mockImplementation(defaultQueryHandler({ seatCount: 5 }));
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      errorMessage: "Workspace seat limit reached.",
    }));

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("seat_limit");
  });

  it("normalizes email to lowercase before dedup + insert", async () => {
    let capturedEmail = null as string | null;
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO invitation")) {
        capturedEmail = (params?.[1] as string) ?? null;
        return [
          {
            id: "inv-2",
            email: capturedEmail,
            role: "member",
            organizationId: "target-org",
            inviterId: "platform-admin-1",
            status: "pending",
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString(),
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return defaultQueryHandler()(sql, params);
    });

    await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "MixedCase@Example.COM",
        role: "member",
      }),
    );

    expect(capturedEmail).toBe("mixedcase@example.com");
  });

  it("returns 404 when internal DB is not configured", async () => {
    mocks.hasInternalDB = false;

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(404);
  });
});
