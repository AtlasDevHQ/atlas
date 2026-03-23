/**
 * Tests for public branding API endpoint.
 *
 * Covers: GET /api/v1/branding — session-scoped org resolution,
 * field stripping, auth failure fallback.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// --- Auth mock ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "user-1", mode: "managed", label: "User", role: "member", activeOrganizationId: "org-1" },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  _stopCleanup: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

// --- EE branding mock ---

let mockPublicBranding: Record<string, unknown> | null = null;

mock.module("@atlas/ee/branding/white-label", () => ({
  getWorkspaceBrandingPublic: async () => mockPublicBranding,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- Import after mocks ---

const { publicBranding } = await import("../routes/public-branding");

// --- Helpers ---

function resetMocks() {
  mockPublicBranding = null;
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "user-1", mode: "managed", label: "User", role: "member", activeOrganizationId: "org-1" },
    }),
  );
}

async function publicRequest() {
  return publicBranding.request("http://localhost/");
}

// --- Tests ---

describe("GET /api/v1/branding", () => {
  beforeEach(resetMocks);

  it("returns null when no branding configured", async () => {
    mockPublicBranding = null;
    const res = await publicRequest();
    expect(res.status).toBe(200);
    const json = await res.json() as { branding: unknown };
    expect(json.branding).toBeNull();
  });

  it("returns only public-safe fields (strips id, orgId, timestamps)", async () => {
    mockPublicBranding = {
      id: "b-secret",
      orgId: "org-secret",
      logoUrl: "https://example.com/logo.png",
      logoText: "Acme",
      primaryColor: "#FF0000",
      faviconUrl: "https://example.com/fav.ico",
      hideAtlasBranding: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    const res = await publicRequest();
    expect(res.status).toBe(200);
    const json = await res.json() as { branding: Record<string, unknown> };
    expect(json.branding).not.toBeNull();
    // Public fields present
    expect(json.branding.logoUrl).toBe("https://example.com/logo.png");
    expect(json.branding.logoText).toBe("Acme");
    expect(json.branding.primaryColor).toBe("#FF0000");
    expect(json.branding.faviconUrl).toBe("https://example.com/fav.ico");
    expect(json.branding.hideAtlasBranding).toBe(true);
    // Internal fields stripped
    expect(json.branding.id).toBeUndefined();
    expect(json.branding.orgId).toBeUndefined();
    expect(json.branding.createdAt).toBeUndefined();
    expect(json.branding.updatedAt).toBeUndefined();
  });

  it("returns null branding when auth fails", async () => {
    mockAuthenticateRequest.mockImplementation(() => Promise.reject(new Error("auth broken")));
    const res = await publicRequest();
    expect(res.status).toBe(200);
    const json = await res.json() as { branding: unknown };
    expect(json.branding).toBeNull();
  });

  it("returns null branding when not authenticated", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, status: 401, error: "Not authenticated" }),
    );
    const res = await publicRequest();
    expect(res.status).toBe(200);
    const json = await res.json() as { branding: unknown };
    expect(json.branding).toBeNull();
  });

  it("returns null branding when no active org", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "User", role: "member" },
      }),
    );
    const res = await publicRequest();
    expect(res.status).toBe(200);
    const json = await res.json() as { branding: unknown };
    expect(json.branding).toBeNull();
  });
});
