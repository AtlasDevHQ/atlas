import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createEEMock, EnterpriseError } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
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
  SSOEnforcementError,
} = await import("./sso");

// ── Helpers ─────────────────────────────────────────────────────────

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
    await expect(listSSOProviders("org-1")).rejects.toThrow("Enterprise features");
  });

  it("enterprise gate throws EnterpriseError instance", async () => {
    ee.setEnterpriseEnabled(false);
    try {
      await listSSOProviders("org-1");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnterpriseError);
    }
  });

  it("getSSOProvider throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(getSSOProvider("org-1", "prov-1")).rejects.toThrow("Enterprise features");
  });

  it("createSSOProvider throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "acme.com",
      config: {
        idpEntityId: "https://idp.acme.com",
        idpSsoUrl: "https://idp.acme.com/sso",
        idpCertificate: "cert",
      },
    })).rejects.toThrow("Enterprise features");
  });

  it("deleteSSOProvider throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(deleteSSOProvider("org-1", "prov-1")).rejects.toThrow("Enterprise features");
  });

  it("throws when no license key", async () => {
    ee.setEnterpriseLicenseKey(undefined);
    await expect(listSSOProviders("org-1")).rejects.toThrow("no license key");
  });
});

describe("listSSOProviders", () => {
  beforeEach(() => ee.reset());

  it("returns providers for the org", async () => {
    ee.queueMockRows([sampleSamlRow, sampleOidcRow]);
    const providers = await listSSOProviders("org-1");
    expect(providers).toHaveLength(2);
    expect(providers[0].type).toBe("saml");
    expect(providers[0].orgId).toBe("org-1");
    expect(providers[1].type).toBe("oidc");
  });

  it("returns empty array when no providers", async () => {
    ee.queueMockRows([]);
    const providers = await listSSOProviders("org-1");
    expect(providers).toHaveLength(0);
  });
});

describe("getSSOProvider", () => {
  beforeEach(() => ee.reset());

  it("returns a single provider", async () => {
    ee.queueMockRows([sampleSamlRow]);
    const provider = await getSSOProvider("org-1", "prov-1");
    expect(provider).not.toBeNull();
    expect(provider!.id).toBe("prov-1");
    expect(provider!.domain).toBe("acme.com");
  });

  it("returns null when not found", async () => {
    ee.queueMockRows([]);
    const provider = await getSSOProvider("org-1", "nonexistent");
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

    const provider = await createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "acme.com",
      config: {
        idpEntityId: "https://idp.acme.com",
        idpSsoUrl: "https://idp.acme.com/sso",
        idpCertificate: "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
      },
    });

    expect(provider.type).toBe("saml");
    expect(provider.domain).toBe("acme.com");
  });

  it("rejects invalid domain", async () => {
    await expect(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "not-a-domain",
      config: {
        idpEntityId: "https://idp.acme.com",
        idpSsoUrl: "https://idp.acme.com/sso",
        idpCertificate: "cert",
      },
    })).rejects.toThrow("Invalid domain");
  });

  it("rejects duplicate domain", async () => {
    ee.queueMockRows([{ id: "existing-prov", org_id: "other-org" }]);

    await expect(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "acme.com",
      config: {
        idpEntityId: "https://idp.acme.com",
        idpSsoUrl: "https://idp.acme.com/sso",
        idpCertificate: "cert",
      },
    })).rejects.toThrow("already registered");
  });

  it("rejects invalid SAML config", async () => {
    await expect(createSSOProvider("org-1", {
      type: "saml",
      issuer: "https://idp.acme.com",
      domain: "acme.com",
      config: { idpEntityId: "" } as never,
    })).rejects.toThrow("SAML config requires");
  });

  it("rejects invalid provider type", async () => {
    await expect(createSSOProvider("org-1", {
      type: "ldap" as never,
      issuer: "https://ldap.acme.com",
      domain: "acme.com",
      config: {} as never,
    })).rejects.toThrow("Invalid SSO provider type");
  });
});

describe("deleteSSOProvider", () => {
  beforeEach(() => ee.reset());

  it("returns true when provider exists", async () => {
    ee.queueMockRows([{ id: "prov-1" }]);
    const result = await deleteSSOProvider("org-1", "prov-1");
    expect(result).toBe(true);
  });

  it("returns false when provider not found", async () => {
    ee.queueMockRows([]);
    const result = await deleteSSOProvider("org-1", "nonexistent");
    expect(result).toBe(false);
  });
});

describe("findProviderByDomain", () => {
  beforeEach(() => ee.reset());

  it("finds enabled provider for domain", async () => {
    ee.queueMockRows([sampleSamlRow]);
    const provider = await findProviderByDomain("acme.com");
    expect(provider).not.toBeNull();
    expect(provider!.domain).toBe("acme.com");
  });

  it("returns null when no matching domain", async () => {
    ee.queueMockRows([]);
    const provider = await findProviderByDomain("unknown.com");
    expect(provider).toBeNull();
  });

  it("normalizes domain case", async () => {
    ee.queueMockRows([sampleSamlRow]);
    await findProviderByDomain("ACME.COM");
    expect(ee.capturedQueries[0].params[0]).toBe("acme.com");
  });

  it("does NOT call requireEnterprise — usable in login flow without license", async () => {
    ee.setEnterpriseEnabled(false);
    ee.setEnterpriseLicenseKey(undefined);
    ee.queueMockRows([]);
    // Should not throw even though enterprise is disabled
    const provider = await findProviderByDomain("acme.com");
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

    const provider = await updateSSOProvider("org-1", "prov-1", {
      issuer: "https://new-idp.acme.com",
    });
    expect(provider.issuer).toBe("https://new-idp.acme.com");
  });

  it("updates domain with uniqueness check", async () => {
    // getSSOProvider query
    ee.queueMockRows([sampleSamlRow]);
    // Domain clash check
    ee.queueMockRows([]);
    // UPDATE RETURNING
    ee.queueMockRows([{ ...sampleSamlRow, domain: "newdomain.com" }]);

    const provider = await updateSSOProvider("org-1", "prov-1", {
      domain: "newdomain.com",
    });
    expect(provider.domain).toBe("newdomain.com");
  });

  it("rejects domain collision on update", async () => {
    // getSSOProvider query
    ee.queueMockRows([sampleSamlRow]);
    // Domain clash check — found a collision
    ee.queueMockRows([{ id: "other-prov" }]);

    await expect(updateSSOProvider("org-1", "prov-1", {
      domain: "taken.com",
    })).rejects.toThrow("already registered");
  });

  it("updates enabled flag", async () => {
    // getSSOProvider query
    ee.queueMockRows([sampleSamlRow]);
    // UPDATE RETURNING
    ee.queueMockRows([{ ...sampleSamlRow, enabled: false }]);

    const provider = await updateSSOProvider("org-1", "prov-1", {
      enabled: false,
    });
    expect(provider.enabled).toBe(false);
  });

  it("returns existing provider when no fields to update", async () => {
    // getSSOProvider query
    ee.queueMockRows([sampleSamlRow]);

    const provider = await updateSSOProvider("org-1", "prov-1", {});
    expect(provider.id).toBe("prov-1");
  });

  it("throws when provider not found", async () => {
    // getSSOProvider returns nothing
    ee.queueMockRows([]);

    await expect(updateSSOProvider("org-1", "nonexistent", {
      issuer: "https://new.com",
    })).rejects.toThrow("not found");
  });

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(updateSSOProvider("org-1", "prov-1", {
      issuer: "https://new.com",
    })).rejects.toThrow("Enterprise features");
  });
});

describe("OIDC encryption round-trip", () => {
  beforeEach(() => ee.reset());

  it("encrypts clientSecret on create", async () => {
    // Domain uniqueness check
    ee.queueMockRows([]);
    // INSERT RETURNING
    ee.queueMockRows([sampleOidcRow]);

    await createSSOProvider("org-1", {
      type: "oidc",
      issuer: "https://accounts.google.com",
      domain: "example.com",
      config: {
        clientId: "client-123",
        clientSecret: "secret-456",
        discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      },
    });

    // The INSERT query params should contain the encrypted secret
    const insertQuery = ee.capturedQueries.find(q => q.sql.includes("INSERT INTO sso_providers"));
    expect(insertQuery).toBeDefined();
    const configParam = insertQuery!.params[5] as string;
    expect(configParam).toContain("encrypted:secret-456");
  });

  it("decrypts clientSecret on read", async () => {
    ee.queueMockRows([sampleOidcRow]);
    const providers = await listSSOProviders("org-1");
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

    const result = await setSSOEnforcement("org-1", true);
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

    await expect(setSSOEnforcement("org-1", true)).rejects.toThrow(
      "No SSO providers were updated",
    );
  });

  it("disables enforcement without checking providers", async () => {
    // UPDATE query (no provider check needed for disabling)
    ee.queueMockRows([]);

    const result = await setSSOEnforcement("org-1", false);
    expect(result.enforced).toBe(false);
    expect(result.orgId).toBe("org-1");
  });

  it("rejects enforcement without active provider", async () => {
    // Check for active providers — none found
    ee.queueMockRows([]);

    await expect(setSSOEnforcement("org-1", true)).rejects.toThrow(
      "Cannot enforce SSO without at least one active SSO provider",
    );
  });

  it("throws SSOEnforcementError when no providers", async () => {
    ee.queueMockRows([]);
    try {
      await setSSOEnforcement("org-1", true);
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SSOEnforcementError);
      expect((err as InstanceType<typeof SSOEnforcementError>).code).toBe("no_provider");
    }
  });

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(setSSOEnforcement("org-1", true)).rejects.toThrow("Enterprise features");
  });

  it("throws when no license key", async () => {
    ee.setEnterpriseLicenseKey(undefined);
    await expect(setSSOEnforcement("org-1", true)).rejects.toThrow("no license key");
  });
});

describe("isSSOEnforced", () => {
  beforeEach(() => ee.reset());

  it("returns enforced: true when enforcement is active", async () => {
    const enforcedRow = { ...sampleSamlRow, sso_enforced: true };
    ee.queueMockRows([enforcedRow]);

    const result = await isSSOEnforced("org-1");
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(true);
    expect(result!.provider).toBeDefined();
    expect(result!.ssoRedirectUrl).toBe("https://idp.acme.com/sso");
  });

  it("returns enforced: false when no enforced providers", async () => {
    ee.queueMockRows([]);

    const result = await isSSOEnforced("org-1");
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(false);
  });

  it("does NOT call requireEnterprise — usable in login flow", async () => {
    ee.setEnterpriseEnabled(false);
    ee.setEnterpriseLicenseKey(undefined);
    ee.queueMockRows([]);

    const result = await isSSOEnforced("org-1");
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(false);
  });
});

describe("isSSOEnforcedForDomain", () => {
  beforeEach(() => ee.reset());

  it("returns enforced: true when domain has enforcement", async () => {
    const enforcedRow = { ...sampleSamlRow, sso_enforced: true };
    ee.queueMockRows([enforcedRow]);

    const result = await isSSOEnforcedForDomain("acme.com");
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(true);
    expect(result!.ssoRedirectUrl).toBe("https://idp.acme.com/sso");
  });

  it("returns OIDC discovery URL for OIDC providers", async () => {
    const enforcedOidcRow = { ...sampleOidcRow, enabled: true, sso_enforced: true };
    ee.queueMockRows([enforcedOidcRow]);

    const result = await isSSOEnforcedForDomain("example.com");
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(true);
    expect(result!.ssoRedirectUrl).toBe("https://accounts.google.com/.well-known/openid-configuration");
  });

  it("returns enforced: false when domain has no enforcement", async () => {
    ee.queueMockRows([]);

    const result = await isSSOEnforcedForDomain("noenforcement.com");
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(false);
  });

  it("normalizes domain case", async () => {
    ee.queueMockRows([]);
    await isSSOEnforcedForDomain("ACME.COM");
    expect(ee.capturedQueries[0].params[0]).toBe("acme.com");
  });

  it("does NOT call requireEnterprise — usable in login flow", async () => {
    ee.setEnterpriseEnabled(false);
    ee.setEnterpriseLicenseKey(undefined);
    ee.queueMockRows([]);

    const result = await isSSOEnforcedForDomain("acme.com");
    expect(result).not.toBeNull();
    expect(result!.enforced).toBe(false);
  });
});
