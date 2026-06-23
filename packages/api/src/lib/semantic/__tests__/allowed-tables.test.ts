/**
 * Unit tests for `resolveAllowedTables` — the shared SSOT that returns the
 * mode-aware, group-scoped whitelist set the SQL pipeline enforces.
 *
 * Both the schema diff and `GET /api/v1/tables` read through this, so its
 * branching (org + internal DB → DB whitelist; otherwise → file whitelist;
 * fail-closed on load error) is what keeps "advertised == enforced" honest.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const mockHasInternalDB: Mock<() => boolean> = mock(() => false);
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
}));

const mockLoadOrgWhitelist: Mock<(orgId: string, mode?: string) => Promise<Map<string, Set<string>>>> =
  mock(async () => new Map());
const mockGetOrgWhitelistedTables: Mock<(orgId: string, connectionId?: string, mode?: string) => Set<string>> =
  mock(() => new Set(["org_table"]));
const mockGetWhitelistedTables: Mock<(connectionId?: string) => Set<string>> =
  mock(() => new Set(["file_table"]));

mock.module("../whitelist", () => ({
  loadOrgWhitelist: mockLoadOrgWhitelist,
  getOrgWhitelistedTables: mockGetOrgWhitelistedTables,
  getWhitelistedTables: mockGetWhitelistedTables,
}));

const { resolveAllowedTables } = await import("../allowed-tables");

describe("resolveAllowedTables", () => {
  beforeEach(() => {
    mockHasInternalDB.mockReset();
    mockHasInternalDB.mockReturnValue(false);
    mockLoadOrgWhitelist.mockReset();
    mockLoadOrgWhitelist.mockResolvedValue(new Map());
    mockGetOrgWhitelistedTables.mockReset();
    mockGetOrgWhitelistedTables.mockReturnValue(new Set(["org_table"]));
    mockGetWhitelistedTables.mockReset();
    mockGetWhitelistedTables.mockReturnValue(new Set(["file_table"]));
  });

  it("org + internal DB: loads and returns the org whitelist, threading raw mode", async () => {
    mockHasInternalDB.mockReturnValue(true);
    const result = await resolveAllowedTables("ch", { orgId: "org_1", atlasMode: "developer" });
    expect([...result]).toEqual(["org_table"]);
    expect(mockLoadOrgWhitelist).toHaveBeenCalledWith("org_1", "developer");
    expect(mockGetOrgWhitelistedTables).toHaveBeenCalledWith("org_1", "ch", "developer");
    expect(mockGetWhitelistedTables).not.toHaveBeenCalled();
  });

  it("org present but no internal DB: falls back to the file whitelist", async () => {
    mockHasInternalDB.mockReturnValue(false);
    const result = await resolveAllowedTables("ch", { orgId: "org_1", atlasMode: "published" });
    expect([...result]).toEqual(["file_table"]);
    expect(mockGetWhitelistedTables).toHaveBeenCalledWith("ch");
    expect(mockLoadOrgWhitelist).not.toHaveBeenCalled();
  });

  it("no org (self-hosted): uses the file whitelist", async () => {
    const result = await resolveAllowedTables("default", {});
    expect([...result]).toEqual(["file_table"]);
    expect(mockGetWhitelistedTables).toHaveBeenCalledWith("default");
  });

  it("passes a missing atlasMode through as undefined (matching validateSQL)", async () => {
    mockHasInternalDB.mockReturnValue(true);
    await resolveAllowedTables("ch", { orgId: "org_1" });
    expect(mockLoadOrgWhitelist).toHaveBeenCalledWith("org_1", undefined);
    expect(mockGetOrgWhitelistedTables).toHaveBeenCalledWith("org_1", "ch", undefined);
  });

  it("fails closed to an empty set when the org whitelist load throws", async () => {
    mockHasInternalDB.mockReturnValue(true);
    mockLoadOrgWhitelist.mockRejectedValue(new Error("db down"));
    const result = await resolveAllowedTables("ch", { orgId: "org_1", atlasMode: "developer" });
    expect([...result]).toEqual([]);
    // Must NOT widen to the file whitelist on an org-load failure.
    expect(mockGetWhitelistedTables).not.toHaveBeenCalled();
  });
});
