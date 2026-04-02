import { describe, it, expect, beforeEach } from "bun:test";
import { getApiUrl, isCrossOrigin, setRegionalApiUrl, _resetApiUrl } from "../../lib/api-url";

describe("api-url", () => {
  beforeEach(() => {
    _resetApiUrl();
  });

  describe("getApiUrl", () => {
    it("returns default (env-based) URL initially", () => {
      const url = getApiUrl();
      // In test env, NEXT_PUBLIC_ATLAS_API_URL is typically empty
      expect(typeof url).toBe("string");
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
      // Back to default
      expect(getApiUrl()).not.toBe("https://api-eu.useatlas.dev");
    });

    it("reverts to default after _resetApiUrl", () => {
      setRegionalApiUrl("https://api-eu.useatlas.dev");
      _resetApiUrl();
      expect(getApiUrl()).not.toBe("https://api-eu.useatlas.dev");
    });
  });

  describe("isCrossOrigin", () => {
    it("returns false when API URL is empty", () => {
      // Default env is typically empty in tests
      _resetApiUrl();
      // If NEXT_PUBLIC_ATLAS_API_URL is empty, isCrossOrigin should be false
      if (!getApiUrl()) {
        expect(isCrossOrigin()).toBe(false);
      }
    });

    it("returns true when regional URL is set", () => {
      setRegionalApiUrl("https://api-eu.useatlas.dev");
      expect(isCrossOrigin()).toBe(true);
    });
  });

  describe("setRegionalApiUrl", () => {
    it("overrides the default URL", () => {
      const before = getApiUrl();
      setRegionalApiUrl("https://regional.example.com");
      expect(getApiUrl()).toBe("https://regional.example.com");
      expect(getApiUrl()).not.toBe(before || "should-differ");
    });

    it("accepts null to clear override", () => {
      setRegionalApiUrl("https://regional.example.com");
      setRegionalApiUrl(null);
      expect(getApiUrl()).not.toBe("https://regional.example.com");
    });
  });
});
