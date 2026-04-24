/**
 * Audit regression suite for `admin-invitations.ts` — F-29 residuals (#1828).
 *
 * Pins the gap closed by this PR:
 *   - `DELETE /users/invitations/:id` → `user.revoke_invitation`
 *
 * Invitation revoke is the last unaudited edge in the
 * `user.invite` / Better-Auth-accept / revoke lifecycle. Without the row a
 * workspace admin can un-invite users silently — compliance queries
 * counting `invite → revoked` transitions would return zero.
 *
 * Pre-fetch pattern: the route reads `email` + `role` + `status` BEFORE the
 * UPDATE so the audit row carries forensic context even if the invitations
 * table itself is later retention-purged. The test asserts the row reflects
 * the pre-fetched values, not whatever the UPDATE returned.
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
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

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

function adminRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  });
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

/**
 * The route runs two queries in sequence: SELECT (pre-fetch) then UPDATE.
 * `once` queue feeds mockInternalQuery in order so the handler sees the
 * SELECT row first, then the UPDATE RETURNING result.
 */
function queueQueries(rows: unknown[][]): void {
  mocks.mockInternalQuery.mockReset();
  for (const r of rows) {
    mocks.mockInternalQuery.mockImplementationOnce(async () => r);
  }
  // Default empty result for any trailing query so the mock doesn't throw.
  mocks.mockInternalQuery.mockImplementation(async () => []);
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
});

// ---------------------------------------------------------------------------
// DELETE /users/invitations/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/admin/users/invitations/:id — audit emission (F-29 residuals)", () => {
  it("emits user.revoke_invitation with pre-fetched email + role + previousStatus", async () => {
    queueQueries([
      // Pre-fetch: existing pending invite
      [{ email: "pending@test.com", role: "admin", status: "pending" }],
      // UPDATE ... RETURNING id
      [{ id: "inv-1" }],
    ]);

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/users/invitations/inv-1"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.revoke_invitation");
    expect(entry.targetType).toBe("user");
    expect(entry.targetId).toBe("inv-1");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      invitedEmail: "pending@test.com",
      role: "admin",
      previousStatus: "pending",
    });
  });

  it("does not emit when the invitation does not exist (404)", async () => {
    queueQueries([
      [], // pre-fetch returns nothing
      [], // UPDATE affects zero rows
    ]);

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/users/invitations/inv-missing"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("does not emit when the invitation already resolved (404)", async () => {
    // Pre-fetch finds the row but UPDATE's `status = 'pending'` guard filters
    // it out — the caller sees 404 and no audit row lands. Mirrors the
    // "don't log actions that didn't happen" policy pinned in
    // admin-sso-audit's enforcement test.
    queueQueries([
      [{ email: "accepted@test.com", role: "member", status: "accepted" }],
      [], // UPDATE affects zero rows — already accepted
    ]);

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/users/invitations/inv-accepted"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("does not emit when internal DB is unavailable (404)", async () => {
    mocks.hasInternalDB = false;

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/users/invitations/inv-1"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("threads x-forwarded-for into ipAddress", async () => {
    queueQueries([
      [{ email: "fwd@test.com", role: "member", status: "pending" }],
      [{ id: "inv-fwd" }],
    ]);

    const req = new Request(
      "http://localhost/api/v1/admin/users/invitations/inv-fwd",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer test-key",
          "x-forwarded-for": "203.0.113.7",
        },
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(lastAuditCall().ipAddress).toBe("203.0.113.7");
  });
});
