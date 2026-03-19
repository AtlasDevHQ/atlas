import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ───────────────────────────────────────────────────────────

let mockEnterpriseEnabled = false;
let mockEnterpriseLicenseKey: string | undefined = "test-key";

mock.module("../index", () => ({
  isEnterpriseEnabled: () => mockEnterpriseEnabled,
  getEnterpriseLicenseKey: () => mockEnterpriseLicenseKey,
  requireEnterprise: (feature?: string) => {
    const label = feature ? ` (${feature})` : "";
    if (!mockEnterpriseEnabled) {
      throw new Error(`Enterprise features${label} are not enabled.`);
    }
    if (!mockEnterpriseLicenseKey) {
      throw new Error(`Enterprise features${label} are enabled but no license key is configured.`);
    }
  },
}));

// Mock internal DB
const mockRows: Record<string, unknown>[][] = [];
let queryCallCount = 0;
const capturedQueries: { sql: string; params: unknown[] }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({
    query: async (sql: string, params?: unknown[]) => {
      capturedQueries.push({ sql, params: params ?? [] });
      const rows = mockRows[queryCallCount] ?? [];
      queryCallCount++;
      return { rows };
    },
    end: async () => {},
    on: () => {},
  }),
  internalQuery: async (sql: string, params?: unknown[]) => {
    capturedQueries.push({ sql, params: params ?? [] });
    const rows = mockRows[queryCallCount] ?? [];
    queryCallCount++;
    return rows;
  },
  internalExecute: () => {},
  encryptUrl: (v: string) => `encrypted:${v}`,
  decryptUrl: (v: string) => v.startsWith("encrypted:") ? v.slice(10) : v,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import after mocks
const {
  listSSOProviders,
  getSSOProvider,
  createSSOProvider,
  deleteSSOProvider,
  findProviderByDomain,
  extractEmailDomain,
  isValidDomain,
  isValidSSOProviderType,
  validateProviderConfig,
} = await import("./sso");

// ── Helpers ─────────────────────────────────────────────────────────

function resetMocks() {
  mockRows.length = 0;
  queryCallCount = 0;
  capturedQueries.length = 0;
  mockEnterpriseEnabled = true;
  mockEnterpriseLicenseKey = "test-key";
}

const sampleSamlRow = {
  id: "prov-1",
  org_id: "org-1",
  type: "saml",
  issuer: "https://idp.acme.com",
  domain: "acme.com",
  enabled: true,
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
  beforeEach(resetMocks);

  it("listSSOProviders throws when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    await expect(listSSOProviders("org-1")).rejects.toThrow("Enterprise features");
  });

  it("getSSOProvider throws when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    await expect(getSSOProvider("org-1", "prov-1")).rejects.toThrow("Enterprise features");
  });

  it("createSSOProvider throws when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
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
    mockEnterpriseEnabled = false;
    await expect(deleteSSOProvider("org-1", "prov-1")).rejects.toThrow("Enterprise features");
  });

  it("throws when no license key", async () => {
    mockEnterpriseLicenseKey = undefined;
    await expect(listSSOProviders("org-1")).rejects.toThrow("no license key");
  });
});

describe("listSSOProviders", () => {
  beforeEach(resetMocks);

  it("returns providers for the org", async () => {
    mockRows.push([sampleSamlRow, sampleOidcRow]);
    const providers = await listSSOProviders("org-1");
    expect(providers).toHaveLength(2);
    expect(providers[0].type).toBe("saml");
    expect(providers[0].orgId).toBe("org-1");
    expect(providers[1].type).toBe("oidc");
  });

  it("returns empty array when no providers", async () => {
    mockRows.push([]);
    const providers = await listSSOProviders("org-1");
    expect(providers).toHaveLength(0);
  });
});

describe("getSSOProvider", () => {
  beforeEach(resetMocks);

  it("returns a single provider", async () => {
    mockRows.push([sampleSamlRow]);
    const provider = await getSSOProvider("org-1", "prov-1");
    expect(provider).not.toBeNull();
    expect(provider!.id).toBe("prov-1");
    expect(provider!.domain).toBe("acme.com");
  });

  it("returns null when not found", async () => {
    mockRows.push([]);
    const provider = await getSSOProvider("org-1", "nonexistent");
    expect(provider).toBeNull();
  });
});

describe("createSSOProvider", () => {
  beforeEach(resetMocks);

  it("creates a SAML provider", async () => {
    // Domain uniqueness check
    mockRows.push([]);
    // INSERT RETURNING
    mockRows.push([sampleSamlRow]);

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
    mockRows.push([{ id: "existing-prov", org_id: "other-org" }]);

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
  beforeEach(resetMocks);

  it("returns true when provider exists", async () => {
    mockRows.push([{ id: "prov-1" }]);
    const result = await deleteSSOProvider("org-1", "prov-1");
    expect(result).toBe(true);
  });

  it("returns false when provider not found", async () => {
    mockRows.push([]);
    const result = await deleteSSOProvider("org-1", "nonexistent");
    expect(result).toBe(false);
  });
});

describe("findProviderByDomain", () => {
  beforeEach(resetMocks);

  it("finds enabled provider for domain", async () => {
    mockRows.push([sampleSamlRow]);
    const provider = await findProviderByDomain("acme.com");
    expect(provider).not.toBeNull();
    expect(provider!.domain).toBe("acme.com");
  });

  it("returns null when no matching domain", async () => {
    mockRows.push([]);
    const provider = await findProviderByDomain("unknown.com");
    expect(provider).toBeNull();
  });

  it("normalizes domain case", async () => {
    mockRows.push([sampleSamlRow]);
    await findProviderByDomain("ACME.COM");
    expect(capturedQueries[0].params[0]).toBe("acme.com");
  });
});
