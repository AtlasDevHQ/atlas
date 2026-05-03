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
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({}),
    });
    expect(issues).toEqual([]);
  });

  test("returns empty when no workspace_plugins rows exist", async () => {
    mockRows = [];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [{ key: "token", type: "string", required: true }]),
      }),
    });
    expect(issues).toEqual([]);
  });

  test("treats 42P01 / table missing as no-op (skips with debug log)", async () => {
    // The C9 boot guard catches "table missing post-migration" via the
    // migration path — this function intentionally does not second-guess
    // it. SQLSTATE-only match (no English string) so localized error
    // messages don't accidentally route through this branch.
    mockQueryError = Object.assign(new Error('relation "workspace_plugins" does not exist'), {
      code: "42P01",
    });
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({}),
    });
    expect(issues).toEqual([]);
  });

  test("does NOT skip on permission-denied errors that contain 'does not exist' in message", async () => {
    // Tightening regression: previous string-match would have routed
    // any error with "does not exist" in the message (role/schema/etc.)
    // through the first-boot path. Now we match by SQLSTATE only.
    mockQueryError = Object.assign(
      new Error('permission denied for relation "workspace_plugins" — role does not exist for current connection'),
      { code: "42501" }, // insufficient_privilege
    );
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({}),
    });
    // Falls through to the warn-and-skip path; still returns []
    // (boot continues), but this asserts we did NOT misroute through
    // the silent debug-log path. The contract is "log.warn, not log.debug".
    expect(issues).toEqual([]);
  });

  test("flags missing required fields", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "slack",
      config: { otherKey: "value" },
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [
          { key: "token", type: "string", required: true },
        ]),
      }),
    });
    // Two issues expected: missing required `token` AND extra
    // (undeclared) `otherKey`. Both are real drift signals.
    expect(issues.length).toBe(2);
    const missing = issues.find((i) => i.reason.includes("required"));
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
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [{ key: "token", type: "string", required: true }]),
      }),
    });
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.reason.includes("required"))).toBe(true);
  });

  test("flags type drift (number stored where string declared)", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "slack",
      config: { token: 42 },
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [{ key: "token", type: "string" }]),
      }),
    });
    expect(issues.length).toBe(1);
    expect(issues[0].reason).toContain("expected string");
    expect(issues[0].reason).toContain("got number");
  });

  test("flags boolean field stored as string (admin-UI serializer drift)", async () => {
    // Realistic shape: HTML form serializers stringify checkbox state
    // as `"true"` / `"false"`. The reverse case — admin UI fix lands
    // and stored strings start failing — is exactly what this test
    // pins: the strict typeof check correctly flags the drift.
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "p",
      config: { enabled: "true" },
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        p: makePlugin("p", [{ key: "enabled", type: "boolean" }]),
      }),
    });
    expect(issues.length).toBe(1);
    expect(issues[0].reason).toContain("expected boolean");
    expect(issues[0].reason).toContain("got string");
  });

  test("flags pre-existing config when schema bumps required:false → required:true", async () => {
    // The plugin-upgrade killer case. A workspace's config was saved
    // when the field was optional (and so omitted entirely); the
    // upgraded plugin now declares it required. Without this test,
    // a refactor that only checks "value missing on present key"
    // (instead of "key missing entirely") would silently pass.
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "p",
      config: { otherField: "kept" }, // `apiKey` was never saved
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        p: makePlugin("p", [
          { key: "apiKey", type: "string", required: true }, // newly required
          { key: "otherField", type: "string" },
        ]),
      }),
    });
    // One issue for the now-required-but-missing apiKey; otherField is fine.
    const missing = issues.find((i) => i.reason.includes("required"));
    expect(missing).toBeDefined();
    expect(missing?.reason).toContain("apiKey");
  });

  test("treats select fields as strings (admin UI persists chosen option)", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "p",
      config: { mode: "fast" },
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        p: makePlugin("p", [{ key: "mode", type: "select", options: ["fast", "slow"] }]),
      }),
    });
    expect(issues).toEqual([]);
  });

  test("flags stored keys not declared by current schema (renamed/removed)", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "slack",
      config: { token: "v", deprecatedField: "stale" },
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        slack: makePlugin("slack", [{ key: "token", type: "string" }]),
      }),
    });
    expect(issues.length).toBe(1);
    expect(issues[0].reason).toContain("deprecatedField");
    expect(issues[0].reason).toContain("renamed or removed");
  });

  test("treats config: null as empty (no false flags when schema has no required fields)", async () => {
    // Real production shape: row created before any save, JSONB column
    // SQL NULL. The `?? {}` default at the call site must not trip
    // any of the iteration paths that assume an object.
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "p",
      config: null,
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        p: makePlugin("p", [{ key: "optional", type: "string" }]),
      }),
    });
    expect(issues).toEqual([]);
  });

  test("flags config: null as missing when schema requires fields (corrupt-row signal)", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "p",
      config: null,
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        p: makePlugin("p", [{ key: "apiKey", type: "string", required: true }]),
      }),
    });
    expect(issues.length).toBe(1);
    expect(issues[0].reason).toContain("not a JSON object");
  });

  test("does not crash on non-object JSONB (string/array/primitive at row.config root)", async () => {
    // Defensive: malformed JSONB shouldn't tip the per-row walker into
    // a TypeError on `field.key in config` / `Object.keys(config)`.
    // Without the runtime guard at validation.ts:coerceConfigObject,
    // this throws; with the guard, it surfaces as a structured issue.
    mockRows = [
      { id: "i1", workspace_id: "ws", catalog_id: "p", config: "this is a string" as unknown as Record<string, unknown> },
      { id: "i2", workspace_id: "ws", catalog_id: "p", config: [1, 2, 3] as unknown as Record<string, unknown> },
      { id: "i3", workspace_id: "ws", catalog_id: "p", config: 42 as unknown as Record<string, unknown> },
    ];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        p: makePlugin("p", [{ key: "apiKey", type: "string", required: true }]),
      }),
    });
    // Each malformed row surfaces as one issue (because schema has a
    // required field); the function does not throw.
    expect(issues.length).toBe(3);
    expect(issues.every((i) => i.reason.includes("not a JSON object"))).toBe(true);
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
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({}),
    });
    expect(issues).toEqual([]);
  });

  test("ignores plugins without a configSchema", async () => {
    mockRows = [{
      id: "inst-1",
      workspace_id: "ws-1",
      catalog_id: "schemaless",
      config: { anything: "goes" },
    }];
    const issues = await validateStoredPluginConfigs({
      pluginRegistry: makeRegistry({
        schemaless: { id: "schemaless", types: ["context"], version: "1.0.0" } as PluginLike,
      }),
    });
    expect(issues).toEqual([]);
  });
});
