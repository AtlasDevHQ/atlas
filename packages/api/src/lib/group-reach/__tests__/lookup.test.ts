/**
 * Behavioral tests for the impure visible-groups lookup
 * (ADR-0022, slice (a) #3893). Mocks the two data inputs — the content-mode
 * filtered whitelist map (`loadOrgWhitelist`) and group membership
 * (`listConnectionGroupMembers`) — and asserts the derived `VisibleGroup[]`:
 * member connections fold into their canonical group, group-of-one
 * standalone datasources stand alone, empty (content-mode invisible)
 * whitelists are excluded, and ordering is deterministic.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mutable fixtures the mocks read each call.
let whitelistMap: Map<string, Set<string>>;
let memberRows: ReadonlyArray<{ group_id: string; id: string }>;
let whitelistThrows = false;
let membersThrow = false;

mock.module("@atlas/api/lib/semantic", () => ({
  loadOrgWhitelist: async () => {
    if (whitelistThrows) throw new Error("whitelist load failed");
    return whitelistMap;
  },
  getOrgWhitelistedTables: () => new Set<string>(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set<string>(),
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/semantic/entities", () => ({
  listConnectionGroupMembers: async () => {
    if (membersThrow) throw new Error("members load failed");
    return memberRows;
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { loadVisibleGroups } = await import("../lookup");

describe("loadVisibleGroups", () => {
  beforeEach(() => {
    whitelistThrows = false;
    membersThrow = false;
    whitelistMap = new Map();
    memberRows = [];
  });

  it("returns [] when no orgId (self-hosted / no workspace)", async () => {
    const groups = await loadVisibleGroups(undefined, "published");
    expect(groups).toEqual([]);
  });

  it("folds member connections into their canonical group, group-of-one stands alone", async () => {
    whitelistMap = new Map([
      ["postgres", new Set(["orders", "customers"])], // explicit group key
      ["pg-us", new Set(["orders", "customers"])], // member
      ["pg-eu", new Set(["orders", "customers"])], // member
      ["clickhouse", new Set(["events"])], // group-of-one
    ]);
    memberRows = [
      { group_id: "postgres", id: "pg-us" },
      { group_id: "postgres", id: "pg-eu" },
    ];

    const groups = await loadVisibleGroups("org-1", "published");

    // Deterministic ascending id order; members folded; no duplicate groups.
    expect(groups.map((g) => g.id)).toEqual(["clickhouse", "postgres"]);

    const pg = groups.find((g) => g.id === "postgres");
    expect(pg?.members).toEqual(["pg-eu", "pg-us"]); // sorted, members not separate groups
    expect(pg?.primary).toBe("pg-eu");

    const ch = groups.find((g) => g.id === "clickhouse");
    expect(ch?.members).toEqual(["clickhouse"]);
    expect(ch?.primary).toBe("clickhouse");
  });

  it("excludes groups with an empty whitelist (content-mode / draft invisible)", async () => {
    whitelistMap = new Map([
      ["live", new Set(["orders"])],
      ["draft", new Set<string>()], // no published entities in this mode → invisible
    ]);
    memberRows = [];

    const groups = await loadVisibleGroups("org-1", "published");
    expect(groups.map((g) => g.id)).toEqual(["live"]);
  });

  it("returns [] when the whitelist load fails (degrades, never throws)", async () => {
    whitelistThrows = true;
    const groups = await loadVisibleGroups("org-1", "published");
    expect(groups).toEqual([]);
  });

  it("still resolves groups when membership lookup fails (each visible key its own group)", async () => {
    whitelistMap = new Map([
      ["postgres", new Set(["orders"])],
      ["pg-us", new Set(["orders"])],
    ]);
    memberRows = [{ group_id: "postgres", id: "pg-us" }];
    membersThrow = true; // membership unavailable → no folding

    const groups = await loadVisibleGroups("org-1", "published");
    // Without membership we cannot fold pg-us into postgres; both surface as
    // their own group rather than the whole workspace going dark.
    expect(groups.map((g) => g.id)).toEqual(["pg-us", "postgres"]);
  });
});
