import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mutable state for mocks ─────────────────────────────────────────
let enterpriseEnabled = true;
let _hasInternalDB = true;

// ── Register ALL mocks before any dynamic imports ───────────────────
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
}));

mock.module("../index", () => ({
  isEnterpriseEnabled: () => enterpriseEnabled,
  getEnterpriseLicenseKey: () => "test-key",
  EnterpriseError: class EnterpriseError extends Error {
    readonly code = "enterprise_required" as const;
    constructor(message = "Enterprise features are not enabled") {
      super(message);
      this.name = "EnterpriseError";
    }
  },
  requireEnterprise: () => {
    if (!enterpriseEnabled) throw new Error("Enterprise features are not enabled");
  },
  resolveDeployMode: () => { throw new Error("Use the direct import"); },
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => _hasInternalDB,
  getInternalDB: () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: async () => [],
  internalExecute: () => {},
  encryptUrl: (v: string) => `encrypted:${v}`,
  decryptUrl: (v: string) => (v.startsWith("encrypted:") ? v.slice(10) : v),
  getEncryptionKey: () => Buffer.from("test-key-32-bytes-long-enough!!!"),
  closeInternalDB: async () => {},
  migrateInternalDB: async () => {},
  _resetPool: () => {},
  loadSavedConnections: async () => 0,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ── Import module under test AFTER all mocks are registered ─────────
const { resolveDeployMode } = await import("../deploy-mode");

describe("resolveDeployMode", () => {
  beforeEach(() => {
    enterpriseEnabled = true;
    _hasInternalDB = true;
    delete process.env.ATLAS_DEPLOY_MODE;
  });

  // -- auto mode ------------------------------------------------------------

  it('auto + enterprise enabled + hasInternalDB → "saas"', () => {
    enterpriseEnabled = true;
    _hasInternalDB = true;
    expect(resolveDeployMode("auto")).toBe("saas");
  });

  it('auto + enterprise disabled → "self-hosted"', () => {
    enterpriseEnabled = false;
    _hasInternalDB = true;
    expect(resolveDeployMode("auto")).toBe("self-hosted");
  });

  it('auto + no internal DB → "self-hosted"', () => {
    enterpriseEnabled = true;
    _hasInternalDB = false;
    expect(resolveDeployMode("auto")).toBe("self-hosted");
  });

  it('auto + enterprise disabled + no internal DB → "self-hosted"', () => {
    enterpriseEnabled = false;
    _hasInternalDB = false;
    expect(resolveDeployMode("auto")).toBe("self-hosted");
  });

  // -- explicit saas --------------------------------------------------------

  it('explicit saas + enterprise enabled → "saas"', () => {
    enterpriseEnabled = true;
    expect(resolveDeployMode("saas")).toBe("saas");
  });

  it('explicit saas + enterprise disabled → "self-hosted" (no-op without license)', () => {
    enterpriseEnabled = false;
    expect(resolveDeployMode("saas")).toBe("self-hosted");
  });

  // -- explicit self-hosted -------------------------------------------------

  it('explicit self-hosted → "self-hosted" always (enterprise enabled)', () => {
    enterpriseEnabled = true;
    _hasInternalDB = true;
    expect(resolveDeployMode("self-hosted")).toBe("self-hosted");
  });

  it('explicit self-hosted → "self-hosted" always (enterprise disabled)', () => {
    enterpriseEnabled = false;
    expect(resolveDeployMode("self-hosted")).toBe("self-hosted");
  });

  // -- env var fallback -----------------------------------------------------

  it("reads ATLAS_DEPLOY_MODE env var when no argument provided", () => {
    enterpriseEnabled = true;
    _hasInternalDB = true;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    expect(resolveDeployMode()).toBe("saas");
  });

  it('defaults to "auto" when no argument and no env var', () => {
    enterpriseEnabled = true;
    _hasInternalDB = true;
    // No env var, no argument → auto → saas (because enterprise + internalDB)
    expect(resolveDeployMode()).toBe("saas");
  });

  it('defaults to "self-hosted" with auto when enterprise disabled and no env var', () => {
    enterpriseEnabled = false;
    expect(resolveDeployMode()).toBe("self-hosted");
  });
});
