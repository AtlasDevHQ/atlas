import { describe, it, expect, afterAll } from "bun:test";

/**
 * The module-load restore is the *only* production path that makes a returning
 * user's very first getApiUrl() call regional — the top-level
 * `if (typeof document !== "undefined") activeSignal = readRegionCookie()` in
 * api-url.ts. The sibling api-url.test.ts simulates it via an explicit
 * initRegionFromCookie() call, but that branch never runs with a cookie present
 * because the static import there resolves before any test seeds a cookie.
 *
 * The isolated per-file runner gives this file fresh module state, so seeding
 * the cookie *before* the dynamic import exercises the real import-time branch.
 * This is also what transitively points the auth client's baseURL at the
 * regional host on import (auth/client.ts).
 */

// Seed BEFORE importing api-url so its top-level restore runs with the cookie
// present — the dynamic import is what executes that branch.
document.cookie = `atlas_region=${encodeURIComponent(
  JSON.stringify({ region: "eu", apiUrl: "https://api-eu.useatlas.dev" }),
)}; path=/`;

const mod = await import("../../lib/api-url");

// Tidy up so the seeded cookie + restored singleton don't leak into any file
// co-run in the same process (CI runs each file isolated, but stay a good
// citizen).
afterAll(() => {
  document.cookie = "atlas_region=; path=/; max-age=0";
  mod._resetApiUrl();
});

describe("api-url module-load cookie restore", () => {
  it("resolves the regional base at import when the atlas_region cookie is present", () => {
    expect(mod.getApiUrl()).toBe("https://api-eu.useatlas.dev");
    expect(mod.getActiveRegion()).toBe("eu");
    expect(mod.isCrossOrigin()).toBe(true);
  });
});
