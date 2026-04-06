/**
 * Tests for SSO test connection endpoint.
 *
 * Covers: POST /api/v1/admin/sso/providers/:id/test
 * - OIDC: valid discovery, unreachable/timeout, non-JSON response, missing fields, issuer mismatch
 * - SAML: valid cert, expired cert, malformed PEM
 * - 404 for non-existent provider, 404 for wrong org, 403 for non-admin
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

// --- Unified mocks ---

const mocks = createApiTestMocks();

// --- SSO mock overrides ---

// Stable error classes shared between mock module and test assertions.
// domainError() uses instanceof — the test must fail with the same class.
class MockSSOError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SSOError";
    this.code = code;
  }
}

class MockSSOEnforcementError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SSOEnforcementError";
    this.code = code;
  }
}

const mockGetSSOProvider: Mock<(orgId: string, providerId: string) => Effect.Effect<unknown, unknown>> =
  mock(() => Effect.succeed(null));
const mockTestSSOProvider: Mock<(orgId: string, providerId: string) => Effect.Effect<unknown, unknown>> =
  mock(() => Effect.succeed({ type: "oidc", success: true, testedAt: "2026-04-06T00:00:00.000Z", details: {} }));

mock.module("@atlas/ee/auth/sso", () => ({
  // CRUD (unused but must be mocked)
  listSSOProviders: mock(() => Effect.succeed([])),
  getSSOProvider: mockGetSSOProvider,
  createSSOProvider: mock(() => Effect.succeed({})),
  updateSSOProvider: mock(() => Effect.succeed({})),
  deleteSSOProvider: mock(() => Effect.succeed(false)),
  // Test
  testSSOProvider: mockTestSSOProvider,
  testOidcProvider: mock(async () => ({ type: "oidc", success: true, testedAt: "2026-04-06T00:00:00.000Z", details: {} })),
  testSamlProvider: mock(async () => ({ type: "saml", success: true, testedAt: "2026-04-06T00:00:00.000Z", details: {} })),
  // Enforcement
  setSSOEnforcement: mock(() => Effect.succeed({ enforced: false, orgId: "org-1" })),
  isSSOEnforced: mock(() => Effect.succeed({ enforced: false })),
  isSSOEnforcedForDomain: mock(() => Effect.succeed({ enforced: false })),
  // View helpers
  redactProvider: (p: unknown) => p,
  summarizeProvider: (p: unknown) => p,
  // Validation helpers
  isValidDomain: () => true,
  isValidSSOProviderType: (t: string) => ["saml", "oidc"].includes(t),
  validateSamlConfig: () => true,
  validateOidcConfig: () => true,
  validateProviderConfig: () => null,
  // Domain matching
  findProviderByDomain: mock(() => Effect.succeed(null)),
  extractEmailDomain: (e: string) => e.split("@")[1] ?? null,
  // Error classes — must be the same reference used in tests
  SSOError: MockSSOError,
  SSOEnforcementError: MockSSOEnforcementError,
  // Types re-exported
  SSO_PROVIDER_TYPES: ["saml", "oidc"],
}));

// --- Import app after mocks ---

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// --- Helper ---

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

// --- Tests ---

describe("Admin SSO Test Connection API", () => {
  beforeEach(() => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "admin-1",
          mode: "simple-key",
          label: "Admin",
          role: "admin",
          activeOrganizationId: "org-1",
        },
      }),
    );
  });

  // --- POST /api/v1/admin/sso/providers/:id/test ---

  describe("POST /api/v1/admin/sso/providers/:id/test", () => {
    it("returns OIDC test result with valid discovery", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "oidc",
          success: true,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            discoveryReachable: true,
            issuerMatch: true,
            requiredFieldsPresent: true,
            endpoints: {
              issuer: "https://idp.example.com",
              authorization_endpoint: "https://idp.example.com/auth",
              token_endpoint: "https://idp.example.com/token",
              jwks_uri: "https://idp.example.com/jwks",
            },
          },
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-1/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.type).toBe("oidc");
      expect(body.success).toBe(true);
      expect(body.testedAt).toBe("2026-04-06T00:00:00.000Z");
      const details = body.details as Record<string, unknown>;
      expect(details.discoveryReachable).toBe(true);
      expect(details.issuerMatch).toBe(true);
      expect(details.requiredFieldsPresent).toBe(true);
    });

    it("returns OIDC failure for unreachable discovery URL", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "oidc",
          success: false,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            discoveryReachable: false,
            issuerMatch: false,
            requiredFieldsPresent: false,
            endpoints: {},
          },
          errors: ["Discovery URL timed out after 5000ms"],
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-1/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect((body.errors as string[])[0]).toContain("timed out");
    });

    it("returns OIDC failure for non-JSON response", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "oidc",
          success: false,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            discoveryReachable: false,
            issuerMatch: false,
            requiredFieldsPresent: false,
            endpoints: {},
          },
          errors: ["Discovery URL returned non-JSON body (Unexpected token <)"],
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-1/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect((body.errors as string[])[0]).toContain("non-JSON");
    });

    it("returns OIDC failure for missing discovery fields", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "oidc",
          success: false,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            discoveryReachable: true,
            issuerMatch: false,
            requiredFieldsPresent: false,
            endpoints: { issuer: "https://idp.example.com" },
          },
          errors: ["Discovery document missing required fields: authorization_endpoint, token_endpoint, jwks_uri"],
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-1/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect((body.errors as string[])[0]).toContain("missing required fields");
    });

    it("returns OIDC failure for issuer mismatch", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "oidc",
          success: false,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            discoveryReachable: true,
            issuerMatch: false,
            requiredFieldsPresent: true,
            endpoints: {},
          },
          errors: ['Issuer mismatch: discovery has "https://other.com", provider configured with "https://idp.example.com"'],
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-1/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect((body.errors as string[])[0]).toContain("Issuer mismatch");
    });

    it("returns SAML test result with valid certificate", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "saml",
          success: true,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            certValid: true,
            certSubject: "CN=idp.example.com",
            certExpiry: "2027-01-01T00:00:00Z",
            certDaysRemaining: 270,
            idpReachable: true,
          },
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-2/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.type).toBe("saml");
      expect(body.success).toBe(true);
      expect(body.testedAt).toBe("2026-04-06T00:00:00.000Z");
      const details = body.details as Record<string, unknown>;
      expect(details.certValid).toBe(true);
      expect(details.idpReachable).toBe(true);
    });

    it("returns SAML failure for expired certificate", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "saml",
          success: false,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            certValid: false,
            certSubject: "CN=idp.example.com",
            certExpiry: "2025-01-01T00:00:00Z",
            certDaysRemaining: -400,
            idpReachable: true,
          },
          errors: ["Certificate expired 400 day(s) ago"],
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-2/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect((body.errors as string[])[0]).toContain("expired");
    });

    it("returns SAML failure for malformed PEM", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "saml",
          success: false,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            certValid: false,
            certSubject: null,
            certExpiry: null,
            certDaysRemaining: null,
            idpReachable: null,
          },
          errors: ["Malformed PEM certificate: unable to parse"],
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-2/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect((body.errors as string[])[0]).toContain("Malformed PEM");
    });

    it("returns SAML warning for cert expiring within 30 days", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "saml",
          success: true,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: {
            certValid: true,
            certSubject: "CN=idp.example.com",
            certExpiry: "2026-04-20T00:00:00Z",
            certDaysRemaining: 14,
            idpReachable: true,
          },
          warnings: ["Certificate expires in 14 day(s) — consider renewing soon"],
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-2/test"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // success is true — expiry warning does not fail the test
      expect(body.success).toBe(true);
      expect((body.warnings as string[])[0]).toContain("expires in 14 day(s)");
      expect(body.errors).toBeUndefined();
    });

    it("returns 404 for non-existent provider", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.fail(new MockSSOError("SSO provider not found.", "not_found")),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/nonexistent/test"),
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 for provider in different org", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.fail(new MockSSOError("SSO provider not found.", "not_found")),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-other-org/test"),
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 for non-admin user", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: {
            id: "user-1",
            mode: "simple-key",
            label: "User",
            role: "member",
            activeOrganizationId: "org-1",
          },
        }),
      );

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/sso/providers/prov-1/test"),
      );
      expect(res.status).toBe(403);
    });
  });
});
