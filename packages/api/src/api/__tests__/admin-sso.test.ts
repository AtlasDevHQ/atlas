/**
 * Tests for admin SSO endpoints.
 *
 * Covers:
 * - POST /providers/:id/verify — DNS TXT verification
 * - GET /domain-check — domain availability
 * - POST /providers — create generates verification token, forces enabled=false
 * - PATCH /providers/:id — domain change resets verification
 * - PATCH /providers/:id — enable blocked when domain unverified
 * - POST /providers/:id/test — OIDC/SAML connection testing
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
import type { SSOProvider } from "@useatlas/types";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock needs flexible return type for success/failure paths
const mockVerifyDomain: Mock<(providerId: string, orgId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed({ status: "verified", message: "Domain verified successfully." }),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock needs flexible return type for success/failure paths
const mockCheckDomainAvailability: Mock<(domain: string, orgId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed({ available: true }),
);
const mockCreateSSOProvider: Mock<(orgId: string, input: unknown) => Effect.Effect<SSOProvider>> = mock(
  () => Effect.die(new Error("not configured")),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock needs flexible return type for success/failure paths
const mockUpdateSSOProvider: Mock<(orgId: string, providerId: string, input: unknown) => Effect.Effect<any, any>> = mock(
  () => Effect.die(new Error("not configured")),
);
const mockGetSSOProvider: Mock<(orgId: string, providerId: string) => Effect.Effect<unknown, unknown>> =
  mock(() => Effect.succeed(null));
const mockTestSSOProvider: Mock<(orgId: string, providerId: string) => Effect.Effect<unknown, unknown>> =
  mock(() => Effect.succeed({ type: "oidc", success: true, testedAt: "2026-04-06T00:00:00.000Z", details: {} }));

mock.module("@atlas/ee/auth/sso", () => ({
  // CRUD
  listSSOProviders: mock(() => Effect.succeed([])),
  getSSOProvider: mockGetSSOProvider,
  createSSOProvider: mockCreateSSOProvider,
  updateSSOProvider: mockUpdateSSOProvider,
  deleteSSOProvider: mock(() => Effect.succeed(false)),
  // Domain verification
  verifyDomain: mockVerifyDomain,
  checkDomainAvailability: mockCheckDomainAvailability,
  generateVerificationToken: () => "atlas-verify=test-uuid-1234",
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
  summarizeProvider: (p: SSOProvider) => {
    const { config: _config, ...rest } = p;
    return rest;
  },
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

// --- Helpers ---

function adminRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${urlPath}`, opts);
}

function makeProvider(overrides: Partial<SSOProvider> = {}): SSOProvider {
  return {
    id: "prov-1",
    orgId: "org-alpha",
    type: "saml",
    issuer: "https://idp.acme.com",
    domain: "acme.com",
    enabled: false,
    ssoEnforced: false,
    config: {
      idpEntityId: "https://idp.acme.com",
      idpSsoUrl: "https://idp.acme.com/sso",
      idpCertificate: "MIIC...",
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    verificationToken: "atlas-verify=test-uuid-1234",
    domainVerified: false,
    domainVerifiedAt: null,
    domainVerificationStatus: "pending",
    ...overrides,
  } as SSOProvider;
}

// --- Cleanup ---

afterAll(() => mocks.cleanup());

// ── Domain Verification Tests ──────────────────────────────────────

describe("admin SSO — domain verification", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    mockVerifyDomain.mockReset();
    mockCheckDomainAvailability.mockReset();
    mockCreateSSOProvider.mockReset();
    mockUpdateSSOProvider.mockReset();
    mockGetSSOProvider.mockReset();
    mocks.setOrgAdmin("org-alpha");
  });

  // ─── POST /providers/:id/verify — DNS verification ─────────────────

  describe("POST /providers/:id/verify", () => {
    it("returns verified when DNS TXT record matches token", async () => {
      mockVerifyDomain.mockImplementation(() =>
        Effect.succeed({ status: "verified", message: "Domain verified successfully." }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1/verify", "POST"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; message: string };
      expect(body.status).toBe("verified");
      expect(body.message).toContain("verified successfully");
    });

    it("returns failed when no matching TXT record found", async () => {
      mockVerifyDomain.mockImplementation(() =>
        Effect.succeed({ status: "failed", message: "No matching TXT record found." }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1/verify", "POST"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; message: string };
      expect(body.status).toBe("failed");
      expect(body.message).toContain("No matching TXT record");
    });

    it("returns failed when DNS lookup times out", async () => {
      mockVerifyDomain.mockImplementation(() =>
        Effect.succeed({ status: "failed", message: "DNS lookup failed: queryTxt ETIMEOUT acme.com" }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1/verify", "POST"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; message: string };
      expect(body.status).toBe("failed");
      expect(body.message).toContain("DNS lookup failed");
    });

    it("returns 404 when provider not found", async () => {
      mockVerifyDomain.mockImplementation(() =>
        Effect.fail(new MockSSOError("SSO provider not found.", "not_found")),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-nonexistent/verify", "POST"),
      );

      expect(res.status).toBe(404);
    });

    it("returns verified immediately if domain already verified", async () => {
      mockVerifyDomain.mockImplementation(() =>
        Effect.succeed({ status: "verified", message: "Domain is already verified." }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1/verify", "POST"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; message: string };
      expect(body.status).toBe("verified");
      expect(body.message).toContain("already verified");
    });
  });

  // ─── GET /domain-check ─────────────────────────────────────────────

  describe("GET /domain-check", () => {
    it("returns available=true for unclaimed domain", async () => {
      mockCheckDomainAvailability.mockImplementation(() =>
        Effect.succeed({ available: true }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/domain-check?domain=newdomain.com"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; reason?: string };
      expect(body.available).toBe(true);
    });

    it("returns available=false with reason for domain taken by same org", async () => {
      mockCheckDomainAvailability.mockImplementation(() =>
        Effect.succeed({ available: false, reason: "Domain is already registered by your organization." }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/domain-check?domain=acme.com"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; reason?: string };
      expect(body.available).toBe(false);
      expect(body.reason).toContain("your organization");
    });

    it("returns available=false with reason for domain taken by other org", async () => {
      mockCheckDomainAvailability.mockImplementation(() =>
        Effect.succeed({ available: false, reason: "Domain is already registered by another organization." }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/domain-check?domain=acme.com"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; reason?: string };
      expect(body.available).toBe(false);
      expect(body.reason).toContain("another organization");
    });

    it("returns available=false for invalid domain format", async () => {
      mockCheckDomainAvailability.mockImplementation(() =>
        Effect.succeed({ available: false, reason: "Invalid domain format." }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/domain-check?domain=not-a-domain"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; reason?: string };
      expect(body.available).toBe(false);
      expect(body.reason).toContain("Invalid domain");
    });
  });

  // ─── POST /providers — create generates token, forces enabled=false ─

  describe("POST /providers — verification token", () => {
    it("creates provider with verification token and enabled=false", async () => {
      const provider = makeProvider();
      mockCreateSSOProvider.mockImplementation(() => Effect.succeed(provider));

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers", "POST", {
          type: "saml",
          issuer: "https://idp.acme.com",
          domain: "acme.com",
          enabled: true, // Should be forced to false by the service
          config: {
            idpEntityId: "https://idp.acme.com",
            idpSsoUrl: "https://idp.acme.com/sso",
            idpCertificate: "MIIC...",
          },
        }),
      );

      expect(res.status).toBe(201);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.provider.enabled).toBe(false);
      expect(body.provider.verificationToken).toStartWith("atlas-verify=");
      expect(body.provider.domainVerified).toBe(false);
      expect(body.provider.domainVerificationStatus).toBe("pending");
      expect(mockCreateSSOProvider).toHaveBeenCalled();
    });
  });

  // ─── PATCH /providers/:id — domain change resets verification ──────

  describe("PATCH /providers/:id — domain change", () => {
    it("returns updated provider with reset verification when domain changes", async () => {
      const updated = makeProvider({
        domain: "newdomain.com",
        domainVerified: false,
        domainVerificationStatus: "pending",
        verificationToken: "atlas-verify=new-token",
      });
      mockUpdateSSOProvider.mockImplementation(() => Effect.succeed(updated));

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1", "PATCH", {
          domain: "newdomain.com",
        }),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.provider.domain).toBe("newdomain.com");
      expect(body.provider.domainVerified).toBe(false);
      expect(body.provider.domainVerificationStatus).toBe("pending");
      expect(mockUpdateSSOProvider).toHaveBeenCalled();
    });
  });

  // ─── PATCH /providers/:id — enable blocked when unverified ─────────

  describe("PATCH /providers/:id — enable guard", () => {
    it("returns error when trying to enable an unverified provider", async () => {
      mockUpdateSSOProvider.mockImplementation(() =>
        Effect.fail(new MockSSOError(
          "Cannot enable SSO provider until domain is verified. Verify domain ownership first.",
          "validation",
        )),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1", "PATCH", {
          enabled: true,
        }),
      );

      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.message).toContain("domain is verified");
    });

    it("allows enabling when domain is verified", async () => {
      const enabled = makeProvider({
        enabled: true,
        domainVerified: true,
        domainVerificationStatus: "verified",
        domainVerifiedAt: "2026-01-02T00:00:00Z",
      });
      mockUpdateSSOProvider.mockImplementation(() => Effect.succeed(enabled));

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1", "PATCH", {
          enabled: true,
        }),
      );

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.provider.enabled).toBe(true);
      expect(body.provider.domainVerified).toBe(true);
    });
  });
});

// ── Test Connection Tests ──────────────────────────────────────────

describe("Admin SSO Test Connection API", () => {
  beforeEach(() => {
    mockTestSSOProvider.mockReset();
    mocks.setOrgAdmin("org-1");
  });

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
        adminRequest("/api/v1/admin/sso/providers/prov-1/test", "POST"),
      );
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.type).toBe("oidc");
      expect(body.success).toBe(true);
      expect(body.details.discoveryReachable).toBe(true);
    });

    it("returns OIDC failure for unreachable discovery URL", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "oidc",
          success: false,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: { discoveryReachable: false, issuerMatch: false, requiredFieldsPresent: false, endpoints: {} },
          errors: ["Discovery URL timed out after 5000ms"],
        }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1/test", "POST"),
      );
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.success).toBe(false);
      expect(body.errors[0]).toContain("timed out");
    });

    it("returns SAML test result with valid certificate", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.succeed({
          type: "saml",
          success: true,
          testedAt: "2026-04-06T00:00:00.000Z",
          details: { certValid: true, certSubject: "CN=idp.example.com", certExpiry: "2027-01-01T00:00:00Z", certDaysRemaining: 270, idpReachable: true },
        }),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-2/test", "POST"),
      );
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.type).toBe("saml");
      expect(body.success).toBe(true);
      expect(body.details.certValid).toBe(true);
    });

    it("returns 404 for non-existent provider", async () => {
      mockTestSSOProvider.mockImplementation(() =>
        Effect.fail(new MockSSOError("SSO provider not found.", "not_found")),
      );

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/nonexistent/test", "POST"),
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 for non-admin user", async () => {
      mocks.setMember("org-1");

      const res = await app.fetch(
        adminRequest("/api/v1/admin/sso/providers/prov-1/test", "POST"),
      );
      expect(res.status).toBe(403);
    });
  });
});
