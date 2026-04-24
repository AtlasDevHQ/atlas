/**
 * Tests for admin branding API endpoints.
 *
 * Tests the adminBranding sub-router directly (not through the parent admin
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

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: () => Promise.resolve([]),
  internalExecute: () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

// --- EE branding mock ---

let mockBranding: Record<string, unknown> | null = null;
let mockSetResult: Record<string, unknown> | null = null;
let mockDeleteResult = false;
let mockEeError: Error | null = null;

const { BrandingError: RealBrandingError } = await import("@atlas/ee/branding/white-label");
const { EnterpriseError } = await import("@atlas/ee/index");

mock.module("@atlas/ee/branding/white-label", () => ({
  getWorkspaceBranding: () => {
    if (mockEeError) return Effect.fail(mockEeError);
    return Effect.succeed(mockBranding);
  },
  setWorkspaceBranding: () => {
    if (mockEeError) return Effect.fail(mockEeError);
    return Effect.succeed(mockSetResult);
  },
  deleteWorkspaceBranding: () => {
    if (mockEeError) return Effect.fail(mockEeError);
    return Effect.succeed(mockDeleteResult);
  },
  BrandingError: RealBrandingError,
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

// --- Import sub-router directly ---

const { adminBranding } = await import("../routes/admin-branding");

// --- Helpers ---

function resetMocks() {
  mockHasInternalDB = true;
  mockBranding = null;
  mockSetResult = null;
  mockDeleteResult = false;
  mockEeError = null;
  mockLogAdminAction.mockClear();
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
    }),
  );
}

async function request(method: string, body?: unknown) {
  const init: RequestInit = { method, headers: {} };
  if (body) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return adminBranding.request("http://localhost/", init);
}

// --- Tests ---

describe("GET /api/v1/admin/branding", () => {
  beforeEach(resetMocks);

  it("returns branding when found", async () => {
    mockBranding = { id: "b-1", orgId: "org-1", logoUrl: "https://x.com/logo.png", logoText: "Acme", primaryColor: "#FF0000", faviconUrl: null, hideAtlasBranding: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const res = await request("GET");
    expect(res.status).toBe(200);
    const json = await res.json() as { branding: unknown };
    expect(json.branding).not.toBeNull();
  });

  it("returns null when no branding", async () => {
    mockBranding = null;
    const res = await request("GET");
    expect(res.status).toBe(200);
    const json = await res.json() as { branding: unknown };
    expect(json.branding).toBeNull();
  });

  it("returns 404 when no internal DB", async () => {
    mockHasInternalDB = false;
    const res = await request("GET");
    expect(res.status).toBe(404);
  });

  it("returns 403 when enterprise disabled", async () => {
    mockEeError = new EnterpriseError("Enterprise features (branding) are not enabled.");
    const res = await request("GET");
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("enterprise_required");
  });

  it("returns 400 when no active org", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: undefined },
      }),
    );
    const res = await request("GET");
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, status: 401, error: "Not authenticated" }),
    );
    const res = await request("GET");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "User", role: "member", activeOrganizationId: "org-1" },
      }),
    );
    const res = await request("GET");
    expect(res.status).toBe(403);
  });

  it("returns 500 with requestId on unexpected error", async () => {
    mockEeError = new Error("unexpected db failure");
    const res = await request("GET");
    expect(res.status).toBe(500);
    const json = await res.json() as { requestId: string; error: string };
    expect(json.requestId).toBeDefined();
    expect(json.error).toBe("internal_error");
  });
});

describe("PUT /api/v1/admin/branding", () => {
  beforeEach(resetMocks);

  it("returns 200 with saved branding", async () => {
    mockSetResult = { id: "b-1", orgId: "org-1", logoUrl: null, logoText: "Test", primaryColor: null, faviconUrl: null, hideAtlasBranding: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const res = await request("PUT", { logoText: "Test" });
    expect(res.status).toBe(200);
    const json = await res.json() as { branding: { logoText: string } };
    expect(json.branding.logoText).toBe("Test");
  });

  it("returns 403 when enterprise disabled", async () => {
    mockEeError = new EnterpriseError("Enterprise features (branding) are not enabled.");
    const res = await request("PUT", { logoText: "Test" });
    expect(res.status).toBe(403);
  });

  it("returns 404 when no internal DB", async () => {
    mockHasInternalDB = false;
    const res = await request("PUT", { logoText: "Test" });
    expect(res.status).toBe(404);
  });

  it("returns 400 on BrandingError validation", async () => {
    mockEeError = new RealBrandingError({ message: "Invalid primary color", code: "validation" });
    const res = await request("PUT", { primaryColor: "bad" });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("validation");
  });
});

describe("DELETE /api/v1/admin/branding", () => {
  beforeEach(resetMocks);

  it("returns 200 on successful delete", async () => {
    mockDeleteResult = true;
    const res = await request("DELETE");
    expect(res.status).toBe(200);
    const json = await res.json() as { message: string };
    expect(json.message).toContain("reset");
  });

  it("returns 404 when no branding found", async () => {
    mockDeleteResult = false;
    const res = await request("DELETE");
    expect(res.status).toBe(404);
  });

  it("returns 403 when enterprise disabled", async () => {
    mockEeError = new EnterpriseError("Enterprise features (branding) are not enabled.");
    const res = await request("DELETE");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// F-32 audit-emission regression tests — admin-branding
//
// An admin can silently re-skin the product before phishing tenant users;
// the audit row is the only trail. See F-32 in
// .claude/research/security-audit-1-2-3.md.
// ---------------------------------------------------------------------------

describe("admin branding — F-32 audit emission", () => {
  beforeEach(resetMocks);

  it("PUT / emits branding.update on success", async () => {
    mockSetResult = {
      id: "brand_1",
      orgId: "org-1",
      logoUrl: null,
      logoText: "Acme",
      primaryColor: "#FF5500",
      faviconUrl: null,
      hideAtlasBranding: true,
      createdAt: "2026-04-23T00:00:00Z",
      updatedAt: "2026-04-23T00:00:00Z",
    };
    const res = await request("PUT", {
      logoText: "Acme",
      primaryColor: "#FF5500",
      hideAtlasBranding: true,
    });
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("branding.update");
    expect(entry.targetType).toBe("branding");
    expect(entry.targetId).toBe("org-1");
    // `hideAtlasBranding: true` is the high-stakes field (governance: a
    // phishing admin wants the word "Atlas" gone). Metadata must preserve
    // the fields the admin *intended* to change so compliance review can
    // distinguish a cosmetic logo tweak from a white-label takeover.
    expect(entry.metadata?.hideAtlasBranding).toBe(true);
    expect(entry.metadata?.primaryColor).toBe("#FF5500");
  });

  it("DELETE / emits branding.delete on successful reset", async () => {
    mockDeleteResult = true;
    const res = await request("DELETE");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("branding.delete");
    expect(entry.targetType).toBe("branding");
    expect(entry.targetId).toBe("org-1");
  });

  it("DELETE / does not emit when no branding exists to reset", async () => {
    // No custom branding = nothing to audit. Emitting a delete row for a
    // no-op would pollute forensic queries counting actual branding changes.
    mockDeleteResult = false;
    const res = await request("DELETE");
    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("GET / does not emit an audit row (read endpoint)", async () => {
    mockBranding = null;
    const res = await request("GET");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
