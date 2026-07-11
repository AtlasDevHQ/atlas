/**
 * #4515 — unit test for `resolveConversationDialectSpecialists`, the reach →
 * dbType → composition bridge that feeds the dialect-specialist section into the
 * conversation. The pure composition is covered in dialect-specialist.test.ts
 * and the end-to-end prompt placement in agent-dialect-specialist-seam.test.ts;
 * this pins the reach-resolution branch the seam test's no-orgId path can't
 * reach: workspace-present group→engine mapping, the fail-closed empty-reach and
 * fail-closed catch paths.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { ConnectionMetadata } from "../db/connection";
import type { VisibleGroup } from "../group-reach";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mutable fixtures ---
let mockEntries: ConnectionMetadata[] = [];
let mockReachable: readonly VisibleGroup[] = [];
let reachThrows = false;

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      describe: () => mockEntries.map((e) => ({ ...e })),
    },
  }),
);

void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

void mock.module("@atlas/api/lib/plugins/tools", () => ({
  getContextFragments: () => [],
  getDialectHints: () => [],
  pluginDialectModules: () => [],
  setContextFragments: () => {},
  setDialectHints: () => {},
  setPluginTools: () => {},
  getPluginTools: () => undefined,
}));

void mock.module("@atlas/api/lib/group-reach/resolve", () => ({
  resolveReachableGroups: async () => {
    if (reachThrows) throw new Error("whitelist scan failed");
    return { reachableGroups: mockReachable, reason: "all-visible", warnings: [] };
  },
}));

const { resolveConversationDialectSpecialists } = await import("@atlas/api/lib/agent");

function group(id: string, members: string[]): VisibleGroup {
  return { id, members, primary: members[0] ?? id };
}

describe("resolveConversationDialectSpecialists — reach branch (#4515)", () => {
  beforeEach(() => {
    mockEntries = [];
    mockReachable = [];
    reachThrows = false;
  });

  test("workspace present: maps each reachable group to its primary connection's engine, attributed per group", async () => {
    mockEntries = [
      { id: "us", dbType: "postgres" },
      { id: "eu", dbType: "clickhouse" },
    ];
    mockReachable = [group("us", ["us"]), group("eu", ["eu"])];

    const out = await resolveConversationDialectSpecialists("org-1", "published", { kind: "all" });
    expect(out).toContain("## SQL Dialect: PostgreSQL — group `us`");
    expect(out).toContain("## SQL Dialect: ClickHouse — group `eu`");
  });

  test("workspace present: falls back to a member engine when the primary is unregistered", async () => {
    mockEntries = [{ id: "warehouse-replica", dbType: "mysql" }];
    // primary `warehouse` has no registered connection; a member does.
    mockReachable = [group("warehouse", ["warehouse", "warehouse-replica"])];

    const out = await resolveConversationDialectSpecialists("org-1", "published", { kind: "all" });
    // Single reachable group ⇒ the module resolves (via the member-engine
    // fallback) but carries no per-group attribution suffix.
    expect(out).toContain("## SQL Dialect: MySQL");
    expect(out).not.toContain("— group");
  });

  test("workspace present, empty reachable set: composes nothing (fails closed like the catalog)", async () => {
    mockEntries = [{ id: "us", dbType: "postgres" }];
    mockReachable = [];

    const out = await resolveConversationDialectSpecialists("org-1", "published", { kind: "all" });
    expect(out).toBe("");
  });

  test("workspace present, reach resolution throws: composes nothing (fail closed), never fans out to all connections", async () => {
    mockEntries = [
      { id: "us", dbType: "postgres" },
      { id: "eu", dbType: "clickhouse" },
    ];
    reachThrows = true;

    const out = await resolveConversationDialectSpecialists("org-1", "published", { kind: "all" });
    expect(out).toBe("");
  });

  test("no workspace: each visible connection stands as its own group-of-one", async () => {
    mockEntries = [{ id: "default", dbType: "mysql" }];

    const out = await resolveConversationDialectSpecialists(undefined, undefined, { kind: "all" });
    expect(out).toContain("## SQL Dialect: MySQL");
  });
});
