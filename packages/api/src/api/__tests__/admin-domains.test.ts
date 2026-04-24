/**
 * Tests for admin custom domain API endpoints.
 *
 * Covers the EE-disabled path (loadDomains() returns null) to guarantee write
 * endpoints emit 403 { error: "enterprise_required" } — the contract the web
 * page.tsx `isPlanGated` branch (#1622) and AdminContentWrapper's
 * EnterpriseUpsell routing (feature-disabled.tsx) rely on.
 *
 * Tests the adminDomains sub-router directly (not through the parent admin
 * router) to avoid needing to mock every sub-router dependency.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";

// Real ADMIN_ACTIONS values so assertions pin to the canonical strings.
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";

// --- Auth mock ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

// --- Internal DB mock ---

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: () => Promise.resolve([]),
  internalExecute: () => {},
  getWorkspaceDetails: mock(async () => ({ plan_tier: "free" })),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

// --- Audit mock — capture every logAdminAction emission ---

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  metadata?: Record<string, unknown>;
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
}

const mockLogAdminAction: Mock<(entry: CapturedAuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: () => undefined,
}));

// --- EE domains mock: loadDomains returns null to simulate EE-off build ---
//
// The admin-domains.ts router calls `loadDomains()` from shared-domains.ts,
// which dynamic-imports "@atlas/ee/platform/domains" and catches
// MODULE_NOT_FOUND to return null. Mocking shared-domains lets us control
// that null branch directly without having to forge a MODULE_NOT_FOUND
// from the EE import.

const mockLoadDomains: Mock<() => Promise<unknown>> = mock(() => Promise.resolve(null));

// Preserve the real helper exports — customDomainError is consumed by
// runEffect's error mapping. Re-export with the mocked loadDomains.
const realShared = await import("../routes/shared-domains");

mock.module("../routes/shared-domains", () => ({
  CustomDomainSchema: realShared.CustomDomainSchema,
  DomainCheckResponseSchema: realShared.DomainCheckResponseSchema,
  customDomainError: realShared.customDomainError,
  loadDomains: mockLoadDomains,
}));

// --- Import sub-router AFTER mocks ---

const { adminDomains } = await import("../routes/admin-domains");

// --- Helpers ---

function resetMocks() {
  mockLoadDomains.mockImplementation(() => Promise.resolve(null));
  mockLogAdminAction.mockClear();
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
    }),
  );
}

// --- EE domains stub: load a fake module so POST / DELETE / verify routes
// reach the audit emission path. The stub returns Effect.succeed(...) for
// every method so the Effect.gen handlers run to completion.

function makeDomainRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dom_abc123",
    workspaceId: "org-1",
    domain: "data.acme.com",
    status: "pending",
    createdAt: "2026-04-23T00:00:00Z",
    ...overrides,
  };
}

function enableEe(
  opts: {
    listDomains?: Record<string, unknown>[];
    registerDomain?: Record<string, unknown> | Error;
    verifyDomain?: Record<string, unknown> | Error;
    verifyDomainDnsTxt?: Record<string, unknown> | Error;
    deleteDomain?: true | Error;
    checkDomainAvailability?: Record<string, unknown>;
  } = {},
): void {
  mockLoadDomains.mockImplementation(() =>
    Promise.resolve({
      listDomains: (_orgId: string) => Effect.succeed(opts.listDomains ?? []),
      registerDomain: (_orgId: string, _domain: string) =>
        opts.registerDomain instanceof Error
          ? Effect.fail(opts.registerDomain)
          : Effect.succeed(opts.registerDomain ?? makeDomainRecord()),
      verifyDomain: (_id: string) =>
        opts.verifyDomain instanceof Error
          ? Effect.fail(opts.verifyDomain)
          : Effect.succeed(opts.verifyDomain ?? makeDomainRecord({ status: "verified" })),
      verifyDomainDnsTxt: (_id: string) =>
        opts.verifyDomainDnsTxt instanceof Error
          ? Effect.fail(opts.verifyDomainDnsTxt)
          : Effect.succeed(opts.verifyDomainDnsTxt ?? makeDomainRecord({ status: "dns_verified" })),
      deleteDomain: (_id: string) =>
        opts.deleteDomain instanceof Error ? Effect.fail(opts.deleteDomain) : Effect.succeed(true),
      checkDomainAvailability: (_domain: string, _orgId: string) =>
        Effect.succeed(opts.checkDomainAvailability ?? { available: true }),
      redactDomain: (d: Record<string, unknown>) => d,
    }),
  );
}

async function request(urlPath: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: {} };
  if (body) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return adminDomains.request(`http://localhost${urlPath}`, init);
}

// --- Tests ---

/**
 * Assert the contract shape that `AdminContentWrapper.isEnterpriseRequired()`
 * and `page.tsx` isPlanGated depend on: `{ error: "enterprise_required",
 * message: <non-empty>, requestId: <defined> }`. Pulled into a helper so every
 * write-path test locks down the same shape — otherwise adding a new write
 * endpoint with a subtly different shape would slip through.
 */
async function expectEnterpriseRequired403(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error: string; message: string; requestId: string };
  expect(json.error).toBe("enterprise_required");
  expect(json.message).toBeTruthy();
  expect(json.requestId).toBeDefined();
}

describe("admin custom domain — EE disabled (loadDomains returns null)", () => {
  beforeEach(resetMocks);

  it("POST / returns 403 enterprise_required so the web isPlanGated branch fires", async () => {
    const res = await request("/", "POST", { domain: "data.acme.com" });
    await expectEnterpriseRequired403(res);
  });

  it("DELETE / returns 403 enterprise_required (write endpoint, matches POST)", async () => {
    const res = await request("/", "DELETE");
    await expectEnterpriseRequired403(res);
  });

  it("POST /verify returns 403 enterprise_required (write endpoint)", async () => {
    const res = await request("/verify", "POST");
    await expectEnterpriseRequired403(res);
  });

  it("POST /verify-dns returns 403 enterprise_required (write endpoint)", async () => {
    const res = await request("/verify-dns", "POST");
    await expectEnterpriseRequired403(res);
  });

  it("message does not leak EE module internals (no MODULE_NOT_FOUND, stack, @atlas/ee)", async () => {
    // `classifyError` sanitizes domain-error messages for 5xx but passes 4xx
    // messages through. The EnterpriseError message is hand-authored in
    // admin-domains.ts (EE_REQUIRED_MESSAGE), so this guards against a future
    // refactor that accidentally stringifies a module-load error into the
    // response body. A user-facing 403 should never expose infra internals.
    const res = await request("/", "POST", { domain: "data.acme.com" });
    const json = (await res.json()) as { message: string };
    expect(json.message).not.toMatch(/MODULE_NOT_FOUND|stack|@atlas\/ee/i);
  });

  it("GET / keeps 404 not_available (read endpoints unchanged per #1623 scope)", async () => {
    // Reads are intentionally untouched — AdminContentWrapper still renders
    // FeatureGate(404) on the page. If a future change wants the full
    // EnterpriseUpsell on page load, reads would need to flip too; for now
    // the issue scope is the dead enterprise_required branch on the write
    // path (#1622 → #1623).
    const res = await request("/", "GET");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("not_available");
  });
});

// ---------------------------------------------------------------------------
// F-32 audit-emission regression tests — admin-domains
//
// Every write under /api/v1/admin/domain must produce exactly one
// admin_action_log row on success. The issue tracked four unaudited writes:
// POST / (register), DELETE / (remove), POST /verify, POST /verify-dns.
// ---------------------------------------------------------------------------

describe("admin custom domain — F-32 audit emission", () => {
  beforeEach(resetMocks);

  it("POST / emits domain.workspace_register on success", async () => {
    enableEe({ registerDomain: makeDomainRecord({ id: "dom_new1", domain: "data.acme.com" }) });
    const res = await request("/", "POST", { domain: "data.acme.com" });
    expect(res.status).toBe(201);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("domain.workspace_register");
    expect(entry.targetType).toBe("domain");
    expect(entry.targetId).toBe("dom_new1");
    expect(entry.metadata?.domain).toBe("data.acme.com");
  });

  it("DELETE / emits domain.workspace_remove with the removed domain id", async () => {
    enableEe({ listDomains: [makeDomainRecord({ id: "dom_del1" })] });
    const res = await request("/", "DELETE");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("domain.workspace_remove");
    expect(entry.targetType).toBe("domain");
    expect(entry.targetId).toBe("dom_del1");
  });

  it("POST /verify emits domain.workspace_verify", async () => {
    enableEe({
      listDomains: [makeDomainRecord({ id: "dom_v1" })],
      verifyDomain: makeDomainRecord({ id: "dom_v1", status: "verified" }),
    });
    const res = await request("/verify", "POST");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("domain.workspace_verify");
    expect(entry.targetId).toBe("dom_v1");
  });

  it("POST /verify-dns emits domain.workspace_verify_dns", async () => {
    enableEe({
      listDomains: [makeDomainRecord({ id: "dom_vd1" })],
      verifyDomainDnsTxt: makeDomainRecord({ id: "dom_vd1", status: "dns_verified" }),
    });
    const res = await request("/verify-dns", "POST");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("domain.workspace_verify_dns");
    expect(entry.targetId).toBe("dom_vd1");
  });

  it("GET / does not emit an audit row (read endpoint)", async () => {
    enableEe();
    const res = await request("/", "GET");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("GET /domain-check does not emit an audit row (read endpoint)", async () => {
    enableEe({ checkDomainAvailability: { available: true } });
    const res = await request("/domain-check?domain=test.example.com", "GET");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("POST /verify on an un-configured workspace does not emit (404 short-circuit)", async () => {
    // The handler 404s before reaching verifyDomain(), so no audit row — the
    // probe doesn't land a stale `workspace_verify` event against a domain
    // that doesn't exist.
    enableEe({ listDomains: [] });
    const res = await request("/verify", "POST");
    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
