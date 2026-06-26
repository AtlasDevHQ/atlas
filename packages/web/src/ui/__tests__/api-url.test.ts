import { describe, it, expect, beforeEach } from "bun:test";
import {
  getApiUrl,
  isCrossOrigin,
  getActiveRegion,
  applyRegionSignal,
  clearRegionSignal,
  initRegionFromCookie,
  secureCookieAttr,
  _resetApiUrl,
  REGION_COOKIE,
} from "../../lib/api-url";

// The default API URL comes from NEXT_PUBLIC_ATLAS_API_URL, which is
// typically empty in the test environment.
const DEFAULT_URL = (process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "").replace(/\/+$/, "");
const EU = "https://api-eu.useatlas.dev";

/** Read the raw `atlas_region` cookie value (decoded), or null. */
function readRegionCookie(): { region?: string; apiUrl?: string } | null {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${REGION_COOKIE}=`));
  const raw = match?.slice(REGION_COOKIE.length + 1);
  if (!raw) return null;
  return JSON.parse(decodeURIComponent(raw)) as { region?: string; apiUrl?: string };
}

/** Write the cookie directly, simulating what a previous session/load left. */
function seedRegionCookie(value: string): void {
  document.cookie = `${REGION_COOKIE}=${value}; path=/`;
}

function deleteRegionCookie(): void {
  document.cookie = `${REGION_COOKIE}=; path=/; max-age=0`;
}

describe("api-url", () => {
  beforeEach(() => {
    deleteRegionCookie();
    _resetApiUrl();
  });

  describe("getApiUrl / default fallback", () => {
    it("returns the build-time default URL with no region signal", () => {
      expect(getApiUrl()).toBe(DEFAULT_URL);
      expect(getActiveRegion()).toBeNull();
    });

    it("returns the regional URL after applyRegionSignal", () => {
      applyRegionSignal("eu", EU);
      expect(getApiUrl()).toBe(EU);
      expect(getActiveRegion()).toBe("eu");
    });

    it("strips trailing slashes from the regional URL", () => {
      applyRegionSignal("eu", `${EU}///`);
      expect(getApiUrl()).toBe(EU);
    });

    it("reverts to the default after clearRegionSignal", () => {
      applyRegionSignal("eu", EU);
      expect(getApiUrl()).toBe(EU);
      clearRegionSignal();
      expect(getApiUrl()).toBe(DEFAULT_URL);
      expect(getActiveRegion()).toBeNull();
    });

    it("reverts to the default after _resetApiUrl (in-memory only)", () => {
      applyRegionSignal("eu", EU);
      _resetApiUrl();
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });
  });

  describe("atlas_region cookie persistence", () => {
    it("persists {region, apiUrl} in the atlas_region cookie on apply", () => {
      applyRegionSignal("eu", EU);
      const cookie = readRegionCookie();
      expect(cookie?.region).toBe("eu");
      expect(cookie?.apiUrl).toBe(EU);
    });

    it("survives a reload: a fresh init reads the cookie and resolves the regional base", () => {
      // Simulate selection in one page lifetime…
      applyRegionSignal("eu", EU);
      // …then a reload: in-memory state is gone but the cookie remains.
      _resetApiUrl();
      expect(getApiUrl()).toBe(DEFAULT_URL); // not yet restored
      initRegionFromCookie();
      expect(getApiUrl()).toBe(EU);
      expect(getActiveRegion()).toBe("eu");
    });

    it("initRegionFromCookie restores from a cookie written by a prior session", () => {
      seedRegionCookie(
        encodeURIComponent(JSON.stringify({ region: "apac", apiUrl: "https://api-apac.useatlas.dev" })),
      );
      initRegionFromCookie();
      expect(getActiveRegion()).toBe("apac");
      expect(getApiUrl()).toBe("https://api-apac.useatlas.dev");
    });

    it("clearRegionSignal removes the atlas_region cookie", () => {
      applyRegionSignal("eu", EU);
      expect(readRegionCookie()).not.toBeNull();
      clearRegionSignal();
      expect(readRegionCookie()).toBeNull();
    });

    it("ignores a malformed cookie and falls back to the default", () => {
      seedRegionCookie("not-json");
      initRegionFromCookie();
      expect(getActiveRegion()).toBeNull();
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("ignores a cookie missing region or apiUrl", () => {
      seedRegionCookie(encodeURIComponent(JSON.stringify({ region: "eu" })));
      initRegionFromCookie();
      expect(getActiveRegion()).toBeNull();
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("ignores a cookie whose apiUrl is not a valid URL", () => {
      seedRegionCookie(encodeURIComponent(JSON.stringify({ region: "eu", apiUrl: "not-a-url" })));
      initRegionFromCookie();
      expect(getActiveRegion()).toBeNull();
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });
  });

  describe("isCrossOrigin", () => {
    it("returns false with no region signal when the default is empty", () => {
      if (DEFAULT_URL === "") {
        expect(isCrossOrigin()).toBe(false);
      } else {
        expect(isCrossOrigin()).toBe(true);
      }
    });

    it("returns true when a regional base is active", () => {
      applyRegionSignal("eu", EU);
      expect(isCrossOrigin()).toBe(true);
    });

    it("returns to the default-derived value after clearing the regional base", () => {
      applyRegionSignal("eu", EU);
      expect(isCrossOrigin()).toBe(true);
      clearRegionSignal();
      expect(isCrossOrigin()).toBe(!!DEFAULT_URL);
    });
  });

  describe("applyRegionSignal validation", () => {
    it("rejects an invalid apiUrl and keeps the current base", () => {
      expect(applyRegionSignal("eu", "not-a-url")).toBe(false);
      expect(getApiUrl()).toBe(DEFAULT_URL);
      expect(getActiveRegion()).toBeNull();
      expect(readRegionCookie()).toBeNull();
    });

    it("rejects a whitespace-only apiUrl and keeps the current base", () => {
      expect(applyRegionSignal("eu", "   ")).toBe(false);
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("rejects an empty region and keeps the current base", () => {
      expect(applyRegionSignal("  ", EU)).toBe(false);
      expect(getApiUrl()).toBe(DEFAULT_URL);
      expect(readRegionCookie()).toBeNull();
    });

    it("trims whitespace from a valid apiUrl", () => {
      applyRegionSignal("eu", `  ${EU}  `);
      expect(getApiUrl()).toBe(EU);
    });

    it("returns true on a successful apply", () => {
      expect(applyRegionSignal("eu", EU)).toBe(true);
    });
  });

  describe("apiUrl scheme policy (client-writable cookie → credentialed fetch)", () => {
    it("accepts an https regional base", () => {
      expect(applyRegionSignal("eu", "https://api-eu.useatlas.dev")).toBe(true);
    });

    it("accepts http only for localhost (local dev)", () => {
      expect(applyRegionSignal("dev", "http://localhost:3001")).toBe(true);
      expect(getApiUrl()).toBe("http://localhost:3001");
    });

    it("rejects http on a non-localhost host", () => {
      expect(applyRegionSignal("eu", "http://api-eu.useatlas.dev")).toBe(false);
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("rejects a javascript: scheme even though it parses", () => {
      expect(applyRegionSignal("eu", "javascript:alert(1)")).toBe(false);
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("ignores a cookie whose apiUrl uses a disallowed scheme", () => {
      seedRegionCookie(
        encodeURIComponent(JSON.stringify({ region: "eu", apiUrl: "http://evil.example.com" })),
      );
      initRegionFromCookie();
      expect(getActiveRegion()).toBeNull();
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });
  });

  describe("secureCookieAttr", () => {
    it("omits Secure on http so the cookie stores in local dev / the test DOM", () => {
      expect(secureCookieAttr("http:")).toBe("");
    });

    it("adds Secure on https (prod regional hosts)", () => {
      expect(secureCookieAttr("https:")).toBe("; Secure");
    });

    it("defaults to Secure when the protocol is unknown (SSR)", () => {
      expect(secureCookieAttr(undefined)).toBe("; Secure");
    });
  });
});
