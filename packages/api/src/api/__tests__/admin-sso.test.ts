/**
 * Tests for admin SSO domain verification endpoints.
 *
 * Covers:
 * - POST /providers/:id/verify — DNS TXT verification
 * - GET /domain-check — domain availability
 * - POST /providers — create generates verification token, forces enabled=false
 * - PATCH /providers/:id — domain change resets verification
 * - PATCH /providers/:id — enable blocked when domain unverified
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

// --- EE SSO mock ---

// Mock functions that tests can control
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock needs flexible return type for success/failure paths
const mockVerifyDomain: Mock<(providerId: string, orgId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed({ status: "verified", message: "Domain verified successfully." }),
);

const mockCheckDomainAvailability: Mock<(domain: string, orgId: string) => Effect.Effect<{ available: boolean; reason?: string }>> = mock(
  () => Effect.succeed({ available: true }),
);

const mockListSSOProviders: Mock<(orgId: string) => Effect.Effect<SSOProvider[]>> = mock(
  () => Effect.succeed([]),
);

const mockGetSSOProvider: Mock<(orgId: string, providerId: string) => Effect.Effect<SSOProvider | null>> = mock(
  () => Effect.succeed(null),
);

const mockCreateSSOProvider: Mock<(orgId: string, input: unknown) => Effect.Effect<SSOProvider>> = mock(
  () => Effect.die(new Error("not configured")),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock needs flexible return type for success/failure paths
const mockUpdateSSOProvider: Mock<(orgId: string, providerId: string, input: unknown) => Effect.Effect<any, any>> = mock(
  () => Effect.die(new Error("not configured")),
);

const mockDeleteSSOProvider: Mock<(orgId: string, providerId: string) => Effect.Effect<boolean>> = mock(
  () => Effect.succeed(false),
);

class MockSSOError extends Error {
  readonly name = "SSOError";
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

class MockSSOEnforcementError extends Error {
  readonly name = "SSOEnforcementError";
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

mock.module("@atlas/ee/auth/sso", () => ({
  listSSOProviders: mockListSSOProviders,
  getSSOProvider: mockGetSSOProvider,
  createSSOProvider: mockCreateSSOProvider,
  updateSSOProvider: mockUpdateSSOProvider,
  deleteSSOProvider: mockDeleteSSOProvider,
  verifyDomain: mockVerifyDomain,
  checkDomainAvailability: mockCheckDomainAvailability,
  redactProvider: (p: SSOProvider) => p,
  summarizeProvider: (p: SSOProvider) => {
    const { config: _config, ...rest } = p;
    return rest;
  },
  setSSOEnforcement: mock(() => Effect.succeed({ enforced: false, orgId: "org-alpha" })),
  isSSOEnforced: mock(() => Effect.succeed({ enforced: false })),
  isSSOEnforcedForDomain: mock(() => Effect.succeed({ enforced: false })),
  findProviderByDomain: mock(() => Effect.succeed(null)),
  extractEmailDomain: (email: string) => {
    const at = email.lastIndexOf("@");
    return at > 0 ? email.slice(at + 1).toLowerCase() : null;
  },
  isValidDomain: (domain: string) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain.toLowerCase()),
  isValidSSOProviderType: (type: string) => ["saml", "oidc"].includes(type),
  validateSamlConfig: () => true,
  validateOidcConfig: () => true,
  validateProviderConfig: () => null,
  generateVerificationToken: () => "atlas-verify=test-uuid-1234",
  SSOError: MockSSOError,
  SSOEnforcementError: MockSSOEnforcementError,
}));

// Mock EE index — enterprise is enabled
mock.module("@atlas/ee", () => ({
  isEnterpriseEnabled: () => true,
  getEnterpriseLicenseKey: () => "test-key",
  requireEnterprise: () => {},
  requireEnterpriseEffect: () => Effect.void,
  EnterpriseError: class extends Error {
    readonly name = "EnterpriseError";
  },
}));

// Mock EE db-guard
mock.module("@atlas/ee/lib/db-guard", () => ({
  requireInternalDBEffect: () => Effect.void,
  requireInternalDB: () => {},
}));

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helpers ---

function adminRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key" },
  };
  if (body) {
    opts.headers = { ...opts.headers, "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
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

afterAll(() => {
  mocks.cleanup();
});

// --- Tests ---

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
    mockListSSOProviders.mockReset();
    mockDeleteSSOProvider.mockReset();
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

      // Verify createSSOProvider was called
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

      // Verify updateSSOProvider was called with the domain change
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
