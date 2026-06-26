/**
 * The signup data-residency picker must exclude regions flagged
 * `selectable: false` — internal regions (e.g. the shared-config `staging` arm
 * the api-staging soak service claims) that exist for the boot guard + routing
 * but must never be a selectable residency choice for real signups (#3948).
 */
import { describe, it, expect } from "bun:test";
import { buildAvailableRegions, isRegionSelectable } from "@atlas/api/lib/residency/picker";
import type { ResidencyConfig } from "@atlas/api/lib/config";

type Regions = ResidencyConfig["regions"];

const REGIONS: Regions = {
  us: { label: "United States", apiUrl: "https://api.useatlas.dev" },
  eu: { label: "Europe", apiUrl: "https://api-eu.useatlas.dev" },
  apac: { label: "Asia Pacific", apiUrl: "https://api-apac.useatlas.dev" },
  staging: { label: "Staging", apiUrl: "https://api.staging.useatlas.dev", selectable: false },
};

describe("buildAvailableRegions (#3948)", () => {
  it("excludes regions flagged selectable: false", () => {
    const ids = buildAvailableRegions(REGIONS, "us").map((r) => r.id);
    expect(ids.toSorted()).toEqual(["apac", "eu", "us"]);
    expect(ids).not.toContain("staging");
  });

  it("includes regions with selectable omitted (default true)", () => {
    const regions: Regions = {
      us: { label: "United States" },
      eu: { label: "Europe", selectable: true },
    };
    const ids = buildAvailableRegions(regions, "us").map((r) => r.id);
    expect(ids.toSorted()).toEqual(["eu", "us"]);
  });

  it("marks the default region and passes the label + apiUrl through", () => {
    const available = buildAvailableRegions(REGIONS, "eu");
    const eu = available.find((r) => r.id === "eu");
    const us = available.find((r) => r.id === "us");
    // apiUrl rides along so the signup picker can repoint the browser at the
    // chosen region before the first identity write (ADR-0024 §4).
    expect(eu).toEqual({ id: "eu", label: "Europe", isDefault: true, apiUrl: "https://api-eu.useatlas.dev" });
    expect(us?.isDefault).toBe(false);
    expect(us?.apiUrl).toBe("https://api.useatlas.dev");
  });

  it("passes apiUrl through as undefined when the region config omits it", () => {
    // Single-region / local-dev configs omit apiUrl; the browser then stays on
    // its same-origin base (no repoint possible) rather than getting a bad URL.
    const regions: Regions = { us: { label: "United States" } };
    const us = buildAvailableRegions(regions, "us").find((r) => r.id === "us");
    expect(us).toEqual({ id: "us", label: "United States", isDefault: true, apiUrl: undefined });
  });

  it("never marks a non-selectable region as default even if it is the configured default", () => {
    // Defensive: a misconfig where defaultRegion points at a non-selectable
    // region must not leak that region into the picker.
    const ids = buildAvailableRegions(REGIONS, "staging").map((r) => r.id);
    expect(ids).not.toContain("staging");
  });
});

describe("isRegionSelectable (#3948 — shared read/write predicate)", () => {
  it("is true for a region with selectable omitted (default true)", () => {
    expect(isRegionSelectable({ label: "United States" })).toBe(true);
  });

  it("is true for a region explicitly selectable", () => {
    expect(isRegionSelectable({ label: "Europe", selectable: true })).toBe(true);
  });

  it("is false for a region flagged selectable: false", () => {
    expect(isRegionSelectable({ label: "Staging", selectable: false })).toBe(false);
  });

  it("is false for an unknown region (undefined)", () => {
    // The write path looks up `regions[region]` which is undefined for an
    // unknown id — assignment must reject it, not treat it as selectable.
    expect(isRegionSelectable(undefined)).toBe(false);
  });
});
