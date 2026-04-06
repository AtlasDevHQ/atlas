import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock, EnterpriseError } from "../__mocks__/internal";

// Mock DNS for verifyDomain tests
const mockResolveTxt: Mock<(domain: string) => Promise<string[][]>> = mock(async () => []);
mock.module("node:dns", () => ({
  default: { promises: { resolveTxt: mockResolveTxt } },
  promises: { resolveTxt: mockResolveTxt },
}));

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);

const hasDB = () => (ee.internalDBMock.hasInternalDB as () => boolean)();
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!hasDB()) {
      if (factory) throw factory();
      throw new Error(`Internal database required for ${label}.`);
    }
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) => {
    return hasDB()
      ? Effect.void
      : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`));
  },
}));

mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Import after mocks
const {
  listSSOProviders,
  getSSOProvider,
  createSSOProvider,
  updateSSOProvider,
  deleteSSOProvider,
  findProviderByDomain,
  extractEmailDomain,
  isValidDomain,
  isValidSSOProviderType,
  validateProviderConfig,
  setSSOEnforcement,
  isSSOEnforced,
  isSSOEnforcedForDomain,
  testSSOProvider,
  testOidcProvider,
  testSamlProvider,
  SSOEnforcementError,
  generateVerificationToken,
  verifyDomain,
  checkDomainAvailability,
} = await import("./sso");

// ── Helpers ─────────────────────────────────────────────────────────

/** Run an Effect, converting failures to rejected promises for test assertions. */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

const sampleSamlRow = {
  id: "prov-1",
  org_id: "org-1",
  type: "saml",
  issuer: "https://idp.acme.com",
  domain: "acme.com",
  enabled: true,
  sso_enforced: false,
  config: JSON.stringify({
    idpEntityId: "https://idp.acme.com",
    idpSsoUrl: "https://idp.acme.com/sso",
    idpCertificate: "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
  }),
  created_at: "2026-03-19T00:00:00Z",
  updated_at: "2026-03-19T00:00:00Z",
  verification_token: "atlas-verify=test-uuid",
  domain_verified: true,
  domain_verified_at: "2026-03-19T00:00:00Z",
  domain_verification_status: "verified",
};

const sampleOidcRow = {
  id: "prov-2",
  org_id: "org-1",
  type: "oidc",
  issuer: "https://accounts.google.com",
  domain: "example.com",
  enabled: false,
  sso_enforced: false,
  config: JSON.stringify({
    clientId: "client-123",
    clientSecret: "encrypted:secret-456",
    discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
  }),
  created_at: "2026-03-19T00:00:00Z",
  updated_at: "2026-03-19T00:00:00Z",
  verification_token: "atlas-verify=test-uuid-2",
  domain_verified: false,
  domain_verified_at: null,
  domain_verification_status: "pending",
};

// ── Tests ───────────────────────────────────────────────────────────

describe("SSO validation helpers", () => {
  it("validates domain names", () => {
    expect(isValidDomain("acme.com")).toBe(true);
    expect(isValidDomain("sub.acme.co.uk")).toBe(true);
    expect(isValidDomain("my-company.io")).toBe(true);
    expect(isValidDomain("")).toBe(false);
    expect(isValidDomain("acme")).toBe(false);
    expect(isValidDomain("-invalid.com")).toBe(false);
    expect(isValidDomain("invalid-.com")).toBe(false);
    expect(isValidDomain("acme..com")).toBe(false);
  });

  it("validates SSO provider types", () => {
    expect(isValidSSOProviderType("saml")).toBe(true);
    expect(isValidSSOProviderType("oidc")).toBe(true);
    expect(isValidSSOProviderType("ldap")).toBe(false);
    expect(isValidSSOProviderType("")).toBe(false);
  });

  it("validates SAML config", () => {
    expect(validateProviderConfig("saml", {
      idpEntityId: "https://idp.acme.com",
      idpSsoUrl: "https://idp.acme.com/sso",
      idpCertificate: "cert-data",
    })).toBeNull();

    expect(validateProviderConfig("saml", { idpEntityId: "" })).toContain("SAML config requires");
    expect(validateProviderConfig("saml", null)).toContain("SAML config requires");
  });

  it("validates OIDC config", () => {
    expect(validateProviderConfig("oidc", {
      clientId: "id",
      clientSecret: "secret",
      discoveryUrl: "https://example.com/.well-known/openid-configuration",
    })).toBeNull();

    expect(validateProviderConfig("oidc", { clientId: "" })).toContain("OIDC config requires");
    expect(validateProviderConfig("oidc", null)).toContain("OIDC config requires");
  });
});

describe("extractEmailDomain", () => {
  it("extracts domain from email", () => {
    expect(extractEmailDomain("user@acme.com")).toBe("acme.com");
    expect(extractEmailDomain("USER@ACME.COM")).toBe("acme.com");
    expect(extractEmailDomain("user@sub.acme.co.uk")).toBe("sub.acme.co.uk");
  });

  it("returns null for invalid emails", () => {
    expect(extractEmailDomain("nope")).toBeNull();
    expect(extractEmailDomain("@domain.com")).toBeNull();
    expect(extractEmailDomain("user@")).toBeNull();
  });
});

describe("Enterprise gating", () => {
  beforeEach(() => ee.reset());

  it("listSSOProviders throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(listSSOProviders("org-1"))).rejects.toThrow("Enterprise features");
  });

  it("enterprise gate throws EnterpriseError instance", async () => {
    ee.setEnterpriseEnabled(false);
    const err = await Effect.runPromise(
      listSSOProviders("org-1").pipe(Effect.flip),
    );
    expect(err).toBeInstanceOf(EnterpriseError);
  });

  it("getSSOProvider throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(getSSOProvider("org-1", "prov-1"))).rejects.toThrow("Enterprise features");
  });

  it("createSSOProvider throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "acme.com",
      config: {
        idpEntityId: "https://idp.acme.com",
        idpSsoUrl: "https://idp.acme.com/sso",
        idpCertificate: "cert",
      },
    }))).rejects.toThrow("Enterprise features");
  });

  it("deleteSSOProvider throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(deleteSSOProvider("org-1", "prov-1"))).rejects.toThrow("Enterprise features");
  });

  it("does not throw for missing license key when enterprise is enabled", async () => {
    ee.setEnterpriseLicenseKey(undefined);
    ee.queueMockRows([]);
    const providers = await run(listSSOProviders("org-1"));
    expect(providers).toHaveLength(0);
  });
});

describe("listSSOProviders", () => {
  beforeEach(() => ee.reset());

  it("returns providers for the org", async () => {
    ee.queueMockRows([sampleSamlRow, sampleOidcRow]);
    const providers = await run(listSSOProviders("org-1"));
    expect(providers).toHaveLength(2);
    expect(providers[0].type).toBe("saml");
    expect(providers[0].orgId).toBe("org-1");
    expect(providers[1].type).toBe("oidc");
  });

  it("returns empty array when no providers", async () => {
    ee.queueMockRows([]);
    const providers = await run(listSSOProviders("org-1"));
    expect(providers).toHaveLength(0);
  });
});

describe("getSSOProvider", () => {
  beforeEach(() => ee.reset());

  it("returns a single provider", async () => {
    ee.queueMockRows([sampleSamlRow]);
    const provider = await run(getSSOProvider("org-1", "prov-1"));
    expect(provider).not.toBeNull();
    expect(provider!.id).toBe("prov-1");
    expect(provider!.domain).toBe("acme.com");
  });

  it("returns null when not found", async () => {
    ee.queueMockRows([]);
    const provider = await run(getSSOProvider("org-1", "nonexistent"));
    expect(provider).toBeNull();
  });
});

describe("createSSOProvider", () => {
  beforeEach(() => ee.reset());

  it("creates a SAML provider", async () => {
    // Domain uniqueness check
    ee.queueMockRows([]);
    // INSERT RETURNING
    ee.queueMockRows([sampleSamlRow]);

    const provider = await run(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "acme.com",
      config: {
        idpEntityId: "https://idp.acme.com",
        idpSsoUrl: "https://idp.acme.com/sso",
        idpCertificate: "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
      },
    }));

    expect(provider.type).toBe("saml");
    expect(provider.domain).toBe("acme.com");
  });

  it("rejects invalid domain", async () => {
    await expect(run(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "not-a-domain",
      config: {
        idpEntityId: "https://idp.acme.com",
        idpSsoUrl: "https://idp.acme.com/sso",
        idpCertificate: "cert",
      },
    }))).rejects.toThrow("Invalid domain");
  });

  it("rejects duplicate domain", async () => {
    ee.queueMockRows([{ id: "existing-prov", org_id: "other-org" }]);

    await expect(run(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "acme.com",
      config: {
        idpEntityId: "https://idp.acme.com",
        idpSsoUrl: "https://idp.acme.com/sso",
        idpCertificate: "cert",
      },
    }))).rejects.toThrow("already registered");
  });

  it("rejects invalid SAML config", async () => {
    await expect(run(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "acme.com",
      config: { idpEntityId: "" } as never,
    }))).rejects.toThrow("SAML config requires");
  });

  it("rejects invalid provider type", async () => {
    await expect(run(createSSOProvider("org-1", {
      type: "ldap" as never,
      issuer: "https://ldap.acme.com",
      domain: "acme.com",
      config: {} as never,
    }))).rejects.toThrow("Invalid SSO provider type");
  });
});

describe("deleteSSOProvider", () => {
  beforeEach(() => ee.reset());

  it("returns true when provider exists", async () => {
    ee.queueMockRows([{ id: "prov-1" }]);
    const result = await run(deleteSSOProvider("org-1", "prov-1"));
    expect(result).toBe(true);
  });

  it("returns false when provider not found", async () => {
    ee.queueMockRows([]);
    const result = await run(deleteSSOProvider("org-1", "nonexistent"));
    expect(result).toBe(false);
  });
});

describe("findProviderByDomain", () => {
  beforeEach(() => ee.reset());

  it("finds enabled provider for domain", async () => {
    ee.queueMockRows([sampleSamlRow]);
    const provider = await run(findProviderByDomain("acme.com"));
    expect(provider).not.toBeNull();
    expect(provider!.domain).toBe("acme.com");
  });

  it("returns null when no matching domain", async () => {
    ee.queueMockRows([]);
    const provider = await run(findProviderByDomain("unknown.com"));
    expect(provider).toBeNull();
  });

  it("normalizes domain case", async () => {
    ee.queueMockRows([sampleSamlRow]);
    await run(findProviderByDomain("ACME.COM"));
    expect(ee.capturedQueries[0].params[0]).toBe("acme.com");
  });

  it("does NOT call requireEnterprise — usable in login flow without license", async () => {
    ee.setEnterpriseEnabled(false);
    ee.setEnterpriseLicenseKey(undefined);
    ee.queueMockRows([]);
    // Should not throw even though enterprise is disabled
    const provider = await run(findProviderByDomain("acme.com"));
    expect(provider).toBeNull();
  });
});

describe("updateSSOProvider", () => {
  beforeEach(() => ee.reset());

  it("updates issuer only", async () => {
    // getSSOProvider: requireEnterprise + query
    ee.queueMockRows([sampleSamlRow]);
    // UPDATE RETURNING
    ee.queueMockRows([{ ...sampleSamlRow, issuer: "https://new-idp.acme.com" }]);

    const provider = await run(updateSSOProvider("org-1", "prov-1", {
      issuer: "https://new-idp.acme.com",
    }));
    expect(provider.issuer).toBe("https://new-idp.acme.com");
  });

  it("updates domain with uniqueness check", async () => {
    // getSSOProvider query
    ee.queueMockRows([sampleSamlRow]);
    // Domain clash check
    ee.queueMockRows([]);
    // UPDATE RETURNING
    ee.queueMockRows([{ ...sampleSamlRow, domain: "newdomain.com" }]);

    const provider = await run(updateSSOProvider("org-1", "prov-1", {
      domain: "newdomain.com",
    }));
    expect(provider.domain).toBe("newdomain.com");
  });

  it("rejects domain collision on update", async () => {
    // getSSOProvider query
    ee.queueMockRows([sampleSamlRow]);
    // Domain clash check — found a collision
    ee.queueMockRows([{ id: "other-prov" }]);

    await expect(run(updateSSOProvider("org-1", "prov-1", {
      domain: "taken.com",
    }))).rejects.toThrow("already registered");
  });

  it("updates enabled flag", async () => {
    // getSSOProvider query
    ee.queueMockRows([sampleSamlRow]);
    // UPDATE RETURNING
    ee.queueMockRows([{ ...sampleSamlRow, enabled: false }]);

    const provider = await run(updateSSOProvider("org-1", "prov-1", {
      enabled: false,
    }));
    expect(provider.enabled).toBe(false);
  });

  it("returns existing provider when no fields to update", async () => {
    // getSSOProvider query
    ee.queueMockRows([sampleSamlRow]);

    const provider = await run(updateSSOProvider("org-1", "prov-1", {}));
    expect(provider.id).toBe("prov-1");
  });

  it("throws when provider not found", async () => {
    // getSSOProvider returns nothing
    ee.queueMockRows([]);

    await expect(run(updateSSOProvider("org-1", "nonexistent", {
      issuer: "https://new.com",
    }))).rejects.toThrow("not found");
  });

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(updateSSOProvider("org-1", "prov-1", {
      issuer: "https://new.com",
    }))).rejects.toThrow("Enterprise features");
  });
});

describe("OIDC encryption round-trip", () => {
  beforeEach(() => ee.reset());

  it("encrypts clientSecret on create", async () => {
    // Domain uniqueness check
    ee.queueMockRows([]);
    // INSERT RETURNING
    ee.queueMockRows([sampleOidcRow]);

    await run(createSSOProvider("org-1", {
      type: "oidc",
      issuer: "https://accounts.google.com",
      domain: "example.com",
      config: {
        clientId: "client-123",
        clientSecret: "secret-456",
        discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      },
    }));

    // The INSERT query params should contain the encrypted secret
    // Params: [orgId, type, issuer, domain, config_json, verificationToken]
    const insertQuery = ee.capturedQueries.find(q => q.sql.includes("INSERT INTO sso_providers"));
    expect(insertQuery).toBeDefined();
    const configParam = insertQuery!.params[4] as string;
    expect(configParam).toContain("encrypted:secret-456");
  });

  it("decrypts clientSecret on read", async () => {
    ee.queueMockRows([sampleOidcRow]);
    const providers = await run(listSSOProviders("org-1"));
    expect(providers).toHaveLength(1);
    // The mock decryptUrl strips "encrypted:" prefix
    expect((providers[0].config as { clientSecret: string }).clientSecret).toBe("secret-456");
  });
});

// ── SSO Enforcement Tests ────────────────────────────────────────

describe("setSSOEnforcement", () => {
  beforeEach(() => ee.reset());

  it("enables enforcement when active provider exists", async () => {
    // Check for active providers
    ee.queueMockRows([{ id: "prov-1" }]);
    // UPDATE RETURNING query — must return at least one row
    ee.queueMockRows([{ id: "prov-1" }]);

    const result = await run(setSSOEnforcement("org-1", true));
    expect(result.enforced).toBe(true);
    expect(result.orgId).toBe("org-1");

    // Verify the UPDATE query was issued with RETURNING
    const updateQuery = ee.capturedQueries.find(q => q.sql.includes("UPDATE sso_providers SET sso_enforced"));
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.sql).toContain("RETURNING id");
    expect(updateQuery!.params[0]).toBe(true);
    expect(updateQuery!.params[1]).toBe("org-1");
  });

  it("throws when enable UPDATE affects zero rows (providers deleted mid-request)", async () => {
    // Check for active providers — one found
    ee.queueMockRows([{ id: "prov-1" }]);
    // UPDATE RETURNING — zero rows (provider deleted between check and update)
    ee.queueMockRows([]);

    await expect(run(setSSOEnforcement("org-1", true))).rejects.toThrow(
      "No SSO providers were updated",
    );
  });

  it("disables enforcement without checking providers", async () => {
    // UPDATE query (no provider check needed for disabling)
    ee.queueMockRows([]);

    const result = await run(setSSOEnforcement("org-1", false));
    expect(result.enforced).toBe(false);
    expect(result.orgId).toBe("org-1");
  });

  it("rejects enforcement without active provider", async () => {
    // Check for active providers — none found
    ee.queueMockRows([]);

    await expect(run(setSSOEnforcement("org-1", true))).rejects.toThrow(
      "Cannot enforce SSO without at least one active SSO provider",
    );
  });

  it("throws SSOEnforcementError when no providers", async () => {
    ee.queueMockRows([]);
    const err = await Effect.runPromise(
      setSSOEnforcement("org-1", true).pipe(Effect.flip),
    );
    expect(err).toBeInstanceOf(SSOEnforcementError);
    expect((err as InstanceType<typeof SSOEnforcementError>).code).toBe("no_provider");
  });

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(setSSOEnforcement("org-1", true))).rejects.toThrow("Enterprise features");
  });

});

describe("isSSOEnforced", () => {
  beforeEach(() => ee.reset());

  it("returns enforced: true when enforcement is active", async () => {
    const enforcedRow = { ...sampleSamlRow, sso_enforced: true };
    ee.queueMockRows([enforcedRow]);

    const result = await run(isSSOEnforced("org-1"));
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(true);
    expect(result!.provider).toBeDefined();
    expect(result!.ssoRedirectUrl).toBe("https://idp.acme.com/sso");
  });

  it("returns enforced: false when no enforced providers", async () => {
    ee.queueMockRows([]);

    const result = await run(isSSOEnforced("org-1"));
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(false);
  });

  it("does NOT call requireEnterprise — usable in login flow", async () => {
    ee.setEnterpriseEnabled(false);
    ee.setEnterpriseLicenseKey(undefined);
    ee.queueMockRows([]);

    const result = await run(isSSOEnforced("org-1"));
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(false);
  });
});

describe("isSSOEnforcedForDomain", () => {
  beforeEach(() => ee.reset());

  it("returns enforced: true when domain has enforcement", async () => {
    const enforcedRow = { ...sampleSamlRow, sso_enforced: true };
    ee.queueMockRows([enforcedRow]);

    const result = await run(isSSOEnforcedForDomain("acme.com"));
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(true);
    expect(result!.ssoRedirectUrl).toBe("https://idp.acme.com/sso");
  });

  it("returns OIDC discovery URL for OIDC providers", async () => {
    const enforcedOidcRow = { ...sampleOidcRow, enabled: true, sso_enforced: true };
    ee.queueMockRows([enforcedOidcRow]);

    const result = await run(isSSOEnforcedForDomain("example.com"));
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(true);
    expect(result!.ssoRedirectUrl).toBe("https://accounts.google.com/.well-known/openid-configuration");
  });

  it("returns enforced: false when domain has no enforcement", async () => {
    ee.queueMockRows([]);

    const result = await run(isSSOEnforcedForDomain("noenforcement.com"));
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(false);
  });

  it("normalizes domain case", async () => {
    ee.queueMockRows([]);
    await run(isSSOEnforcedForDomain("ACME.COM"));
    expect(ee.capturedQueries[0].params[0]).toBe("acme.com");
  });

  it("does NOT call requireEnterprise — usable in login flow", async () => {
    ee.setEnterpriseEnabled(false);
    ee.setEnterpriseLicenseKey(undefined);
    ee.queueMockRows([]);

    const result = await run(isSSOEnforcedForDomain("acme.com"));
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(false);
  });
});

// -- Domain Verification Tests --

describe("generateVerificationToken", () => {
  it("returns token in atlas-verify=<uuid> format", () => {
    const token = generateVerificationToken();
    expect(token).toMatch(/^atlas-verify=[0-9a-f-]{36}$/);
  });

  it("generates unique tokens on each call", () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a).not.toBe(b);
  });
});

describe("verifyDomain", () => {
  beforeEach(() => {
    ee.reset();
    mockResolveTxt.mockReset();
    mockResolveTxt.mockResolvedValue([]);
  });

  it("returns verified when TXT record matches token", async () => {
    // SELECT provider
    ee.queueMockRows([{ ...sampleSamlRow, domain_verified: false, domain_verification_status: "pending" }]);
    // UPDATE to verified
    ee.queueMockRows([]);
    mockResolveTxt.mockResolvedValue([["atlas-verify=test-uuid"]]);

    const result = await run(verifyDomain("prov-1", "org-1"));
    expect(result.status).toBe("verified");
    expect(result.message).toContain("verified successfully");

    // Verify DB was updated to verified
    const updateQuery = ee.capturedQueries.find(q => q.sql.includes("domain_verified = true"));
    expect(updateQuery).toBeDefined();
  });

  it("handles multi-part TXT records (RFC 7208 long records)", async () => {
    ee.queueMockRows([{ ...sampleSamlRow, domain_verified: false, domain_verification_status: "pending" }]);
    ee.queueMockRows([]);
    // DNS can split long TXT records across multiple strings
    mockResolveTxt.mockResolvedValue([["atlas-verify=", "test-uuid"]]);

    const result = await run(verifyDomain("prov-1", "org-1"));
    expect(result.status).toBe("verified");
  });

  it("returns failed when no matching TXT record found", async () => {
    ee.queueMockRows([{ ...sampleSamlRow, domain_verified: false, domain_verification_status: "pending" }]);
    ee.queueMockRows([]); // UPDATE to failed
    mockResolveTxt.mockResolvedValue([["some-other-record"]]);

    const result = await run(verifyDomain("prov-1", "org-1"));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("No matching TXT record");

    const updateQuery = ee.capturedQueries.find(q => q.sql.includes("domain_verification_status = 'failed'"));
    expect(updateQuery).toBeDefined();
  });

  it("returns failed when DNS lookup times out", async () => {
    ee.queueMockRows([{ ...sampleSamlRow, domain_verified: false, domain_verification_status: "pending" }]);
    ee.queueMockRows([]); // UPDATE to failed
    mockResolveTxt.mockRejectedValue(new Error("queryTxt ETIMEOUT acme.com"));

    const result = await run(verifyDomain("prov-1", "org-1"));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("DNS lookup failed");
  });

  it("returns verified immediately if domain already verified", async () => {
    ee.queueMockRows([{ ...sampleSamlRow, domain_verified: true, domain_verification_status: "verified" }]);

    const result = await run(verifyDomain("prov-1", "org-1"));
    expect(result.status).toBe("verified");
    expect(result.message).toContain("already verified");
    // DNS should NOT have been called
    expect(mockResolveTxt).not.toHaveBeenCalled();
  });

  it("throws not_found when provider does not exist", async () => {
    ee.queueMockRows([]);
    await expect(run(verifyDomain("nonexistent", "org-1"))).rejects.toThrow("not found");
  });

  it("throws validation when no verification token configured", async () => {
    ee.queueMockRows([{ ...sampleSamlRow, verification_token: null, domain_verified: false }]);
    await expect(run(verifyDomain("prov-1", "org-1"))).rejects.toThrow("No verification token");
  });
});

describe("checkDomainAvailability", () => {
  beforeEach(() => ee.reset());

  it("returns available for unclaimed domain", async () => {
    ee.queueMockRows([]);
    const result = await run(checkDomainAvailability("newdomain.com", "org-1"));
    expect(result.available).toBe(true);
  });

  it("returns unavailable when claimed by same org", async () => {
    ee.queueMockRows([{ id: "prov-1", org_id: "org-1" }]);
    const result = await run(checkDomainAvailability("acme.com", "org-1"));
    expect(result.available).toBe(false);
    expect(result.reason).toContain("your organization");
  });

  it("returns unavailable when claimed by another org", async () => {
    ee.queueMockRows([{ id: "prov-2", org_id: "org-other" }]);
    const result = await run(checkDomainAvailability("acme.com", "org-1"));
    expect(result.available).toBe(false);
    expect(result.reason).toContain("another organization");
  });

  it("returns unavailable for invalid domain format", async () => {
    const result = await run(checkDomainAvailability("not-a-domain", "org-1"));
    expect(result.available).toBe(false);
    expect(result.reason).toContain("Invalid domain");
  });

  it("returns unavailable when no internal DB configured", async () => {
    ee.setHasInternalDB(false);
    const result = await run(checkDomainAvailability("acme.com", "org-1"));
    expect(result.available).toBe(false);
    expect(result.reason).toContain("internal database not configured");
  });

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(checkDomainAvailability("acme.com", "org-1"))).rejects.toThrow("Enterprise features");
  });
});

// ── Enable guard in updateSSOProvider ──────────────────────────────

describe("updateSSOProvider — enable guard", () => {
  beforeEach(() => ee.reset());

  it("blocks enabling when domain is not verified", async () => {
    // getSSOProvider: returns provider with domain_verified=false
    ee.queueMockRows([{ ...sampleOidcRow, domain_verified: false, domain_verification_status: "pending" }]);

    await expect(run(updateSSOProvider("org-1", "prov-2", { enabled: true }))).rejects.toThrow(
      "Cannot enable SSO provider until domain is verified",
    );
  });

  it("allows enabling when domain is verified", async () => {
    // getSSOProvider query
    ee.queueMockRows([{ ...sampleSamlRow, domain_verified: true, domain_verification_status: "verified" }]);
    // UPDATE RETURNING
    ee.queueMockRows([{ ...sampleSamlRow, enabled: true }]);

    const provider = await run(updateSSOProvider("org-1", "prov-1", { enabled: true }));
    expect(provider.enabled).toBe(true);
  });

  it("allows disabling regardless of verification status", async () => {
    // getSSOProvider query
    ee.queueMockRows([{ ...sampleSamlRow, enabled: true, domain_verified: true }]);
    // UPDATE RETURNING
    ee.queueMockRows([{ ...sampleSamlRow, enabled: false }]);

    const provider = await run(updateSSOProvider("org-1", "prov-1", { enabled: false }));
    expect(provider.enabled).toBe(false);
  });

  it("resets verification when domain changes", async () => {
    // getSSOProvider query
    ee.queueMockRows([{ ...sampleSamlRow, domain_verified: true, domain_verification_status: "verified" }]);
    // Domain clash check
    ee.queueMockRows([]);
    // UPDATE RETURNING
    ee.queueMockRows([{ ...sampleSamlRow, domain: "newdomain.com", domain_verified: false, domain_verification_status: "pending", enabled: false }]);

    const provider = await run(updateSSOProvider("org-1", "prov-1", { domain: "newdomain.com" }));
    expect(provider.domain).toBe("newdomain.com");
    expect(provider.domainVerified).toBe(false);
    expect(provider.domainVerificationStatus).toBe("pending");

    // Verify SQL includes verification reset
    const updateQuery = ee.capturedQueries.find(q => q.sql.includes("UPDATE sso_providers"));
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.sql).toContain("domain_verified = false");
    expect(updateQuery!.sql).toContain("domain_verification_status = 'pending'");
    expect(updateQuery!.sql).toContain("verification_token");
  });
});

// ── Test Connection Unit Tests ─────────────────────────────────────

import type { SSOOidcProvider, SSOSamlProvider, SSOOidcTestDetails, SSOSamlTestDetails } from "@useatlas/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock needs to bypass fetch.preconnect type
const mockFetch = (fn: (...args: any[]) => Promise<Response>) => {
  globalThis.fetch = mock(fn) as unknown as typeof fetch;
};

const oidcProvider: SSOOidcProvider = {
  id: "prov-oidc",
  orgId: "org-1",
  type: "oidc",
  issuer: "https://idp.example.com",
  domain: "example.com",
  enabled: true,
  ssoEnforced: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  verificationToken: "atlas-verify=test-oidc",
  domainVerified: true,
  domainVerifiedAt: "2026-01-01T00:00:00Z",
  domainVerificationStatus: "verified",
  config: {
    clientId: "client-1",
    clientSecret: "secret-1",
    discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
  },
};

const validDiscoveryDoc = {
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/auth",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
};

describe("testOidcProvider", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("succeeds with valid discovery document", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify(validDiscoveryDoc), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await testOidcProvider(oidcProvider);
    expect(result.type).toBe("oidc");
    expect(result.success).toBe(true);
    expect(result.testedAt).toBeDefined();
    const details = result.details as SSOOidcTestDetails;
    expect(details.discoveryReachable).toBe(true);
    expect(details.issuerMatch).toBe(true);
    expect(details.requiredFieldsPresent).toBe(true);
    expect(details.endpoints.issuer).toBe("https://idp.example.com");
    expect(result.errors).toBeUndefined();
  });

  it("fails for non-200 HTTP response", async () => {
    mockFetch(async () => new Response("", { status: 500 }));

    const result = await testOidcProvider(oidcProvider);
    expect(result.success).toBe(false);
    expect(result.errors![0]).toContain("HTTP 500");
  });

  it("fails for non-JSON body and includes parse reason", async () => {
    mockFetch(async () =>
      new Response("<html>Not Found</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await testOidcProvider(oidcProvider);
    expect(result.success).toBe(false);
    const details = result.details as SSOOidcTestDetails;
    expect(details.discoveryReachable).toBe(false);
    expect(result.errors![0]).toContain("non-JSON body");
    expect(result.errors![0]).toContain("content-type: text/html");
  });

  it("fails when required fields are missing", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ issuer: "https://idp.example.com" }), { status: 200 }),
    );

    const result = await testOidcProvider(oidcProvider);
    expect(result.success).toBe(false);
    const details = result.details as SSOOidcTestDetails;
    expect(details.discoveryReachable).toBe(true);
    expect(details.requiredFieldsPresent).toBe(false);
    expect(result.errors![0]).toContain("authorization_endpoint");
    expect(result.errors![0]).toContain("token_endpoint");
    expect(result.errors![0]).toContain("jwks_uri");
  });

  it("fails when issuer does not match", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ ...validDiscoveryDoc, issuer: "https://other.com" }), { status: 200 }),
    );

    const result = await testOidcProvider(oidcProvider);
    expect(result.success).toBe(false);
    const details = result.details as SSOOidcTestDetails;
    expect(details.issuerMatch).toBe(false);
    expect(result.errors![0]).toContain("Issuer mismatch");
  });

  it("fails on fetch timeout (AbortError)", async () => {
    mockFetch(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    const result = await testOidcProvider(oidcProvider);
    expect(result.success).toBe(false);
    expect(result.errors![0]).toContain("timed out");
  });

  it("fails on network error", async () => {
    mockFetch(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    const result = await testOidcProvider(oidcProvider);
    expect(result.success).toBe(false);
    expect(result.errors![0]).toContain("Failed to reach");
    expect(result.errors![0]).toContain("ENOTFOUND");
  });

  it("rejects non-HTTPS URL", async () => {
    const badProvider: SSOOidcProvider = {
      ...oidcProvider,
      config: { ...oidcProvider.config, discoveryUrl: "file:///etc/passwd" },
    };

    const result = await testOidcProvider(badProvider);
    expect(result.success).toBe(false);
    expect(result.errors![0]).toContain("unsupported protocol");
  });
});

// ── SAML cert fixture ──────────────────────────────────────────────

// Self-signed cert generated for testing (valid 2026-04-06 to 2030-04-05)
const VALID_SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUQCSGvDJthfMZ0SHEJaVbZ6eF2n4wDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTAeFw0yNjA0MDYyMjQ4MzJa
Fw0zMDA0MDUyMjQ4MzJaMBsxGTAXBgNVBAMMEHRlc3QuZXhhbXBsZS5jb20wggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDeePGI8U+2eqhqRJ0NUUqoWQJ3
EXC+JVPfP14xUZBIkfbzqXGF1p4h60MGN9rHrWMI7fW+Dwgu3wEGC3vVpLpHKxNw
EpftRQk6tTJRqPmHuPB0+modGUObN4EPoYQC7Pj7Wv1+DO4bQNDcjTPbjifcNK1p
a96gv9jx4LY9eTwEW826sQujayPeCqTteDJsR4J7H1CWxODzoqOXUpPo/xB08re+
RS71Rav6XScupLKWL3iKyCCnwunCp5RI5f0pba+0V8Z0kEy8rZ3oKVHteabYCNYw
c7vq0IexhFyPL2/YqxRpuywwzNXTzNxI74jVpD50bwDrW/BXg/5FyNTC5Ua9AgMB
AAGjUzBRMB0GA1UdDgQWBBQACdVF4IUgb1bLZlEigwx6UPAkgDAfBgNVHSMEGDAW
gBQACdVF4IUgb1bLZlEigwx6UPAkgDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQACKkWx5gimQXs7flQzALHnE8ej7UerSRN+DUAfmCxlLVZC/LPP
9OC2T7oUfWRyHz0C8XVHzJvuDpHWN8WtbIpk4JDkEQBysvskP3Yl2xrD7SbvprDG
XHIOvK/MEYMivJn41pNyVKGcvTB/A4879fCnJ8gKZMi2kUVCUK9CidcL0l68zdGd
1qe5xpSJ6d6y+6t8pf3cK6uJLkSQ5YzQq2OvTGNJ/m2BmmbxbB6FGLSPGg/6zZU2
gibJD2n7auzsYMABf9T8LASCtwi4Y0Gf1TB4pCUcG7Jutk148FG4emKtJwYxZKkB
ByTeG8DfNTXzmBOR0LDHC+Z4uBHXPiVCbSAs
-----END CERTIFICATE-----`;

const samlProvider: SSOSamlProvider = {
  id: "prov-saml",
  orgId: "org-1",
  type: "saml",
  issuer: "https://idp.example.com",
  domain: "example.com",
  enabled: true,
  ssoEnforced: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  verificationToken: "atlas-verify=test-saml",
  domainVerified: true,
  domainVerifiedAt: "2026-01-01T00:00:00Z",
  domainVerificationStatus: "verified",
  config: {
    idpEntityId: "https://idp.example.com",
    idpSsoUrl: "https://idp.example.com/sso",
    idpCertificate: VALID_SELF_SIGNED_CERT,
  },
};

describe("testSamlProvider", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("succeeds with valid cert and reachable IdP", async () => {
    mockFetch(async () => new Response("", { status: 200 }));

    const result = await testSamlProvider(samlProvider);
    const d = result.details as SSOSamlTestDetails;
    expect(result.type).toBe("saml");
    expect(result.success).toBe(true);
    expect(result.testedAt).toBeDefined();
    expect(d.certValid).toBe(true);
    expect(d.certSubject).toContain("test.example.com");
    expect(d.certExpiry).toBeDefined();
    // certExpiry should be ISO 8601 format, not raw X509 validTo string
    expect(d.certExpiry).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof d.certDaysRemaining).toBe("number");
    expect(d.idpReachable).toBe(true);
  });

  it("fails with malformed PEM", async () => {
    mockFetch(async () => new Response("", { status: 200 }));
    const badProvider: SSOSamlProvider = {
      ...samlProvider,
      config: { ...samlProvider.config, idpCertificate: "NOT A CERT" },
    };

    const result = await testSamlProvider(badProvider);
    const d = result.details as SSOSamlTestDetails;
    expect(result.success).toBe(false);
    expect(d.certValid).toBe(false);
    expect(result.errors![0]).toContain("Malformed PEM");
  });

  it("reports unreachable IdP with timeout", async () => {
    mockFetch(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    const result = await testSamlProvider(samlProvider);
    const d = result.details as SSOSamlTestDetails;
    // Cert is still valid — only IdP is unreachable
    expect(result.success).toBe(true);
    expect(d.idpReachable).toBe(false);
    expect(result.errors![0]).toContain("timed out");
  });

  it("reports IdP server error (5xx)", async () => {
    mockFetch(async () => new Response("", { status: 503 }));

    const result = await testSamlProvider(samlProvider);
    const d = result.details as SSOSamlTestDetails;
    expect(result.success).toBe(true);
    expect(d.idpReachable).toBe(true);
    expect(result.errors![0]).toContain("server error");
    expect(result.errors![0]).toContain("503");
  });

  it("treats 405 (HEAD not supported) as reachable without error", async () => {
    mockFetch(async () => new Response("", { status: 405 }));

    const result = await testSamlProvider(samlProvider);
    const d = result.details as SSOSamlTestDetails;
    expect(result.success).toBe(true);
    expect(d.idpReachable).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("rejects non-HTTPS IdP URL", async () => {
    const badProvider: SSOSamlProvider = {
      ...samlProvider,
      config: { ...samlProvider.config, idpSsoUrl: "ftp://internal.server/sso" },
    };

    const result = await testSamlProvider(badProvider);
    const d = result.details as SSOSamlTestDetails;
    expect(d.idpReachable).toBe(false);
    expect(result.errors!.find(e => e.includes("unsupported protocol"))).toBeDefined();
  });
});

describe("testSSOProvider (Effect wrapper)", () => {
  beforeEach(() => ee.reset());

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(testSSOProvider("org-1", "prov-1"))).rejects.toThrow("Enterprise features");
  });

  it("throws SSOError when provider not found", async () => {
    ee.queueMockRows([]);
    await expect(run(testSSOProvider("org-1", "nonexistent"))).rejects.toThrow("not found");
  });
});
