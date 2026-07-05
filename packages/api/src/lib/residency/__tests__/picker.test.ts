/**
 * The signup data-residency picker must exclude regions flagged
 * `selectable: false` — internal regions (e.g. the shared-config `staging` arm
 * the api-staging soak service claims) that exist for the boot guard + routing
 * but must never be a selectable residency choice for real signups (#3948).
 */
import { describe, it, expect } from "bun:test";
import {
  buildAvailableRegions,
  buildSignupRegions,
  isRegionSelectable,
  selectDeployRegionEntries,
  type RegionPickerOptions,
} from "@atlas/api/lib/residency/picker";
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

describe("buildAvailableRegions — home-region override (#4131)", () => {
  // The api-staging soak service builds from the shared PROD config (us/eu/apac +
  // a non-selectable `staging` arm) but claims `ATLAS_API_REGION=staging`. Without
  // the home-region override the picker served there offered us/eu/apac, whose
  // apiUrls point at the PROD edges — picking one cross-origins the account-create
  // POST (`net::ERR_FAILED`) and dead-ends staging signup. The inverse of #3948:
  // there the staging arm leaked INTO the prod picker; here the staging deploy
  // served the PROD arms instead of its own.
  it("offers only the home arm when this deploy's region is non-selectable (staging)", () => {
    const available = buildAvailableRegions(REGIONS, "us", { apiRegion: "staging" });
    expect(available).toEqual([
      { id: "staging", label: "Staging", isDefault: true, apiUrl: "https://api.staging.useatlas.dev" },
    ]);
  });

  it("serves NO prod apiUrls on the staging deploy", () => {
    const urls = buildAvailableRegions(REGIONS, "us", { apiRegion: "staging" }).map((r) => r.apiUrl);
    expect(urls).toEqual(["https://api.staging.useatlas.dev"]);
    expect(urls).not.toContain("https://api.useatlas.dev");
    expect(urls).not.toContain("https://api-eu.useatlas.dev");
    expect(urls).not.toContain("https://api-apac.useatlas.dev");
  });

  it("offers the full selectable set when this deploy's home region IS selectable (prod us)", () => {
    const ids = buildAvailableRegions(REGIONS, "us", { apiRegion: "us" }).map((r) => r.id);
    expect(ids.toSorted()).toEqual(["apac", "eu", "us"]);
    expect(ids).not.toContain("staging");
  });

  it("offers the full set with the config default unchanged when the home region is selectable but not the default (prod eu/apac deploy)", () => {
    // The api-eu / api-apac prod deploys ship the SAME shared config
    // (defaultRegion "us") but claim ATLAS_API_REGION=eu/apac. Their home arm is
    // selectable, so the picker must NOT collapse and must NOT re-mark the home
    // arm as default — "us" stays the default, eu/apac are offered alongside it.
    const available = buildAvailableRegions(REGIONS, "us", { apiRegion: "eu" });
    expect(available.map((r) => r.id).toSorted()).toEqual(["apac", "eu", "us"]);
    expect(available.find((r) => r.id === "eu")?.isDefault).toBe(false);
    expect(available.find((r) => r.id === "us")?.isDefault).toBe(true);
  });

  it("is unchanged (full selectable set) when no api region is given — back-compat", () => {
    const idsUndefined = buildAvailableRegions(REGIONS, "us", { apiRegion: undefined }).map((r) => r.id);
    const idsNull = buildAvailableRegions(REGIONS, "us", { apiRegion: null }).map((r) => r.id);
    const idsNoOpts = buildAvailableRegions(REGIONS, "us").map((r) => r.id);
    expect(idsUndefined.toSorted()).toEqual(["apac", "eu", "us"]);
    expect(idsNull.toSorted()).toEqual(["apac", "eu", "us"]);
    expect(idsNoOpts.toSorted()).toEqual(["apac", "eu", "us"]);
  });

  it("falls through to the selectable set when the home region id is unknown/misconfigured", () => {
    // A typo'd ATLAS_API_REGION must not crash on the missing arm nor strand the
    // picker on a single non-existent region — fall back to the normal selectable
    // set. (`getApiRegion()` only defaults an *empty* var, so a wrong value
    // genuinely reaches here.)
    const ids = buildAvailableRegions(REGIONS, "us", { apiRegion: "nope" }).map((r) => r.id);
    expect(ids.toSorted()).toEqual(["apac", "eu", "us"]);
  });
});

describe("selectDeployRegionEntries — the shared SSOT (#3958)", () => {
  // The single home-arm-vs-selectable decision behind BOTH the signup picker
  // (buildAvailableRegions) and the login region-map (projectRegionMap). Pinning
  // it directly documents the seam the two funnels share so they can't re-drift
  // (login had lost the #4131 collapse the picker already had → #3958).
  it("collapses to the sole home arm when this deploy's region is non-selectable (staging)", () => {
    const { entries, collapsedToHome } = selectDeployRegionEntries(REGIONS, "staging");
    expect(collapsedToHome).toBe(true);
    expect(entries.map(([id]) => id)).toEqual(["staging"]);
  });

  it("returns the full selectable set (no collapse) on a selectable-home / unset deploy", () => {
    for (const apiRegion of ["us", "eu", undefined, null]) {
      const { entries, collapsedToHome } = selectDeployRegionEntries(REGIONS, apiRegion);
      expect(collapsedToHome).toBe(false);
      expect(entries.map(([id]) => id).toSorted()).toEqual(["apac", "eu", "us"]);
    }
  });

  it("falls through to the selectable set for an unknown (typo'd) home region id", () => {
    const { entries, collapsedToHome } = selectDeployRegionEntries(REGIONS, "nope");
    expect(collapsedToHome).toBe(false);
    expect(entries.map(([id]) => id).toSorted()).toEqual(["apac", "eu", "us"]);
  });
});

describe("buildSignupRegions — offered default ∈ picker list (#4131)", () => {
  // Cross-field invariant: the signup page pre-selects the region named by the
  // response `defaultRegion`, so it MUST be present in availableRegions as the
  // isDefault item — otherwise the naive Continue click dead-ends on the
  // "contact support" path. The home-arm collapse returns a single arm that is
  // not the config default, so the route must report the OFFERED default.
  it("reports the collapsed home arm as the default on the staging deploy", () => {
    const { defaultRegion, availableRegions } = buildSignupRegions(REGIONS, "us", { apiRegion: "staging" });
    expect(defaultRegion).toBe("staging");
    // The reported default is present in the list and is the isDefault item.
    const def = availableRegions.find((r) => r.id === defaultRegion);
    expect(def?.isDefault).toBe(true);
    expect(availableRegions.map((r) => r.id)).toEqual(["staging"]);
  });

  it("keeps the config default on a selectable-home prod deploy (us)", () => {
    const { defaultRegion, availableRegions } = buildSignupRegions(REGIONS, "us", { apiRegion: "us" });
    expect(defaultRegion).toBe("us");
    expect(availableRegions.find((r) => r.id === "us")?.isDefault).toBe(true);
  });

  it("keeps the config default 'us' even when served by a non-default prod arm (eu)", () => {
    const { defaultRegion, availableRegions } = buildSignupRegions(REGIONS, "us", { apiRegion: "eu" });
    expect(defaultRegion).toBe("us");
    expect(availableRegions.map((r) => r.id)).toContain("us");
    expect(availableRegions.find((r) => r.id === "us")?.isDefault).toBe(true);
  });

  it("keeps the config default when no api region is given — back-compat", () => {
    const { defaultRegion, availableRegions } = buildSignupRegions(REGIONS, "eu");
    expect(defaultRegion).toBe("eu");
    expect(availableRegions.find((r) => r.id === "eu")?.isDefault).toBe(true);
  });

  // The fallback edge: a misconfig where the config default is itself
  // non-selectable or unknown. Echoing it would re-strand the invariant (the
  // returned default would be absent from the list), so the first offered arm is
  // promoted instead. Unreachable in the shared prod config (default "us" is
  // selectable) but config validation permits it, so pin the behavior.
  it("promotes the first offered arm when the config default is non-selectable", () => {
    const { defaultRegion, availableRegions } = buildSignupRegions(REGIONS, "staging");
    // Never echoes the non-selectable "staging" as the default.
    expect(defaultRegion).not.toBe("staging");
    // Invariant: the returned default is in the list AND is the isDefault item.
    expect(availableRegions.map((r) => r.id)).toContain(defaultRegion);
    expect(availableRegions.find((r) => r.id === defaultRegion)?.isDefault).toBe(true);
    // Exactly one isDefault arm (the promoted one).
    expect(availableRegions.filter((r) => r.isDefault).map((r) => r.id)).toEqual([defaultRegion]);
  });

  it("promotes the first offered arm when the config default is an unknown id", () => {
    const { defaultRegion, availableRegions } = buildSignupRegions(REGIONS, "zz", { apiRegion: "us" });
    expect(defaultRegion).not.toBe("zz");
    expect(availableRegions.map((r) => r.id)).toContain(defaultRegion);
    expect(availableRegions.find((r) => r.id === defaultRegion)?.isDefault).toBe(true);
  });

  it("returns the config default with an empty list when no region is selectable", () => {
    // The deliberate carve-out: with nothing offerable there is no in-list arm to
    // promote, so the config default is echoed alongside an empty list. The signup
    // page reads `availableRegions.length === 0` as "nothing to pick" and skips
    // the step, so the out-of-list default never reaches a pre-select. Pins the
    // `!first` guard against a refactor that drops it (→ `first.id` on undefined).
    const empty: Regions = {};
    expect(buildSignupRegions(empty, "us")).toEqual({ defaultRegion: "us", availableRegions: [] });
    // Same when every configured region is non-selectable.
    const allNonSelectable: Regions = { staging: { label: "Staging", selectable: false } };
    expect(buildSignupRegions(allNonSelectable, "staging")).toEqual({
      defaultRegion: "staging",
      availableRegions: [],
    });
  });

  it("keeps the invariant (default ∈ list, or list empty) across configs", () => {
    // Property check over the reachable + misconfig shapes: the reported default
    // is always selectable from the offered list (the page never pre-selects a
    // region absent from the picker), unless there is nothing to offer at all.
    const cases: Array<[string, RegionPickerOptions | undefined]> = [
      ["us", undefined],
      ["us", { apiRegion: "staging" }],
      ["us", { apiRegion: "eu" }],
      ["staging", undefined],
      ["zz", { apiRegion: "us" }],
      ["eu", { apiRegion: "nope" }],
    ];
    for (const [configDefault, opts] of cases) {
      const { defaultRegion, availableRegions } = buildSignupRegions(REGIONS, configDefault, opts);
      if (availableRegions.length > 0) {
        expect(availableRegions.map((r) => r.id)).toContain(defaultRegion);
        expect(availableRegions.find((r) => r.id === defaultRegion)?.isDefault).toBe(true);
      }
    }
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
