/**
 * Tests for the F-42 plugin-config backfill (`backfill-plugin-config.ts`).
 *
 * The script runs post-migration 0037 to encrypt pre-existing
 * `plugin_settings.config` and `workspace_plugins.config` rows. The three
 * invariants we pin:
 *
 *   1. A row with plaintext secret: true values is rewritten with
 *      `enc:v1:` ciphertext after the first run.
 *   2. The backfill is idempotent — a second run performs zero UPDATEs
 *      because every row's secrets are already ciphertext (the
 *      `allSecretsAlreadyEncrypted` short-circuit).
 *   3. The workspace_plugins walker uses the catalog's `config_schema`
 *      when known and fails-closed (encrypts every non-empty string)
 *      when the schema is missing or malformed — matches the route-
 *      level policy exactly.
 *
 * The script under test talks to `pg.Pool` through a thin narrowed
 * interface, so we drive it with a hand-rolled mock rather than spinning
 * up a live database. This keeps the test deterministic and lets us
 * inspect the exact `UPDATE` params the backfill produced.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  backfillPluginSettings,
  backfillWorkspacePlugins,
} from "../backfill-plugin-config";
import { _resetEncryptionKeyCache } from "../internal";
import { isEncryptedSecret } from "@atlas/api/lib/plugins/secrets";
import { decryptSecret } from "../secret-encryption";

// ---------------------------------------------------------------------------
// Test harness — narrowed pg Pool mock.
// ---------------------------------------------------------------------------

interface Captured {
  sql: string;
  params: unknown[];
}

function makeMockPool(rowsBySql: Map<string, Array<Record<string, unknown>>>) {
  const captured: Captured[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        captured.push({ sql, params });
        for (const [pattern, rows] of rowsBySql) {
          if (sql.includes(pattern)) return { rows };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  };
  return { pool, captured };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfillPluginSettings (F-42)", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ATLAS_ENCRYPTION_KEY = "atlas-test-backfill-key";
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    _resetEncryptionKeyCache();
  });

  it("encrypts every non-empty string value on first run (no-schema fail-closed mode)", async () => {
    // plugin_settings has no catalog JOIN so the backfill runs without a
    // schema — fail-closed: every string gets encrypted. Non-string values
    // (numbers, booleans, null) pass through.
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["SELECT plugin_id, config FROM plugin_settings", [
        { plugin_id: "bigquery", config: { apiKey: "sk-live-1", region: "us-east-1", port: 5432, debug: true } },
      ]],
    ]);
    const { pool, captured } = makeMockPool(rowsBySql);

    const result = await backfillPluginSettings(pool);

    expect(result).toEqual({ table: "plugin_settings", scanned: 1, updated: 1, alreadyEncrypted: 0, skipped: 0 });

    const update = captured.find((c) => c.sql.includes("UPDATE plugin_settings SET config"));
    expect(update).toBeDefined();
    const persisted = JSON.parse(update!.params[0] as string) as Record<string, unknown>;
    expect(isEncryptedSecret(persisted.apiKey)).toBe(true);
    expect(decryptSecret(persisted.apiKey as string)).toBe("sk-live-1");
    expect(isEncryptedSecret(persisted.region)).toBe(true);
    expect(decryptSecret(persisted.region as string)).toBe("us-east-1");
    expect(persisted.port).toBe(5432);
    expect(persisted.debug).toBe(true);
  });

  it("is idempotent: a second run with already-encrypted rows does zero UPDATEs", async () => {
    // Simulate the "second run" state: every string value in the row
    // already begins with enc:v1:. allSecretsAlreadyEncrypted short-
    // circuits before the encrypt walker, so no UPDATE happens.
    const alreadyEncrypted = "enc:v1:aW5pdHZlY3Rvcg==:YXV0aHRhZ2F1dGh0YWc=:Y2lwaGVydGV4dA==";
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["SELECT plugin_id, config FROM plugin_settings", [
        { plugin_id: "bigquery", config: { apiKey: alreadyEncrypted, port: 5432 } },
      ]],
    ]);
    const { pool, captured } = makeMockPool(rowsBySql);

    const result = await backfillPluginSettings(pool);

    expect(result).toEqual({ table: "plugin_settings", scanned: 1, updated: 0, alreadyEncrypted: 1, skipped: 0 });
    const update = captured.find((c) => c.sql.includes("UPDATE plugin_settings SET config"));
    expect(update).toBeUndefined();
  });

  it("skips rows with non-object config (defensive — malformed JSONB)", async () => {
    // A row with `config = null` was filtered in SQL; `config = ["array"]`
    // wasn't. Non-object values are skipped rather than wiped.
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["SELECT plugin_id, config FROM plugin_settings", [
        { plugin_id: "broken", config: [1, 2, 3] },
      ]],
    ]);
    const { pool, captured } = makeMockPool(rowsBySql);

    const result = await backfillPluginSettings(pool);

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    const update = captured.find((c) => c.sql.includes("UPDATE plugin_settings SET config"));
    expect(update).toBeUndefined();
  });

  it("parses a JSON-stringified config (some pg drivers return strings)", async () => {
    // Driver-shape tolerance: if the JSONB parser returned a raw string
    // instead of an object, asConfigRecord parses it before walking.
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["SELECT plugin_id, config FROM plugin_settings", [
        { plugin_id: "bigquery", config: JSON.stringify({ apiKey: "sk-live-1" }) },
      ]],
    ]);
    const { pool, captured } = makeMockPool(rowsBySql);

    const result = await backfillPluginSettings(pool);

    expect(result.updated).toBe(1);
    const update = captured.find((c) => c.sql.includes("UPDATE plugin_settings SET config"));
    const persisted = JSON.parse(update!.params[0] as string) as Record<string, unknown>;
    expect(decryptSecret(persisted.apiKey as string)).toBe("sk-live-1");
  });

  it("rolls back on mid-batch UPDATE failure", async () => {
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["SELECT plugin_id, config FROM plugin_settings", [
        { plugin_id: "bigquery", config: { apiKey: "sk-live-1" } },
      ]],
    ]);
    // Custom pool that throws on UPDATE to verify ROLLBACK is issued.
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string, params: unknown[] = []) => {
          captured.push({ sql, params });
          if (sql.startsWith("UPDATE")) throw new Error("simulated update failure");
          for (const [pattern, rows] of rowsBySql) {
            if (sql.includes(pattern)) return { rows };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    await expect(backfillPluginSettings(pool)).rejects.toThrow("simulated update failure");
    expect(captured.some((c) => c.sql === "BEGIN")).toBe(true);
    expect(captured.some((c) => c.sql === "ROLLBACK")).toBe(true);
    expect(captured.some((c) => c.sql === "COMMIT")).toBe(false);
  });
});

describe("backfillWorkspacePlugins (F-42)", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ATLAS_ENCRYPTION_KEY = "atlas-test-backfill-key";
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    _resetEncryptionKeyCache();
  });

  it("encrypts only `secret: true` fields when the catalog schema is known", async () => {
    // The workspace path joins plugin_catalog and gets the real schema —
    // non-secret fields (region) stay plaintext, which is the contract
    // DB ops relies on for the final shape.
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["FROM workspace_plugins wp", [
        {
          id: "inst-1",
          config: { apiKey: "sk-live-1", region: "us-east-1" },
          config_schema: [
            { key: "apiKey", type: "string", secret: true },
            { key: "region", type: "string" },
          ],
          plugin_slug: "bigquery",
        },
      ]],
    ]);
    const { pool, captured } = makeMockPool(rowsBySql);

    const result = await backfillWorkspacePlugins(pool);

    expect(result.updated).toBe(1);
    const update = captured.find((c) => c.sql.includes("UPDATE workspace_plugins SET config"));
    expect(update).toBeDefined();
    const persisted = JSON.parse(update!.params[0] as string) as Record<string, unknown>;
    expect(isEncryptedSecret(persisted.apiKey)).toBe(true);
    expect(decryptSecret(persisted.apiKey as string)).toBe("sk-live-1");
    expect(persisted.region).toBe("us-east-1"); // non-secret stays plaintext
  });

  it("fail-closes on missing/corrupt catalog schema by encrypting every string", async () => {
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["FROM workspace_plugins wp", [
        {
          id: "inst-2",
          config: { apiKey: "sk-live", region: "us" },
          config_schema: "not-an-array", // corrupt
          plugin_slug: "unknown",
        },
      ]],
    ]);
    const { pool, captured } = makeMockPool(rowsBySql);

    const result = await backfillWorkspacePlugins(pool);

    expect(result.updated).toBe(1);
    const update = captured.find((c) => c.sql.includes("UPDATE workspace_plugins SET config"));
    const persisted = JSON.parse(update!.params[0] as string) as Record<string, unknown>;
    expect(isEncryptedSecret(persisted.apiKey)).toBe(true);
    expect(isEncryptedSecret(persisted.region)).toBe(true);
  });

  it("is idempotent: second run with already-encrypted secrets performs zero UPDATEs", async () => {
    const alreadyEncrypted = "enc:v1:aW5pdHZlY3Rvcg==:YXV0aHRhZw==:Y2lwaGVydGV4dA==";
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["FROM workspace_plugins wp", [
        {
          id: "inst-3",
          config: { apiKey: alreadyEncrypted, region: "us-east-1" }, // non-secret region passes shouldEncryptStringValue but allSecretsAlreadyEncrypted sees a plaintext string and re-runs
          config_schema: [
            { key: "apiKey", type: "string", secret: true },
            { key: "region", type: "string" },
          ],
          plugin_slug: "bigquery",
        },
      ]],
    ]);
    const { pool, captured } = makeMockPool(rowsBySql);

    // First config has a plaintext non-secret ("region" = "us-east-1"),
    // so allSecretsAlreadyEncrypted returns false. Under the known
    // schema, only apiKey gets touched — it's already encrypted so
    // idempotent. The UPDATE still runs once (we walked for non-secret
    // changes), but a second run on the resulting row should be a no-op.
    await backfillWorkspacePlugins(pool);
    captured.length = 0;

    // Simulate a row where every string is already encrypted (would
    // happen after a corrupt-schema fail-closed backfill).
    const secondRun = new Map<string, Array<Record<string, unknown>>>([
      ["FROM workspace_plugins wp", [
        {
          id: "inst-3",
          config: { apiKey: alreadyEncrypted, region: alreadyEncrypted },
          config_schema: [{ key: "apiKey", type: "string", secret: true }],
          plugin_slug: "bigquery",
        },
      ]],
    ]);
    const second = makeMockPool(secondRun);

    const result = await backfillWorkspacePlugins(second.pool);
    expect(result).toEqual({ table: "workspace_plugins", scanned: 1, updated: 0, alreadyEncrypted: 1, skipped: 0 });
    const update = second.captured.find((c) => c.sql.includes("UPDATE workspace_plugins SET config"));
    expect(update).toBeUndefined();
  });

  it("handles a plugin_catalog row with config_schema = null (no schema declared)", async () => {
    // A plugin that declares no schema has nothing to encrypt — every
    // field is "operational". The absent-schema branch of
    // encryptSecretFields returns the config unchanged. We still UPDATE
    // because the row didn't satisfy allSecretsAlreadyEncrypted's
    // "all strings encrypted" check, but the persisted shape is
    // identical — nothing was ever secret. This is acceptable over-work
    // for the one-time backfill.
    const rowsBySql = new Map<string, Array<Record<string, unknown>>>([
      ["FROM workspace_plugins wp", [
        {
          id: "inst-4",
          config: { someField: "value" },
          config_schema: null,
          plugin_slug: "schemaless",
        },
      ]],
    ]);
    const { pool, captured } = makeMockPool(rowsBySql);

    await backfillWorkspacePlugins(pool);
    const update = captured.find((c) => c.sql.includes("UPDATE workspace_plugins SET config"));
    const persisted = JSON.parse(update!.params[0] as string) as Record<string, unknown>;
    // Nothing encrypted because the schema is absent.
    expect(persisted.someField).toBe("value");
  });
});
