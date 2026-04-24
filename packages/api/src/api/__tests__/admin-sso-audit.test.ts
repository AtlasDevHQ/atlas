/**
 * Audit regression suite for `admin-sso.ts` — F-29 (#1784).
 *
 * Pins the two gaps closed by this PR:
 *   - `POST /providers/{id}/verify` → `sso.verify_domain`
 *   - `PUT /enforcement` → `sso.enforcement_update`
 *
 * Both are governance-critical: verify flips the DNS ownership check that
 * gates enable, and enforcement toggles workspace-wide password-login
 * blocks. Without these rows an admin could rotate enforcement silently.
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
import { Effect, Data } from "effect";
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

// Mock the EE SSO module: the routes yield `verifyDomain` +
// `setSSOEnforcement` via Effect. Each mock returns a tagged success so
// the handler runs to completion and emits the audit row.
class MockSSOError extends Data.TaggedError("SSOError")<{
  message: string;
  code: "not_found" | "conflict" | "validation";
}> {}
class MockSSOEnforcementError extends Data.TaggedError("SSOEnforcementError")<{
  message: string;
  code: "no_provider" | "not_enterprise";
}> {}

const mockVerifyDomain: Mock<(providerId: string, orgId: string) => Effect.Effect<unknown, unknown, never>> = mock(
  () => Effect.succeed({ status: "verified", message: "DNS record found." }),
);
const mockSetSSOEnforcement: Mock<(orgId: string, enforced: boolean) => Effect.Effect<unknown, unknown, never>> = mock(
  () => Effect.succeed({ enforced: true, orgId: "org-alpha" }),
);

mock.module("@atlas/ee/auth/sso", () => ({
  SSOError: MockSSOError,
  SSOEnforcementError: MockSSOEnforcementError,
  listSSOProviders: () => Effect.succeed([]),
  getSSOProvider: () => Effect.succeed(null),
  createSSOProvider: () => Effect.succeed({ id: "prov-1" }),
  updateSSOProvider: () => Effect.succeed({ id: "prov-1" }),
  deleteSSOProvider: () => Effect.succeed(true),
  redactProvider: (p: unknown) => p,
  summarizeProvider: (p: unknown) => p,
  setSSOEnforcement: mockSetSSOEnforcement,
  isSSOEnforced: () => Effect.succeed({ enforced: false }),
  verifyDomain: mockVerifyDomain,
  checkDomainAvailability: () => Effect.succeed({ available: true }),
  testSSOProvider: () => Effect.succeed({ type: "oidc", success: true, testedAt: "", details: {} }),
}));

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
  mockVerifyDomain.mockClear();
  mockVerifyDomain.mockImplementation(() =>
    Effect.succeed({ status: "verified", message: "DNS record found." }),
  );
  mockSetSSOEnforcement.mockClear();
  mockSetSSOEnforcement.mockImplementation(() =>
    Effect.succeed({ enforced: true, orgId: "org-alpha" }),
  );
});

// ---------------------------------------------------------------------------
// POST /providers/:id/verify
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/sso/providers/:id/verify — audit emission (F-29)", () => {
  it("emits sso.verify_domain with success status when DNS verification passes", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/sso/providers/prov-abc/verify"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("sso.verify_domain");
    expect(entry.targetType).toBe("sso");
    expect(entry.targetId).toBe("prov-abc");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({ result: "verified" });
  });

  it("emits sso.verify_domain with failure status when DNS verification fails", async () => {
    mockVerifyDomain.mockImplementation(() =>
      Effect.succeed({ status: "failed", message: "TXT record not found." }),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/sso/providers/prov-abc/verify"),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("sso.verify_domain");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({ result: "failed" });
  });

  it("threads x-forwarded-for into ipAddress", async () => {
    const req = new Request(
      "http://localhost/api/v1/admin/sso/providers/prov-abc/verify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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

// ---------------------------------------------------------------------------
// PUT /enforcement
// ---------------------------------------------------------------------------

describe("PUT /api/v1/admin/sso/enforcement — audit emission (F-29)", () => {
  it("emits sso.enforcement_update when toggling enforcement on", async () => {
    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/sso/enforcement", { enforced: true }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("sso.enforcement_update");
    expect(entry.targetType).toBe("sso");
    expect(entry.targetId).toBe("org-alpha");
    expect(entry.metadata).toMatchObject({ enforced: true });
  });

  it("emits sso.enforcement_update when toggling enforcement off", async () => {
    mockSetSSOEnforcement.mockImplementation(() =>
      Effect.succeed({ enforced: false, orgId: "org-alpha" }),
    );

    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/sso/enforcement", { enforced: false }),
    );
    expect(res.status).toBe(200);
    expect(lastAuditCall().metadata).toMatchObject({ enforced: false });
  });

  it("does not emit when setSSOEnforcement rejects with a domain error", async () => {
    // `no_provider` is the motivating case: caller asks to enable
    // enforcement but the workspace has no active SSO provider. The
    // Effect domain error short-circuits before the audit emission,
    // so no row lands — consistent with "don't log actions that
    // didn't happen." Pinned so a future "emit failure rows for
    // rejected enforcement toggles" change explicitly revisits the
    // policy here instead of silently flipping behavior.
    mockSetSSOEnforcement.mockImplementation(() =>
      Effect.fail(new MockSSOEnforcementError({
        message: "No active SSO provider",
        code: "no_provider",
      })),
    );

    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/sso/enforcement", { enforced: true }),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
