/**
 * Tests for per-region origin derivation (#3706).
 *
 * Locks down the derived public API origin and web origin for each SaaS region
 * (us / eu / apac / staging), since those feed ATLAS_PUBLIC_API_URL (OAuth
 * redirect URIs), the ATLAS_CORS_ORIGIN default, and the passkey rpID. The
 * web-origin transform is what guarantees no behavior change: every prod region
 * collapses onto the single `app.useatlas.dev` web service, and staging keeps
 * its own `app.staging.useatlas.dev`.
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
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { deriveRegionApiUrl, deriveRegionWebOrigin } = await import("../origins");

// The prod residency map mirrors deploy/api/atlas.config.ts. Staging ships its
// own single-region map in deploy/api-staging/atlas.config.ts.
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

  describe("deriveRegionApiUrl — the API host itself (ATLAS_PUBLIC_API_URL)", () => {
    it("us → https://api.useatlas.dev", () => {
      process.env.ATLAS_API_REGION = "us";
      expect(deriveRegionApiUrl()).toBe("https://api.useatlas.dev");
    });

    it("eu → https://api-eu.useatlas.dev", () => {
      process.env.ATLAS_API_REGION = "eu";
      expect(deriveRegionApiUrl()).toBe("https://api-eu.useatlas.dev");
    });

    it("apac → https://api-apac.useatlas.dev", () => {
      process.env.ATLAS_API_REGION = "apac";
      expect(deriveRegionApiUrl()).toBe("https://api-apac.useatlas.dev");
    });

    it("staging → https://api.staging.useatlas.dev", () => {
      process.env.ATLAS_API_REGION = "staging";
      expect(deriveRegionApiUrl()).toBe("https://api.staging.useatlas.dev");
    });

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
