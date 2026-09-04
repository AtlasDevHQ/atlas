/**
 * Tests for per-region origin derivation (#3706, extended #3970).
 *
 * Part 1 locks down the derived public API origin and web origin for each SaaS
 * region (us / eu / apac / staging), since those feed ATLAS_PUBLIC_API_URL
 * (OAuth redirect URIs), the ATLAS_CORS_ORIGIN default, and the passkey rpID.
 * The web-origin transform is what guarantees no behavior change: every prod
 * region collapses onto the single `app.useatlas.dev` web service, and staging
 * keeps its own `app.staging.useatlas.dev`.
 *
 * Part 2 (formerly `region-origins-integration.test.ts`) walks the whole chain
 * that used to require per-service env stamping — `getWebOrigin()` → the
 * `ATLAS_CORS_ORIGIN` default (`resolveCorsOrigin`) and the passkey rpID
 * (`resolvePasskeyRpId`) — with NO origin env vars set, only `ATLAS_API_REGION`
 * + the residency map. #3970 extends the same "process is the region"
 * derivation to Better Auth's own `baseURL`: `deriveRegionApiUrl()` returns the
 * issuing regional API host (the value `resolveAuthBaseURL` falls back to when
 * BETTER_AUTH_URL is unset), so each regional Better Auth instance is bound to
 * its own host without per-service env stamping.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

let mockConfig: Record<string, unknown> | null = null;

void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
  configFromEnv: () => ({}),
  loadConfig: async () => ({}),
  defineConfig: (c: unknown) => c,
  validateAndResolve: (r: unknown) => r,
  _setConfigForTest: () => {},
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// No explicit CORS override — force resolveCorsOrigin through the region default.
void mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: () => undefined,
  getSetting: () => undefined,
}));

const { deriveRegionApiUrl, deriveRegionWebOrigin } = await import("../origins");
const { getWebOrigin } = await import("@atlas/api/lib/web-origin");
const { resolveCorsOrigin } = await import("@atlas/api/lib/cors");
const { resolvePasskeyRpId } = await import("@atlas/api/lib/auth/rpid");

// The prod residency map mirrors deploy/api/atlas.config.ts. The api-staging
// soak service runs this SAME shared config (no separate config — the half-built
// one was retired in #3958); its funnels collapse to the `staging` home arm via
// lib/residency/picker.ts (`selectDeployRegionEntries`).
const PROD_RESIDENCY = {
  defaultRegion: "us",
  regions: {
    us: { label: "United States", databaseUrl: "postgres://us", apiUrl: "https://api.useatlas.dev" },
    eu: { label: "Europe", databaseUrl: "postgres://eu", apiUrl: "https://api-eu.useatlas.dev" },
    apac: { label: "Asia Pacific", databaseUrl: "postgres://apac", apiUrl: "https://api-apac.useatlas.dev" },
    staging: { label: "Staging", databaseUrl: "postgres://staging", apiUrl: "https://api.staging.useatlas.dev" },
  },
};

describe("per-region origin derivation", () => {
  beforeEach(() => {
    mockConfig = { residency: PROD_RESIDENCY };
    delete process.env.ATLAS_API_REGION;
  });

  afterEach(() => {
    delete process.env.ATLAS_API_REGION;
  });

  // The per-region us/eu/apac/staging → apiUrl mapping is asserted by the
  // it.each table in the chain section below, which pins the same four values
  // plus the CORS origin, rpID and auth baseURL derived from each.
  describe("deriveRegionApiUrl — the API host itself (ATLAS_PUBLIC_API_URL)", () => {
    it("falls back to residency.defaultRegion when ATLAS_API_REGION unset", () => {
      // defaultRegion is "us"
      expect(deriveRegionApiUrl()).toBe("https://api.useatlas.dev");
    });

    it("returns null when no region is configured (self-hosted)", () => {
      mockConfig = null;
      expect(deriveRegionApiUrl()).toBeNull();
    });

    it("strips a trailing slash from the configured apiUrl", () => {
      process.env.ATLAS_API_REGION = "us";
      mockConfig = {
        residency: {
          defaultRegion: "us",
          regions: { us: { label: "US", databaseUrl: "x", apiUrl: "https://api.useatlas.dev/" } },
        },
      };
      expect(deriveRegionApiUrl()).toBe("https://api.useatlas.dev");
    });
  });

  describe("deriveRegionWebOrigin — the web app origin (CORS default + rpID)", () => {
    it("us → https://app.useatlas.dev", () => {
      process.env.ATLAS_API_REGION = "us";
      expect(deriveRegionWebOrigin()).toBe("https://app.useatlas.dev");
    });

    it("eu collapses onto the single web service → https://app.useatlas.dev", () => {
      process.env.ATLAS_API_REGION = "eu";
      expect(deriveRegionWebOrigin()).toBe("https://app.useatlas.dev");
    });

    it("apac collapses onto the single web service → https://app.useatlas.dev", () => {
      process.env.ATLAS_API_REGION = "apac";
      expect(deriveRegionWebOrigin()).toBe("https://app.useatlas.dev");
    });

    it("staging keeps its own → https://app.staging.useatlas.dev", () => {
      process.env.ATLAS_API_REGION = "staging";
      expect(deriveRegionWebOrigin()).toBe("https://app.staging.useatlas.dev");
    });

    it("returns null when no region is configured (self-hosted)", () => {
      mockConfig = null;
      expect(deriveRegionWebOrigin()).toBeNull();
    });

    it("returns null when the host's first label is not an api label", () => {
      process.env.ATLAS_API_REGION = "custom";
      mockConfig = {
        residency: {
          defaultRegion: "custom",
          regions: { custom: { label: "Custom", databaseUrl: "x", apiUrl: "https://gateway.example.com" } },
        },
      };
      expect(deriveRegionWebOrigin()).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// The whole chain: region → web origin → CORS default + passkey rpID + Better
// Auth baseURL (formerly region-origins-integration.test.ts, #3706 / #3970).
// ---------------------------------------------------------------------------

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
  // passkeys are bound to — must NOT drift). The Better Auth baseURL, by
  // contrast, is the issuing region's OWN API host (#3970) — that is exactly
  // what makes the minted cookie host-only to that region.
  it.each([
    ["us", "https://app.useatlas.dev", "app.useatlas.dev", "https://api.useatlas.dev"],
    ["eu", "https://app.useatlas.dev", "app.useatlas.dev", "https://api-eu.useatlas.dev"],
    ["apac", "https://app.useatlas.dev", "app.useatlas.dev", "https://api-apac.useatlas.dev"],
    [
      "staging",
      "https://app.staging.useatlas.dev",
      "app.staging.useatlas.dev",
      "https://api.staging.useatlas.dev",
    ],
  ] as const)(
    "region %s derives CORS origin %s, rpID %s, auth baseURL %s",
    (region, expectedOrigin, expectedRpId, expectedApiUrl) => {
      process.env.ATLAS_API_REGION = region;

      expect(getWebOrigin()).toBe(expectedOrigin);
      expect(resolveCorsOrigin()).toBe(expectedOrigin);
      expect(resolvePasskeyRpId(process.env, getWebOrigin())).toBe(expectedRpId);
      // The region's own API host — fed to resolveAuthBaseURL as the
      // BETTER_AUTH_URL fallback so each regional process self-binds.
      expect(deriveRegionApiUrl()).toBe(expectedApiUrl);
    },
  );

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
    // No residency map → no derived API host; resolveAuthBaseURL then falls
    // through to BETTER_AUTH_URL / Vercel / Better Auth's own auto-detect.
    expect(deriveRegionApiUrl()).toBeNull();
  });
});
