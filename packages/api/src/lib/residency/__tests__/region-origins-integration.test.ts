/**
 * Region-derivation integration (#3706).
 *
 * Walks the whole chain that used to require per-service env stamping —
 * `getWebOrigin()` → the `ATLAS_CORS_ORIGIN` default (`resolveCorsOrigin`) and
 * the passkey rpID (`resolvePasskeyRpId`) — with NO origin env vars set, only
 * `ATLAS_API_REGION` + the residency map. Locks the derived CORS origin and
 * rpID for each SaaS region so a refactor can't silently shift the cookie CORS
 * allowlist or invalidate enrolled passkeys.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

let mockConfig: Record<string, unknown> | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// No explicit CORS override — force resolveCorsOrigin through the region default.
mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: () => undefined,
  getSetting: () => undefined,
}));

const { getWebOrigin } = await import("@atlas/api/lib/web-origin");
const { resolveCorsOrigin } = await import("@atlas/api/lib/cors");
const { resolvePasskeyRpId } = await import("@atlas/api/lib/auth/rpid");

const PROD_RESIDENCY = {
  defaultRegion: "us",
  regions: {
    us: { label: "United States", databaseUrl: "x", apiUrl: "https://api.useatlas.dev" },
    eu: { label: "Europe", databaseUrl: "x", apiUrl: "https://api-eu.useatlas.dev" },
    apac: { label: "Asia Pacific", databaseUrl: "x", apiUrl: "https://api-apac.useatlas.dev" },
    staging: { label: "Staging", databaseUrl: "x", apiUrl: "https://api.staging.useatlas.dev" },
  },
};

const ORIGIN_ENV = [
  "ATLAS_API_REGION",
  "ATLAS_CORS_ORIGIN",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "ATLAS_RPID",
] as const;

describe("region-derived web origin → CORS default + passkey rpID", () => {
  beforeEach(() => {
    mockConfig = { residency: PROD_RESIDENCY };
    for (const key of ORIGIN_ENV) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ORIGIN_ENV) delete process.env[key];
  });

  // Every prod region collapses onto the single app.useatlas.dev web service;
  // staging keeps its own. rpID is the web origin's host (the value enrolled
  // passkeys are bound to — must NOT drift).
  it.each([
    ["us", "https://app.useatlas.dev", "app.useatlas.dev"],
    ["eu", "https://app.useatlas.dev", "app.useatlas.dev"],
    ["apac", "https://app.useatlas.dev", "app.useatlas.dev"],
    ["staging", "https://app.staging.useatlas.dev", "app.staging.useatlas.dev"],
  ] as const)("region %s derives CORS origin %s and rpID %s", (region, expectedOrigin, expectedRpId) => {
    process.env.ATLAS_API_REGION = region;

    expect(getWebOrigin()).toBe(expectedOrigin);
    expect(resolveCorsOrigin()).toBe(expectedOrigin);
    expect(resolvePasskeyRpId(process.env, getWebOrigin())).toBe(expectedRpId);
  });

  it("explicit ATLAS_RPID overrides the region-derived value", () => {
    process.env.ATLAS_API_REGION = "us";
    process.env.ATLAS_RPID = "useatlas.dev"; // parent domain — valid for app.useatlas.dev
    expect(resolvePasskeyRpId(process.env, getWebOrigin())).toBe("useatlas.dev");
  });

  it("self-hosted (no region) leaves CORS at the wildcard and rpID at the legacy default", () => {
    mockConfig = null;
    expect(getWebOrigin()).toBeNull();
    expect(resolveCorsOrigin()).toBe("*");
    expect(resolvePasskeyRpId(process.env, getWebOrigin())).toBe("app.useatlas.dev");
  });
});
