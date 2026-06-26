/**
 * Pure region-resolution logic for the login front-door (ADR-0024 §3, #3973).
 *
 * No network: `fetchRegionMap` + `probe` are injected. These pin the routing
 * verdicts AND the security invariants — only the HASH is fanned out (never the
 * raw email), the cookie fast-path skips the probe oracle, and an unreachable
 * region never produces a confident false "none".
 */

import { describe, it, expect } from "bun:test";
import {
  resolveRegion,
  hashEmail,
  parseRegionCookie,
  normalizeEmail,
  isLikelyEmail,
} from "../login-frontdoor";
import type { RegionRoutingMap } from "@useatlas/types";

const MAP: RegionRoutingMap = {
  configured: true,
  defaultRegion: "us",
  regions: [
    { id: "us", label: "United States", apiUrl: "https://api.useatlas.dev", isDefault: true },
    { id: "eu", label: "Europe", apiUrl: "https://api-eu.useatlas.dev", isDefault: false },
    { id: "apac", label: "Asia Pacific", apiUrl: "https://api-apac.useatlas.dev", isDefault: false },
  ],
};

const mapOf = (m: RegionRoutingMap) => () => Promise.resolve(m);
/** A probe that reports the email exists only in the named regions (by apiUrl). */
function probeHitting(...apiUrls: string[]) {
  const hits = new Set(apiUrls);
  const calls: Array<{ apiUrl: string; emailHash: string }> = [];
  const probe = async (apiUrl: string, emailHash: string) => {
    calls.push({ apiUrl, emailHash });
    return hits.has(apiUrl);
  };
  return { probe, calls };
}

describe("hashEmail", () => {
  it("is sha256(lower(trim(email))) as 64-char lowercase hex", async () => {
    const h = await hashEmail("  Alice@Corp.com  ");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Case/space-insensitive: any case/whitespace variant of the same address
    // normalizes to the identical hash (matches the SQL `lower(email)` index).
    expect(await hashEmail("ALICE@CORP.COM")).toBe(h);
    expect(await hashEmail("alice@corp.com")).toBe(h);
    // Different address ⇒ different hash.
    expect(await hashEmail("bob@corp.com")).not.toBe(h);
  });
});

describe("normalizeEmail / isLikelyEmail", () => {
  it("normalizeEmail trims + lowercases", () => {
    expect(normalizeEmail("  Bob@Example.COM ")).toBe("bob@example.com");
  });
  it("isLikelyEmail accepts a plausible address, rejects junk", () => {
    expect(isLikelyEmail("a@b.co")).toBe(true);
    expect(isLikelyEmail("not-an-email")).toBe(false);
    expect(isLikelyEmail("")).toBe(false);
    expect(isLikelyEmail("a@b")).toBe(false);
  });
});

describe("parseRegionCookie", () => {
  it("extracts the region key from a valid cookie value", () => {
    const raw = encodeURIComponent(JSON.stringify({ region: "eu", apiUrl: "https://api-eu.useatlas.dev" }));
    expect(parseRegionCookie(raw)).toBe("eu");
  });
  it("returns null for missing / malformed values", () => {
    expect(parseRegionCookie(null)).toBeNull();
    expect(parseRegionCookie(undefined)).toBeNull();
    expect(parseRegionCookie("%%%not-json")).toBeNull();
    expect(parseRegionCookie(encodeURIComponent(JSON.stringify({ apiUrl: "x" })))).toBeNull();
    expect(parseRegionCookie(encodeURIComponent(JSON.stringify({ region: "" })))).toBeNull();
  });
});

describe("resolveRegion", () => {
  it("skips when residency is not configured", async () => {
    const r = await resolveRegion({
      email: "a@b.co",
      cookieRegion: null,
      fetchRegionMap: mapOf({ configured: false, defaultRegion: "none", regions: [] }),
      probe: async () => true,
    });
    expect(r).toEqual({ outcome: "skip" });
  });

  it("cookie fast-path routes to the cookie region WITHOUT probing, using the map's authoritative apiUrl", async () => {
    const { probe, calls } = probeHitting();
    const r = await resolveRegion({
      email: "a@b.co",
      cookieRegion: "eu",
      fetchRegionMap: mapOf(MAP),
      probe,
    });
    expect(r).toEqual({ outcome: "single", region: "eu", apiUrl: "https://api-eu.useatlas.dev" });
    expect(calls).toHaveLength(0); // the oracle is short-circuited
  });

  it("a stale cookie region (not in the map) falls through to the fan-out", async () => {
    const { probe, calls } = probeHitting("https://api-eu.useatlas.dev");
    const r = await resolveRegion({
      email: "a@b.co",
      cookieRegion: "antarctica",
      fetchRegionMap: mapOf(MAP),
      probe,
    });
    expect(r).toEqual({ outcome: "single", region: "eu", apiUrl: "https://api-eu.useatlas.dev" });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("single-region deployment routes without probing", async () => {
    const { probe, calls } = probeHitting();
    const r = await resolveRegion({
      email: "a@b.co",
      cookieRegion: null,
      fetchRegionMap: mapOf({
        configured: true,
        defaultRegion: "us",
        regions: [{ id: "us", label: "US", apiUrl: "https://api.useatlas.dev", isDefault: true }],
      }),
      probe,
    });
    expect(r).toEqual({ outcome: "single", region: "us", apiUrl: "https://api.useatlas.dev" });
    expect(calls).toHaveLength(0);
  });

  it("fans out the HASH (never the raw email) and routes to a single hit", async () => {
    const { probe, calls } = probeHitting("https://api-eu.useatlas.dev");
    const r = await resolveRegion({
      email: "alice@corp.com",
      cookieRegion: null,
      fetchRegionMap: mapOf(MAP),
      probe,
    });
    expect(r).toEqual({ outcome: "single", region: "eu", apiUrl: "https://api-eu.useatlas.dev" });
    const expectedHash = await hashEmail("alice@corp.com");
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.emailHash).toBe(expectedHash);
      expect(c.emailHash).not.toContain("alice"); // raw email never forwarded
    }
  });

  it("presents a chooser when the email exists in more than one region", async () => {
    const { probe } = probeHitting("https://api-eu.useatlas.dev", "https://api.useatlas.dev");
    const r = await resolveRegion({
      email: "alice@corp.com",
      cookieRegion: null,
      fetchRegionMap: mapOf(MAP),
      probe,
    });
    expect(r.outcome).toBe("multiple");
    if (r.outcome === "multiple") {
      expect(r.regions.map((x) => x.region).sort()).toEqual(["eu", "us"]);
      expect(r.regions.find((x) => x.region === "eu")?.label).toBe("Europe");
    }
  });

  it("reports none when every region answered and no account exists", async () => {
    const { probe } = probeHitting();
    const r = await resolveRegion({
      email: "ghost@nowhere.com",
      cookieRegion: null,
      fetchRegionMap: mapOf(MAP),
      probe,
    });
    expect(r).toEqual({ outcome: "none" });
  });

  it("returns error (not a false none) when no hit AND a region was unreachable", async () => {
    const probe = async (apiUrl: string) => {
      if (apiUrl === "https://api-apac.useatlas.dev") throw new Error("network");
      return false;
    };
    const r = await resolveRegion({
      email: "alice@corp.com",
      cookieRegion: null,
      fetchRegionMap: mapOf(MAP),
      probe,
    });
    expect(r.outcome).toBe("error");
  });

  it("still routes to a confirmed hit even if another region errored", async () => {
    const probe = async (apiUrl: string) => {
      if (apiUrl === "https://api-apac.useatlas.dev") throw new Error("network");
      return apiUrl === "https://api-eu.useatlas.dev";
    };
    const r = await resolveRegion({
      email: "alice@corp.com",
      cookieRegion: null,
      fetchRegionMap: mapOf(MAP),
      probe,
    });
    expect(r).toEqual({ outcome: "single", region: "eu", apiUrl: "https://api-eu.useatlas.dev" });
  });

  it("returns error when the region map cannot be fetched", async () => {
    const r = await resolveRegion({
      email: "a@b.co",
      cookieRegion: null,
      fetchRegionMap: () => Promise.reject(new Error("down")),
      probe: async () => true,
    });
    expect(r.outcome).toBe("error");
  });
});
