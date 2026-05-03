/**
 * Unit tests for `validateStoredPluginConfigs` (#1988 C8).
 *
 * The function reads `workspace_plugins` rows and checks each stored
 * config against the matching plugin's current `getConfigSchema()`.
 * Tests mock the internal-DB module so we control the row set without
 * spinning up Postgres, and inject a `pluginRegistry` shim so we can
 * vary the schema per test.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ConfigSchemaField, PluginLike } from "../registry";

// Internal DB mock — both `hasInternalDB` (gate) and `internalQuery`
// (data source) are mocked. The query mock returns a configurable row
// set keyed by SQL pattern.
let mockHasInternalDB = true;
let mockRows: Record<string, unknown>[] = [];
let mockQueryError: Error | null = null;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => {
    if (mockQueryError) throw mockQueryError;
    return mockRows;
  },
}));

const { validateStoredPluginConfigs } = await import("../validation");

interface PluginRegistryShim {
  getAll(): readonly PluginLike[];
  get(id: string): PluginLike | undefined;
}

function makeRegistry(plugins: Record<string, PluginLike>): PluginRegistryShim {
  return {
    getAll: () => Object.values(plugins),
    get: (id: string) => plugins[id],
  };
}

function makePlugin(id: string, schema: ConfigSchemaField[]): PluginLike {
  return {
    id,
    types: ["context"],
    version: "1.0.0",
    getConfigSchema: () => schema,
  };
}

beforeEach(() => {
  mockHasInternalDB = true;
  mockRows = [];
  mockQueryError = null;
});

describe("validateStoredPluginConfigs", () => {
  test("returns empty when no internal DB is available", async () => {
    mockHasInternalDB = false;
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({}),
    });
    expect(result.issues).toEqual([]);
  });

  test("returns empty when no workspace_plugins rows exist", async () => {
    mockRows = [];
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [{ key: "token", type: "string", required: true }]),
      }),
    });
    expect(result.issues).toEqual([]);
  });

  test("treats 42P01 / table missing as no-op (skips with debug log)", async () => {
    // The C9 boot guard catches "table missing post-migration" via the
    // migration path — this function intentionally does not second-guess
    // it. Matches the same `42P01` fallback pattern in `lib/settings.ts`.
    mockQueryError = Object.assign(new Error('relation "workspace_plugins" does not exist'), {
      code: "42P01",
    });
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({}),
    });
    expect(result.issues).toEqual([]);
  });

  test("flags missing required fields", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "slack",
      config: { otherKey: "value" },
    }];
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [
          { key: "token", type: "string", required: true },
        ]),
      }),
    });
    // Two issues expected: missing required `token` AND extra
    // (undeclared) `otherKey`. Both are real drift signals.
    expect(result.issues.length).toBe(2);
    const missing = result.issues.find((i) => i.reason.includes("required"));
    expect(missing).toBeDefined();
    expect(missing?.installationId).toBe("inst-1");
    expect(missing?.workspaceId).toBe("ws-1");
    expect(missing?.catalogId).toBe("slack");
  });

  test("treats null/empty-string values as missing for required fields", async () => {
    mockRows = [
      {
        id: "inst-null",
        workspace_id: "ws",
        catalog_id: "slack",
        config: { token: null },
      },
      {
        id: "inst-empty",
        workspace_id: "ws",
        catalog_id: "slack",
        config: { token: "" },
      },
    ];
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [{ key: "token", type: "string", required: true }]),
      }),
    });
    expect(result.issues.length).toBe(2);
    expect(result.issues.every((i) => i.reason.includes("required"))).toBe(true);
  });

  test("flags type drift (number stored where string declared)", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "slack",
      config: { token: 42 },
    }];
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [{ key: "token", type: "string" }]),
      }),
    });
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].reason).toContain("expected string");
    expect(result.issues[0].reason).toContain("got number");
  });

  test("treats select fields as strings (admin UI persists chosen option)", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "p",
      config: { mode: "fast" },
    }];
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        p: makePlugin("p", [{ key: "mode", type: "select", options: ["fast", "slow"] }]),
      }),
    });
    expect(result.issues).toEqual([]);
  });

  test("flags stored keys not declared by current schema (renamed/removed)", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "slack",
      config: { token: "v", deprecatedField: "stale" },
    }];
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [{ key: "token", type: "string" }]),
      }),
    });
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].reason).toContain("deprecatedField");
    expect(result.issues[0].reason).toContain("renamed or removed");
  });

  test("ignores rows whose plugin is no longer registered", async () => {
    // Uninstalled plugin still has rows in workspace_plugins until the
    // admin UI cleans them up — not our concern here.
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "uninstalled",
      config: {},
    }];
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({}),
    });
    expect(result.issues).toEqual([]);
  });

  test("ignores plugins without a configSchema", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "schemaless",
      config: { anything: "goes" },
    }];
    const result = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        schemaless: { id: "schemaless", types: ["context"], version: "1.0.0" } as PluginLike,
      }),
    });
    expect(result.issues).toEqual([]);
  });
});
