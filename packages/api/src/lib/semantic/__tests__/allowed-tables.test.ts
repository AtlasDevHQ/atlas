/**
 * Unit tests for `resolveAllowedTables` — the shared SSOT that returns the
 * mode-aware, group-scoped whitelist set the SQL pipeline enforces.
 *
 * Both the schema diff and `GET /api/v1/tables` read through this, so its
 * branching (org + internal DB → DB whitelist; otherwise → file whitelist;
 * fail-closed on load error) is what keeps "advertised == enforced" honest.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const mockHasInternalDB: Mock<() => boolean> = mock(() => false);
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
}));

const mockLoadOrgWhitelist: Mock<(orgId: string, mode?: string) => Promise<Map<string, Set<string>>>> =
  mock(async () => new Map());
const mockGetOrgWhitelistedTables: Mock<(orgId: string, connectionId?: string, mode?: string) => Set<string>> =
  mock(() => new Set(["org_table"]));
const mockGetWhitelistedTables: Mock<(connectionId?: string) => Set<string>> =
  mock(() => new Set(["file_table"]));

void mock.module("../whitelist", () => ({
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

  it("org, no internal DB, default (empty): takes the org branch like validateSQL (no file widening)", async () => {
    // validateSQL branches on `orgId` alone; with no DB the org whitelist is
    // empty (deny-all). The enforcement-parity default MUST do the same so
    // /tables never advertises on-disk tables executeSQL would reject (#3898).
    mockHasInternalDB.mockReturnValue(false);
    mockGetOrgWhitelistedTables.mockReturnValue(new Set());
    const result = await resolveAllowedTables("ch", { orgId: "org_1", atlasMode: "published" });
    expect([...result]).toEqual([]);
    expect(mockLoadOrgWhitelist).toHaveBeenCalledWith("org_1", "published");
    expect(mockGetWhitelistedTables).not.toHaveBeenCalled();
  });

  it("org, no internal DB, onMissingOrgDB=file: opts into the file whitelist (diff back-compat)", async () => {
    mockHasInternalDB.mockReturnValue(false);
    const result = await resolveAllowedTables("ch", {
      orgId: "org_1",
      atlasMode: "published",
      onMissingOrgDB: "file",
    });
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
