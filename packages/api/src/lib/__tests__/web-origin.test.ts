/**
 * `getWebOrigin()` resolution-order tests.
 *
 * The web origin anchors the passkey rpID, the `ATLAS_CORS_ORIGIN` default, and
 * the cross-subdomain cookie domain (`getAuthInstance` in `auth/server.ts`).
 * #3706 dropped the former `ATLAS_CORS_ORIGIN`-set gate on the cookie-domain
 * path, so `getWebOrigin()` is now consulted unconditionally — which means the
 * `BETTER_AUTH_TRUSTED_ORIGINS` fallback (the tier SaaS relies on once
 * `ATLAS_CORS_ORIGIN` is no longer stamped) and the region fallback must stay
 * pinned. Self-hosted single-origin deploys still resolve to `null`.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

let mockConfig: Record<string, unknown> | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
  configFromEnv: () => ({}),
  loadConfig: async () => ({}),
  defineConfig: (c: unknown) => c,
  validateAndResolve: (r: unknown) => r,
  _setConfigForTest: () => {},
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { getWebOrigin } = await import("@atlas/api/lib/web-origin");

const PROD_RESIDENCY = {
  defaultRegion: "us",
  regions: {
    us: { label: "United States", databaseUrl: "x", apiUrl: "https://api.useatlas.dev" },
    eu: { label: "Europe", databaseUrl: "x", apiUrl: "https://api-eu.useatlas.dev" },
  },
};

const ORIGIN_ENV = ["ATLAS_API_REGION", "ATLAS_CORS_ORIGIN", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

describe("getWebOrigin resolution order", () => {
  beforeEach(() => {
    mockConfig = null;
    for (const key of ORIGIN_ENV) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ORIGIN_ENV) delete process.env[key];
  });

  it("prefers the first ATLAS_CORS_ORIGIN entry, trimming trailing slashes", () => {
    process.env.ATLAS_CORS_ORIGIN = "https://app.useatlas.dev/,https://other.useatlas.dev";
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://trusted.useatlas.dev";
    expect(getWebOrigin()).toBe("https://app.useatlas.dev");
  });

  it("skips a wildcard ATLAS_CORS_ORIGIN and falls back to BETTER_AUTH_TRUSTED_ORIGINS", () => {
    process.env.ATLAS_CORS_ORIGIN = "*";
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://app.useatlas.dev";
    expect(getWebOrigin()).toBe("https://app.useatlas.dev");
  });

  it("falls back to the first BETTER_AUTH_TRUSTED_ORIGINS entry when CORS is unset (the SaaS post-unstamp path)", () => {
    // This is the tier the cookie-domain derivation now leans on after #3706
    // un-stamps ATLAS_CORS_ORIGIN per regional service.
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://app.useatlas.dev/,https://app2.useatlas.dev";
    expect(getWebOrigin()).toBe("https://app.useatlas.dev");
  });

  it("falls back to the region-derived web origin when no origin env is set", () => {
    mockConfig = { residency: PROD_RESIDENCY };
    process.env.ATLAS_API_REGION = "eu";
    expect(getWebOrigin()).toBe("https://app.useatlas.dev");
  });

  it("returns null for a self-hosted single-origin deploy (no origin env, no region)", () => {
    expect(getWebOrigin()).toBeNull();
  });
});
