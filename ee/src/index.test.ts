import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock @atlas/api/lib/config before importing ee
mock.module("@atlas/api/lib/config", () => {
  return {
    getConfig: () => mockConfig,
  };
});

let mockConfig: { enterprise?: { enabled: boolean; licenseKey?: string } } | null = null;

// Import after mock is set up
const { isEnterpriseEnabled, requireEnterprise, getEnterpriseLicenseKey } = await import("./index");

describe("isEnterpriseEnabled", () => {
  beforeEach(() => {
    mockConfig = null;
    delete process.env.ATLAS_ENTERPRISE_ENABLED;
  });

  it("returns false by default", () => {
    expect(isEnterpriseEnabled()).toBe(false);
  });

  it("returns true when config has enterprise.enabled=true", () => {
    mockConfig = { enterprise: { enabled: true } };
    expect(isEnterpriseEnabled()).toBe(true);
  });

  it("returns false when config has enterprise.enabled=false", () => {
    mockConfig = { enterprise: { enabled: false } };
    expect(isEnterpriseEnabled()).toBe(false);
  });

  it("returns true when ATLAS_ENTERPRISE_ENABLED=true", () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "true";
    expect(isEnterpriseEnabled()).toBe(true);
  });

  it("returns false when ATLAS_ENTERPRISE_ENABLED is not 'true'", () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "false";
    expect(isEnterpriseEnabled()).toBe(false);
  });

  it("prefers config over env var", () => {
    mockConfig = { enterprise: { enabled: false } };
    process.env.ATLAS_ENTERPRISE_ENABLED = "true";
    expect(isEnterpriseEnabled()).toBe(false);
  });

  it("falls through to env var when config loaded but no enterprise section", () => {
    mockConfig = {};
    process.env.ATLAS_ENTERPRISE_ENABLED = "true";
    expect(isEnterpriseEnabled()).toBe(true);
  });

  it("uses strict equality — '1' and 'TRUE' are not true", () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "1";
    expect(isEnterpriseEnabled()).toBe(false);
    process.env.ATLAS_ENTERPRISE_ENABLED = "TRUE";
    expect(isEnterpriseEnabled()).toBe(false);
  });
});

describe("getEnterpriseLicenseKey", () => {
  beforeEach(() => {
    mockConfig = null;
    delete process.env.ATLAS_ENTERPRISE_LICENSE_KEY;
  });

  it("returns undefined when no key configured", () => {
    expect(getEnterpriseLicenseKey()).toBeUndefined();
  });

  it("returns key from config", () => {
    mockConfig = { enterprise: { enabled: true, licenseKey: "key-from-config" } };
    expect(getEnterpriseLicenseKey()).toBe("key-from-config");
  });

  it("returns key from env var", () => {
    process.env.ATLAS_ENTERPRISE_LICENSE_KEY = "key-from-env";
    expect(getEnterpriseLicenseKey()).toBe("key-from-env");
  });

  it("prefers config over env var", () => {
    mockConfig = { enterprise: { enabled: true, licenseKey: "key-from-config" } };
    process.env.ATLAS_ENTERPRISE_LICENSE_KEY = "key-from-env";
    expect(getEnterpriseLicenseKey()).toBe("key-from-config");
  });

  it("falls through to env var when config has no licenseKey", () => {
    mockConfig = { enterprise: { enabled: true } };
    process.env.ATLAS_ENTERPRISE_LICENSE_KEY = "key-from-env";
    expect(getEnterpriseLicenseKey()).toBe("key-from-env");
  });
});

describe("requireEnterprise", () => {
  beforeEach(() => {
    mockConfig = null;
    delete process.env.ATLAS_ENTERPRISE_ENABLED;
    delete process.env.ATLAS_ENTERPRISE_LICENSE_KEY;
  });

  it("throws when enterprise is not enabled", () => {
    expect(() => requireEnterprise()).toThrow("are not enabled");
  });

  it("includes feature name in error when provided", () => {
    expect(() => requireEnterprise("SSO")).toThrow("(SSO)");
  });

  it("does not throw when enterprise is enabled via config", () => {
    mockConfig = { enterprise: { enabled: true } };
    expect(() => requireEnterprise()).not.toThrow();
  });

  it("does not throw when enterprise is enabled via env", () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "true";
    expect(() => requireEnterprise()).not.toThrow();
  });
});
