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

void mock.module("@atlas/api/lib/audit", () => ({
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

void mock.module("@atlas/api/lib/audit/admin", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
}));

// Email delivery — record the dispatch and treat it as successful.
type SendEmailArgs = { to: string; subject: string; html: string };
const mockSendEmail = mock<(args: SendEmailArgs, orgId?: string) => Promise<{ success: true; provider: string }>>(async () => ({
  success: true as const,
  provider: "mock",
}));

void mock.module("@atlas/api/lib/email/delivery", () => ({
  sendEmail: mockSendEmail,
}));

// Onboarding milestone trigger — no-op, just keep the import resolvable.
void mock.module("@atlas/api/lib/email/hooks", () => ({
  onTeamMemberInvited: mock(async () => {}),
}));

// Billing enforcement — by default allow every seat check.
const mockCheckResourceLimit = mock<
  (orgId: string, resource: string, count: number) => Promise<{ allowed: boolean; reason?: "cap_reached" | "check_failed"; errorMessage?: string; limit?: number }>
>(async () => ({ allowed: true }));

void mock.module("@atlas/api/lib/billing/enforcement", () => ({
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
 * - pending count 0 for the pending-cap gate
 * - seat-count 1 for the seat-limit gate
 * - 1 owner-member for the inviter-resolution lookup
 * - 1 inviter row for the inviter-name lookup
 * - 1 row for the final INSERT … RETURNING
 * - empty array for the DELETE rollback path (success case: not invoked)
 */
function defaultQueryHandler(
  overrides: Partial<{
    org: Array<Record<string, unknown>>;
    existingMembers: Array<Record<string, unknown>>;
    pending: Array<Record<string, unknown>>;
    pendingCount: number;
    seatCount: number;
    inviterMembers: Array<Record<string, unknown>>;
    inviter: Array<Record<string, unknown>>;
    inserted: Array<Record<string, unknown>>;
    onDelete?: (id: unknown) => void;
  }> = {},
): (sql: string, params?: unknown[]) => Promise<unknown[]> {
  return async (sql, params) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, name, workspace_status FROM organization")) {
      return overrides.org ?? [{ id: "target-org", name: "Target Co", workspace_status: "active" }];
    }
    if (s.includes("FROM member m") && s.includes("JOIN \"user\" u")) {
      return overrides.existingMembers ?? [];
    }
    // Pending-cap query: standalone count. Must be matched BEFORE the
    // seat-limit query (which also contains `COUNT(*)::int FROM invitation`
    // inside a parenthesized subselect).
    if (s.startsWith("SELECT COUNT(*)::int as count FROM invitation")) {
      return [{ count: overrides.pendingCount ?? 0 }];
    }
    // Pending-dedup query: selects the full row for the specific email.
    if (s.startsWith("SELECT id, email, role, \"organizationId\"") && s.includes("FROM invitation")) {
      return overrides.pending ?? [];
    }
    if (s.includes("SELECT (") && s.includes("FROM member") && s.includes("FROM invitation")) {
      return [{ count: overrides.seatCount ?? 1 }];
    }
    // Inviter-resolution query — picks a target-org member to use as
    // `inviterId` so Better Auth's `getInvitation` accepts the row.
    if (s.startsWith("SELECT id, \"userId\", role FROM member")) {
      return overrides.inviterMembers ?? [
        { id: "mbr-owner", userId: "owner-1", role: "owner" },
      ];
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
          inviterId: inviterId ?? "owner-1",
          status: "pending",
          expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt ?? ""),
          createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt ?? ""),
        },
      ];
    }
    if (s.startsWith("DELETE FROM invitation")) {
      overrides.onDelete?.(params?.[0]);
      return [];
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
    // inviterId is the RESOLVED target-org member (owner), not the
    // platform admin caller — Better Auth's accept flow requires the
    // inviter to be a current member of the target organization.
    expect(body.inviterId).toBe("owner-1");
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

  it("returns 409 workspace_inactive when target org is suspended or deleted", async () => {
    mocks.mockInternalQuery.mockImplementation(
      defaultQueryHandler({
        org: [{ id: "target-org", name: "Target Co", workspace_status: "suspended" }],
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
    expect(body.error).toBe("workspace_inactive");
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
      reason: "cap_reached",
      errorMessage: "Workspace seat limit reached.",
      limit: 5,
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

  it("returns 503 billing_check_failed when the seat count can't be verified (#3433)", async () => {
    // `checkResourceLimit` failed closed with `check_failed` — an infra
    // fault, not a plan cap. The invite is still blocked, but the caller
    // must see a transient "try again", never "seat limit — upgrade".
    // Clear accumulated calls from earlier tests so the INSERT assertion
    // below only sees this request's queries.
    mocks.mockInternalQuery.mockClear();
    mocks.mockInternalQuery.mockImplementation(defaultQueryHandler());
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      reason: "check_failed",
      errorMessage: "Unable to verify plan limits. Please try again.",
    }));

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("billing_check_failed");
    expect(body.message).toMatch(/try again/i);
    // Fail-closed: the invitation row was never inserted.
    const insertCalls = mocks.mockInternalQuery.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO invitation"),
    );
    expect(insertCalls.length).toBe(0);
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

  it("returns 400 when role is not in the allow-list (typo)", async () => {
    mocks.mockInternalQuery.mockImplementation(defaultQueryHandler());

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "owenr",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toMatch(/Invalid role.*owenr/);
  });

  it("returns 429 invitation_limit when pending invitations hit the cap", async () => {
    mocks.mockInternalQuery.mockImplementation(
      defaultQueryHandler({ pendingCount: 100 }),
    );

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invitation_limit");
  });

  it("resolves inviterId to a target-org member (not the platform admin)", async () => {
    // The audit row still records the real platform admin
    // (`user.id` = "platform-admin-1") in metadata.inviter, but the
    // invitation.inviterId column must be a target-org member so
    // Better Auth's accept-page lookup succeeds.
    mocks.setPlatformAdmin("org-test");
    mocks.mockInternalQuery.mockImplementation(
      defaultQueryHandler({
        inviterMembers: [{ id: "mbr-1", userId: "target-org-owner", role: "owner" }],
      }),
    );

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvitationResponse;
    expect(body.inviterId).toBe("target-org-owner");

    // Audit still attributes to the real platform admin.
    const auditCall = mockLogAdminAction.mock.calls.at(-1)?.[0] as
      | { metadata?: { orgId?: string } }
      | undefined;
    expect(auditCall?.metadata?.orgId).toBe("target-org");
  });

  it("returns 409 no_members when target org has no members", async () => {
    mocks.mockInternalQuery.mockImplementation(
      defaultQueryHandler({ inviterMembers: [] }),
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
    expect(body.error).toBe("no_members");
  });

  it("rolls back the invitation row when email dispatch fails", async () => {
    const deletedIds: unknown[] = [];
    mocks.mockInternalQuery.mockImplementation(
      defaultQueryHandler({
        onDelete: (id) => deletedIds.push(id),
      }),
    );
    mockSendEmail.mockImplementationOnce(async () => ({
      success: false as const,
      provider: "mock",
      error: "smtp down",
    }) as unknown as Awaited<ReturnType<typeof mockSendEmail>>);

    const res = await app.request(
      platformRequest("POST", "/api/v1/platform/invitations", {
        organizationId: "target-org",
        email: "newuser@example.com",
        role: "member",
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("email_failed");
    // Rollback DELETE was issued exactly once, for the just-inserted id.
    expect(deletedIds.length).toBe(1);
    expect(typeof deletedIds[0]).toBe("string");
    expect((deletedIds[0] as string).length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/platform/invitations/:id (cancel / revoke)
// ---------------------------------------------------------------------------

/**
 * Default query handler for the cancel-route success path. The route
 * uses an atomic `DELETE ... WHERE id=$1 AND status='pending' RETURNING`
 * — the gate-by-status is in SQL, not in JS. Overrides:
 *   - `deleted`: rows the RETURNING clause emits (empty = 404 not-pending/ghost)
 *   - `onDelete`: capture the id parameter for assertions
 */
function defaultCancelQueryHandler(
  overrides: Partial<{
    deleted: Array<Record<string, unknown>>;
    onDelete?: (id: unknown) => void;
  }> = {},
): (sql: string, params?: unknown[]) => Promise<unknown[]> {
  return async (sql, params) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("DELETE FROM invitation")) {
      overrides.onDelete?.(params?.[0]);
      return overrides.deleted ?? [
        {
          id: "inv-cancel-1",
          email: "pending@example.com",
          role: "member",
          organizationId: "target-org",
          inviterId: "owner-1",
          status: "pending",
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
          createdAt: new Date().toISOString(),
        },
      ];
    }
    return [];
  };
}

describe("DELETE /api/v1/platform/invitations/:id", () => {
  it("cancels a cross-org invitation when the caller is not a member of the target org", async () => {
    // Caller's active org diverges from the invitation's TARGET org —
    // the gate-bypass symmetric to the create-side workaround. Native
    // Better Auth `cancelInvitation` would 403 here.
    mocks.setPlatformAdmin("org-test");
    const deletedIds: unknown[] = [];
    mocks.mockInternalQuery.mockImplementation(
      defaultCancelQueryHandler({
        onDelete: (id) => deletedIds.push(id),
      }),
    );

    const res = await app.request(
      platformRequest("DELETE", "/api/v1/platform/invitations/inv-cancel-1"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("inv-cancel-1");
    // DELETE was issued against the id from the path.
    expect(deletedIds).toEqual(["inv-cancel-1"]);
  });

  it("audits with the TARGET orgId from the row, not the caller's active org", async () => {
    // Caller's active org is "org-test"; invitation belongs to
    // "target-org". Audit metadata.orgId must reflect the target.
    mocks.setPlatformAdmin("org-test");
    mocks.mockInternalQuery.mockImplementation(defaultCancelQueryHandler());

    const res = await app.request(
      platformRequest("DELETE", "/api/v1/platform/invitations/inv-cancel-1"),
    );
    expect(res.status).toBe(200);

    expect(mockLogAdminAction).toHaveBeenCalled();
    const lastCall = mockLogAdminAction.mock.calls.at(-1)?.[0] as {
      actionType: string;
      targetId?: string;
      metadata?: { orgId?: string; invitedEmail?: string; role?: string; previousStatus?: string };
    } | undefined;
    expect(lastCall?.actionType).toBe("user.revoke_invitation");
    expect(lastCall?.targetId).toBe("inv-cancel-1");
    expect(lastCall?.metadata?.orgId).toBe("target-org");
    expect(lastCall?.metadata?.invitedEmail).toBe("pending@example.com");
    expect(lastCall?.metadata?.role).toBe("member");
    expect(lastCall?.metadata?.previousStatus).toBe("pending");
  });

  it("refuses to cancel a non-pending invitation (stale UI / race protection)", async () => {
    // The DELETE is gated by `status = 'pending'` in SQL, so an accepted
    // or expired row (stale Revoke click after the recipient accepted
    // in another tab) returns 0 rows from RETURNING and the handler
    // 404s. No audit row is written for the no-op DELETE.
    mocks.mockInternalQuery.mockImplementation(
      defaultCancelQueryHandler({ deleted: [] }),
    );

    const res = await app.request(
      platformRequest("DELETE", "/api/v1/platform/invitations/inv-already-accepted"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toMatch(/not pending/i);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("returns 403 for non-platform_admin callers", async () => {
    mocks.setOrgAdmin("org-1");

    const res = await app.request(
      platformRequest("DELETE", "/api/v1/platform/invitations/inv-cancel-1"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 not_found when the invitation row does not exist", async () => {
    mocks.mockInternalQuery.mockImplementation(
      defaultCancelQueryHandler({ deleted: [] }),
    );

    const res = await app.request(
      platformRequest("DELETE", "/api/v1/platform/invitations/ghost-id"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 404 not_available when internal DB is not configured", async () => {
    mocks.hasInternalDB = false;

    const res = await app.request(
      platformRequest("DELETE", "/api/v1/platform/invitations/inv-cancel-1"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_available");
  });
});
