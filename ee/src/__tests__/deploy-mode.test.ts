/**
 * Deploy-mode resolution test.
 *
 * Post-#2572 (slice 10/11 of #2017) the `resolveDeployMode` function lives
 * in core (`@atlas/api/lib/effect/deploy-mode`) and reads:
 *
 *   - `getConfig().enterprise?.enabled` (or `ATLAS_ENTERPRISE_ENABLED` env)
 *   - `hasInternalDB()` from the internal-DB module
 *
 * The EE re-export from `../deploy-mode` is exercised so a future
 * regression that strips the re-export surfaces here.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mutable state for mocks ─────────────────────────────────────────
let enterpriseEnabledConfig: boolean | undefined = true;
let _hasInternalDB = true;

// ── Register ALL mocks before any dynamic imports ───────────────────
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () =>
    enterpriseEnabledConfig === undefined
      ? null
      : { enterprise: { enabled: enterpriseEnabledConfig } },
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
  encryptSecret: (v: string) => `encrypted:${v}`,
  decryptSecret: (v: string) =>
    v.startsWith("encrypted:") ? v.slice(10) : v,
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

// ── Import the EE re-export AFTER all mocks are registered ──────────
const { resolveDeployMode } = await import("../deploy-mode");

describe("resolveDeployMode (EE re-export)", () => {
  beforeEach(() => {
    enterpriseEnabledConfig = true;
    _hasInternalDB = true;
    delete process.env.ATLAS_DEPLOY_MODE;
    delete process.env.ATLAS_ENTERPRISE_ENABLED;
  });

  // -- auto mode ------------------------------------------------------------

  it('auto + enterprise enabled + hasInternalDB → "saas"', () => {
    enterpriseEnabledConfig = true;
    _hasInternalDB = true;
    expect(resolveDeployMode("auto")).toBe("saas");
  });

  it('auto + enterprise disabled → "self-hosted"', () => {
    enterpriseEnabledConfig = false;
    _hasInternalDB = true;
    expect(resolveDeployMode("auto")).toBe("self-hosted");
  });

  it('auto + no internal DB → "self-hosted"', () => {
    enterpriseEnabledConfig = true;
    _hasInternalDB = false;
    expect(resolveDeployMode("auto")).toBe("self-hosted");
  });

  it('auto + enterprise disabled + no internal DB → "self-hosted"', () => {
    enterpriseEnabledConfig = false;
    _hasInternalDB = false;
    expect(resolveDeployMode("auto")).toBe("self-hosted");
  });

  // -- explicit saas --------------------------------------------------------

  it('explicit saas + enterprise enabled → "saas"', () => {
    enterpriseEnabledConfig = true;
    expect(resolveDeployMode("saas")).toBe("saas");
  });

  it('explicit saas + enterprise disabled → "self-hosted" (no-op without license)', () => {
    enterpriseEnabledConfig = false;
    expect(resolveDeployMode("saas")).toBe("self-hosted");
  });

  // -- explicit self-hosted -------------------------------------------------

  it('explicit self-hosted → "self-hosted" always (enterprise enabled)', () => {
    enterpriseEnabledConfig = true;
    _hasInternalDB = true;
    expect(resolveDeployMode("self-hosted")).toBe("self-hosted");
  });

  it('explicit self-hosted → "self-hosted" always (enterprise disabled)', () => {
    enterpriseEnabledConfig = false;
    expect(resolveDeployMode("self-hosted")).toBe("self-hosted");
  });

  // -- env var fallback -----------------------------------------------------

  it("reads ATLAS_DEPLOY_MODE env var when no argument provided", () => {
    enterpriseEnabledConfig = true;
    _hasInternalDB = true;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    expect(resolveDeployMode()).toBe("saas");
  });

  it('defaults to "auto" when no argument and no env var', () => {
    enterpriseEnabledConfig = true;
    _hasInternalDB = true;
    // No env var, no argument → auto → saas (because enterprise + internalDB)
    expect(resolveDeployMode()).toBe("saas");
  });

  it('defaults to "self-hosted" with auto when enterprise disabled and no env var', () => {
    enterpriseEnabledConfig = false;
    expect(resolveDeployMode()).toBe("self-hosted");
  });

  // -- env-var path for enterprise (config absent) --------------------------

  it("respects ATLAS_ENTERPRISE_ENABLED env var when config has no enterprise key", () => {
    enterpriseEnabledConfig = undefined; // getConfig() → null
    _hasInternalDB = true;
    process.env.ATLAS_ENTERPRISE_ENABLED = "true";
    expect(resolveDeployMode("auto")).toBe("saas");
  });

  it("treats missing ATLAS_ENTERPRISE_ENABLED as disabled (auto → self-hosted)", () => {
    enterpriseEnabledConfig = undefined;
    _hasInternalDB = true;
    expect(resolveDeployMode("auto")).toBe("self-hosted");
  });
});
