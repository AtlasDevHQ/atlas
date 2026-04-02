import { describe, it, expect, beforeEach } from "bun:test";
import { getApiUrl, isCrossOrigin, setRegionalApiUrl, _resetApiUrl } from "../../lib/api-url";

// The default API URL comes from NEXT_PUBLIC_ATLAS_API_URL, which is
// typically empty in the test environment.
const DEFAULT_URL = (process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "").replace(/\/+$/, "");

describe("api-url", () => {
  beforeEach(() => {
    _resetApiUrl();
  });

  describe("getApiUrl", () => {
    it("returns default (env-based) URL initially", () => {
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("returns regional URL after setRegionalApiUrl", () => {
      setRegionalApiUrl("https://api-eu.useatlas.dev");
      expect(getApiUrl()).toBe("https://api-eu.useatlas.dev");
    });

    it("strips trailing slashes from regional URL", () => {
      setRegionalApiUrl("https://api-eu.useatlas.dev///");
      expect(getApiUrl()).toBe("https://api-eu.useatlas.dev");
    });

    it("reverts to default after setRegionalApiUrl(null)", () => {
      setRegionalApiUrl("https://api-eu.useatlas.dev");
      expect(getApiUrl()).toBe("https://api-eu.useatlas.dev");

      setRegionalApiUrl(null);
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("reverts to default after _resetApiUrl", () => {
      setRegionalApiUrl("https://api-eu.useatlas.dev");
      _resetApiUrl();
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });
  });

  describe("isCrossOrigin", () => {
    it("returns false when no API URL is configured", () => {
      _resetApiUrl();
      // When default is empty and no regional override, not cross-origin
      if (DEFAULT_URL === "") {
        expect(isCrossOrigin()).toBe(false);
      } else {
        // If env var is set in this environment, cross-origin is true
        expect(isCrossOrigin()).toBe(true);
      }
    });

    it("returns true when regional URL is set", () => {
      setRegionalApiUrl("https://api-eu.useatlas.dev");
      expect(isCrossOrigin()).toBe(true);
    });

    it("returns false after clearing regional URL when default is empty", () => {
      setRegionalApiUrl("https://api-eu.useatlas.dev");
      expect(isCrossOrigin()).toBe(true);
      setRegionalApiUrl(null);
      expect(isCrossOrigin()).toBe(!!DEFAULT_URL);
    });
  });

  describe("setRegionalApiUrl", () => {
    it("overrides the default URL", () => {
      setRegionalApiUrl("https://regional.example.com");
      expect(getApiUrl()).toBe("https://regional.example.com");
    });

    it("accepts null to clear override", () => {
      setRegionalApiUrl("https://regional.example.com");
      setRegionalApiUrl(null);
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("rejects invalid URL and keeps default", () => {
      setRegionalApiUrl("not-a-url");
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("rejects whitespace-only string and keeps default", () => {
      setRegionalApiUrl("   ");
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("rejects empty string and keeps default", () => {
      setRegionalApiUrl("");
      expect(getApiUrl()).toBe(DEFAULT_URL);
    });

    it("trims whitespace from valid URL", () => {
      setRegionalApiUrl("  https://api-eu.useatlas.dev  ");
      expect(getApiUrl()).toBe("https://api-eu.useatlas.dev");
    });
  });
});
