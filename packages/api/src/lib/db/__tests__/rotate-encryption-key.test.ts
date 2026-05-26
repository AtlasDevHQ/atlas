/**
 * Tests for the F-47 re-encryption script.
 *
 * The script walks every encrypted column, decrypts under whichever
 * keyset entry the ciphertext prefix names, re-encrypts with the
 * active key, and stamps the companion `<col>_key_version` column.
 * These tests pin the per-row rotate contract and the idempotence
 * guard that makes the script safe to run repeatedly.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  rotateJsonbSelectiveField,
  rotateTable,
  UnprefixedSecretError,
} from "../../../../scripts/rotate-encryption-key";
import { _resetEncryptionKeyCache, MANAGED_AUTH_MIGRATIONS } from "../internal";
import { runMigrations } from "../migrate";
import {
  encryptSecret,
  decryptSecret,
} from "../secret-encryption";

function createMockClient(selectRows: Array<{ pk: string; encrypted: unknown }>) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    queries,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT")) return { rows: selectRows };
        return { rows: [] };
      },
      release: () => {},
    } as unknown as import("pg").PoolClient,
  };
}

describe("rotateTable (F-47 re-encryption)", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;
  const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;

  beforeEach(() => {
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (savedKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = savedKeys;
    else delete process.env.ATLAS_ENCRYPTION_KEYS;
    _resetEncryptionKeyCache();
  });

  it("re-encrypts a v1 row with the v2 active key and stamps _key_version=2", async () => {
    // Phase A — produce a v1 ciphertext under the old keyset.
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
    _resetEncryptionKeyCache();
    const legacyCiphertext = encryptSecret("slack-token-alpha");
    expect(legacyCiphertext.startsWith("enc:v1:")).toBe(true);

    // Phase B — rotate: v2 becomes active, v1 kept for reads.
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
    _resetEncryptionKeyCache();

    const { client, queries } = createMockClient([{ pk: "T1", encrypted: legacyCiphertext }]);
    const result = await rotateTable(client, {
      kind: "column",
      table: "slack_installations",
      pk: "team_id",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
    }, 2);

    expect(result.table).toBe("slack_installations");
    expect(result.updated).toBe(1);
    expect(result.skippedEmpty).toBe(0);
    expect(result.orphaned).toBe(0);
    expect(result.unprefixed).toBe(0);

    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("bot_token_encrypted = $1");
    expect(updates[0].sql).toContain("bot_token_key_version = $2");
    expect(String(updates[0].params![0])).toMatch(/^enc:v2:/);
    expect(updates[0].params![1]).toBe(2);
    expect(updates[0].params![2]).toBe("T1");

    // Round-trip: the new ciphertext decrypts back to the original plaintext.
    expect(decryptSecret(String(updates[0].params![0]))).toBe("slack-token-alpha");
  });

  it("filters by _key_version < $active in SELECT (idempotent re-run)", async () => {
    // Lock in the idempotence predicate — a regression that dropped the
    // filter would re-encrypt already-rotated rows and waste work (or
    // worse, double-wrap a ciphertext that fails the format check).
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
    _resetEncryptionKeyCache();
    const { client, queries } = createMockClient([]);

    await rotateTable(client, {
      kind: "column",
      table: "slack_installations",
      pk: "team_id",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
    }, 2);

    const select = queries.find((q) => q.sql.startsWith("SELECT"));
    expect(select).toBeDefined();
    expect(select!.sql).toMatch(/bot_token_key_version\s*<\s*\$1/);
    expect(select!.params).toEqual([2]);
  });

  it("skips rows whose ciphertext fails to decrypt (missing legacy key) without aborting the batch", async () => {
    // Write under v3 (a key that will vanish), then rotate to v4 with
    // only v4 in the keyset. The orphaned row can't decrypt — the
    // script logs and skips, it does NOT abort the whole run.
    process.env.ATLAS_ENCRYPTION_KEYS = "v3:ghost";
    _resetEncryptionKeyCache();
    const orphan = encryptSecret("orphaned");

    process.env.ATLAS_ENCRYPTION_KEYS = "v4:fresh";
    _resetEncryptionKeyCache();
    const healthy = encryptSecret("reachable");

    process.env.ATLAS_ENCRYPTION_KEYS = "v5:newer,v4:fresh";
    _resetEncryptionKeyCache();

    const { client, queries } = createMockClient([
      { pk: "orphan", encrypted: orphan },
      { pk: "healthy", encrypted: healthy },
    ]);
    const result = await rotateTable(client, {
      kind: "column",
      table: "slack_installations",
      pk: "team_id",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
    }, 5);

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(1);
    // Orphan path bumps `orphaned`, not `skippedEmpty` — ops need to
    // distinguish "bad data drift" from "you dropped a legacy key".
    expect(result.orphaned).toBe(1);
    expect(result.unprefixed).toBe(0);
    expect(result.skippedEmpty).toBe(0);

    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0].params![2]).toBe("healthy");
  });

  it("separates empty-string rows into skippedEmpty, not orphaned", async () => {
    // Belt-and-braces for the RotateResult invariant: a NULL/empty
    // encrypted column is harmless schema drift (not a rotation failure).
    // Only decrypt failures count as `orphaned` — ops uses `orphaned > 0`
    // as the exit-code-2 signal, so the separation has to hold.
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
    _resetEncryptionKeyCache();
    const { client } = createMockClient([
      { pk: "blank", encrypted: "" },
      { pk: "nully", encrypted: null as unknown as string },
    ]);
    const result = await rotateTable(client, {
      kind: "column",
      table: "slack_installations",
      pk: "team_id",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
    }, 2);
    expect(result.updated).toBe(0);
    expect(result.skippedEmpty).toBe(2);
    expect(result.orphaned).toBe(0);
    expect(result.unprefixed).toBe(0);
  });

  it("counts un-prefixed rows as `unprefixed` (refuses to silently re-encrypt)", async () => {
    // A corrupted/truncated `enc:v<N>:` prefix would silently round-trip
    // through decryptSecret → encryptSecret as if it were plaintext —
    // emerging as ciphertext-of-the-broken-string with no way to
    // recover the original. The rotation script refuses the operation;
    // operator must inspect and re-save through the admin UI. Tracked
    // separately from `orphaned` because the remediation differs (adding
    // a legacy key back to the keyset won't fix this).
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
    _resetEncryptionKeyCache();

    const { client, queries } = createMockClient([
      // Either legacy plaintext (predates F-47) or a corrupted prefix —
      // both refuse rotation. We don't distinguish because we *can't*
      // distinguish: either way, the safe response is to refuse.
      { pk: "legacy_plaintext", encrypted: "sk-just-a-raw-key" },
      { pk: "corrupted_prefix", encrypted: "nc:v1:iv:tag:body" }, // missing leading 'e'
    ]);

    const result = await rotateTable(client, {
      kind: "column",
      table: "workspace_model_config",
      pk: "id",
      encrypted: "api_key_encrypted",
      keyVersionColumn: "api_key_key_version",
    }, 2);

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.unprefixed).toBe(2);
    expect(result.orphaned).toBe(0);
    expect(result.skippedEmpty).toBe(0);

    // Sanity: no UPDATEs issued — the script refused to touch either row.
    expect(queries.filter((q) => q.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("UnprefixedSecretError is exported with a stable tag", () => {
    // The tag is part of the script's contract for callers that want
    // to route on it (currently only rotateTable internally). Pin it
    // so a future rename surfaces as a test failure rather than a
    // silent reclassification of un-prefixed rows as generic orphans.
    const err = new UnprefixedSecretError();
    expect(err._tag).toBe("UnprefixedSecretError");
    expect(err).toBeInstanceOf(Error);
  });

  it("rejects unvetted SQL identifiers to prevent injection", async () => {
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:k";
    _resetEncryptionKeyCache();
    const { client } = createMockClient([]);
    await expect(
      rotateTable(client, {
        kind: "column",
        table: "slack_installations; DROP TABLE x",
        pk: "team_id",
        encrypted: "bot_token_encrypted",
        keyVersionColumn: "bot_token_key_version",
      }, 1),
    ).rejects.toThrow(/not a valid SQL identifier/);
  });

  it("rolls back the transaction on UPDATE failure (no partial rotation)", async () => {
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
    _resetEncryptionKeyCache();

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT")) {
          return {
            rows: [{
              pk: "T1",
              encrypted: (() => {
                process.env.ATLAS_ENCRYPTION_KEYS = "v1:old";
                _resetEncryptionKeyCache();
                const c = encryptSecret("before");
                process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
                _resetEncryptionKeyCache();
                return c;
              })(),
            }],
          };
        }
        if (sql.startsWith("UPDATE")) throw new Error("disk full");
        return { rows: [] };
      },
      release: () => {},
    } as unknown as import("pg").PoolClient;

    await expect(
      rotateTable(client, {
        kind: "column",
        table: "slack_installations",
        pk: "team_id",
        encrypted: "bot_token_encrypted",
        keyVersionColumn: "bot_token_key_version",
      }, 2),
    ).rejects.toThrow("disk full");

    expect(
      queries.map((q) => q.sql).filter((s) => s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK"),
    ).toEqual(["BEGIN", "ROLLBACK"]);
  });
});

// ---------------------------------------------------------------------------
// rotateJsonbSelectiveField — workspace_plugins.config post-#2744
// ---------------------------------------------------------------------------

/**
 * Mock pg client for JSONB rotation. The SELECT returns rows shaped
 * like the production JOIN (`{ pk, config, config_schema }`); UPDATE
 * captures params so the test can assert the merged JSONB payload.
 */
function createJsonbMockClient(
  selectRows: Array<{ pk: string; config: unknown; config_schema: unknown }>,
) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    queries,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT")) return { rows: selectRows };
        return { rows: [] };
      },
      release: () => {},
    } as unknown as import("pg").PoolClient,
  };
}

const JSONB_TARGET = {
  kind: "jsonb-selective-field" as const,
  table: "workspace_plugins",
  pk: "id",
  jsonbColumn: "config",
  catalogIdColumn: "catalog_id",
  catalogTable: "plugin_catalog",
  catalogPk: "id",
  catalogSchemaColumn: "config_schema",
};

describe("rotateJsonbSelectiveField (F-47 JSONB selective-field rotation)", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;
  const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;

  beforeEach(() => {
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (savedKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = savedKeys;
    else delete process.env.ATLAS_ENCRYPTION_KEYS;
    _resetEncryptionKeyCache();
  });

  it("re-encrypts a v1 secret field under v2 and preserves non-secret fields", async () => {
    // Phase A — encrypt under v1.
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
    _resetEncryptionKeyCache();
    const v1Url = encryptSecret("postgres://user:pw@host:5432/db");

    // Phase B — rotate.
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
    _resetEncryptionKeyCache();

    const { client, queries } = createJsonbMockClient([
      {
        pk: "wp_abc",
        config: { url: v1Url, name: "prod-us", port: 5432 },
        config_schema: [
          { key: "url", type: "string", secret: true },
          { key: "name", type: "string" },
          { key: "port", type: "number" },
        ],
      },
    ]);

    const result = await rotateJsonbSelectiveField(client, JSONB_TARGET, 2);

    expect(result.table).toBe("workspace_plugins");
    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skippedEmpty).toBe(0);
    expect(result.orphaned).toBe(0);
    expect(result.unprefixed).toBe(0);

    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    const merged = JSON.parse(String(updates[0].params![0])) as Record<string, unknown>;
    expect(String(merged.url)).toMatch(/^enc:v2:/);
    // Non-secret fields preserved verbatim.
    expect(merged.name).toBe("prod-us");
    expect(merged.port).toBe(5432);
    expect(updates[0].params![1]).toBe("wp_abc");

    // Round-trip: the re-encrypted ciphertext decrypts back to the original.
    expect(decryptSecret(String(merged.url))).toBe("postgres://user:pw@host:5432/db");
  });

  it("is idempotent — a v2-already-encrypted row is a skippedEmpty no-op", async () => {
    // Production wins here: re-running rotation against a cleanly-rotated
    // DB must not issue UPDATEs (otherwise the script wastes write
    // bandwidth and clutters the audit log). Pin this hard.
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
    _resetEncryptionKeyCache();
    const v2Url = encryptSecret("postgres://already-rotated");

    const { client, queries } = createJsonbMockClient([
      {
        pk: "wp_clean",
        config: { url: v2Url },
        config_schema: [{ key: "url", type: "string", secret: true }],
      },
    ]);

    const result = await rotateJsonbSelectiveField(client, JSONB_TARGET, 2);

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skippedEmpty).toBe(1);
    expect(queries.filter((q) => q.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("skips rows whose schema has no secret fields (skippedEmpty)", async () => {
    // A catalog row with `config_schema` declared but no `secret: true`
    // field has nothing to rotate. The row still SELECTs but never
    // UPDATEs — keeps the JOIN pattern cheap when most rows are
    // configuration-only (e.g. dashboard layout plugins).
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
    _resetEncryptionKeyCache();

    const { client, queries } = createJsonbMockClient([
      {
        pk: "wp_nosecret",
        config: { region: "us-east-1", tier: "standard" },
        config_schema: [
          { key: "region", type: "string" },
          { key: "tier", type: "string" },
        ],
      },
    ]);

    const result = await rotateJsonbSelectiveField(client, JSONB_TARGET, 2);

    expect(result.scanned).toBe(1);
    expect(result.skippedEmpty).toBe(1);
    expect(result.updated).toBe(0);
    expect(queries.filter((q) => q.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("counts an orphan row as orphaned and refuses to partial-update", async () => {
    // Encrypt one secret field under a ghost key, another under the
    // active reader. Row has BOTH a rotatable and an orphan field.
    // Worst-outcome-wins: the row is counted as `orphaned` and no
    // UPDATE issued — partial rotation would leave mixed versions.
    process.env.ATLAS_ENCRYPTION_KEYS = "v3:ghost";
    _resetEncryptionKeyCache();
    const orphan = encryptSecret("orphaned-secret");

    process.env.ATLAS_ENCRYPTION_KEYS = "v4:fresh";
    _resetEncryptionKeyCache();
    const healthy = encryptSecret("rotatable-secret");

    process.env.ATLAS_ENCRYPTION_KEYS = "v5:newer,v4:fresh";
    _resetEncryptionKeyCache();

    const { client, queries } = createJsonbMockClient([
      {
        pk: "wp_orphan_row",
        config: { token_a: orphan, token_b: healthy },
        config_schema: [
          { key: "token_a", type: "string", secret: true },
          { key: "token_b", type: "string", secret: true },
        ],
      },
    ]);

    const result = await rotateJsonbSelectiveField(client, JSONB_TARGET, 5);

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.unprefixed).toBe(0);
    expect(result.skippedEmpty).toBe(0);
    // No UPDATE issued — operator must add v3:ghost back to the keyset
    // and re-run before the row converges.
    expect(queries.filter((q) => q.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("counts an unprefixed-secret-field row as unprefixed (no UPDATE)", async () => {
    // A `secret: true` field that holds a legacy-plaintext value (or
    // a corrupted prefix) gets the same refuse-and-flag treatment as
    // the column path. The script never silently re-encrypts an
    // un-prefixed string — round-tripping decrypt→encrypt would emit
    // ciphertext-of-the-broken-string with no recovery path.
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
    _resetEncryptionKeyCache();

    const { client, queries } = createJsonbMockClient([
      {
        pk: "wp_legacy_pt",
        config: { api_key: "sk-just-a-raw-key" },
        config_schema: [{ key: "api_key", type: "string", secret: true }],
      },
    ]);

    const result = await rotateJsonbSelectiveField(client, JSONB_TARGET, 2);

    expect(result.scanned).toBe(1);
    expect(result.unprefixed).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.orphaned).toBe(0);
    expect(queries.filter((q) => q.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("corrupt config_schema — rotates already-encrypted strings, leaves plaintext non-secrets alone", async () => {
    // The rotate path is asymmetric with the write path on corrupt
    // schemas: the write path encrypts every string fail-closed (it
    // has plaintext to work with), but rotate can only re-encrypt
    // values that already carry `enc:v<N>:`. Treating plaintext
    // non-secrets (e.g. `name`, `region`) as candidate-secrets would
    // flag them as `unprefixed` and block the row from rotating its
    // legitimate ciphertext. See Codex review on #2832.
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
    _resetEncryptionKeyCache();
    const v1Token = encryptSecret("rotatable-under-v1");

    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
    _resetEncryptionKeyCache();

    const { client, queries } = createJsonbMockClient([
      {
        pk: "wp_corrupt",
        // Mixed shape: one ciphertext (token), one plaintext non-secret
        // (name), one non-string (port). Pre-fix, `name` landed in the
        // `unprefixed` bucket and blocked the row entirely.
        config: { token: v1Token, name: "prod-us", port: 5432 },
        // Not an array — `parseConfigSchema` flags this as `corrupt`.
        config_schema: { broken: true },
      },
    ]);

    const result = await rotateJsonbSelectiveField(client, JSONB_TARGET, 2);

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
    // `name` must NOT be classified as unprefixed — it's plaintext on
    // a corrupt-schema row and presumed to be a non-secret.
    expect(result.unprefixed).toBe(0);
    expect(result.orphaned).toBe(0);
    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    const merged = JSON.parse(String(updates[0].params![0])) as Record<string, unknown>;
    // Ciphertext rotated despite the schema corruption.
    expect(String(merged.token)).toMatch(/^enc:v2:/);
    // Plaintext non-secret preserved verbatim by the JSONB merge.
    expect(merged.name).toBe("prod-us");
    // Non-string field untouched.
    expect(merged.port).toBe(5432);
  });

  it("absent config_schema (null) skips the row entirely", async () => {
    // Catalog rows with `config_schema = NULL` (no selective-field
    // contract) get walked but yield no rotation work. Distinct from
    // the `corrupt` branch — `null` is a legitimate "no schema",
    // `corrupt` is "schema column is broken".
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:old";
    _resetEncryptionKeyCache();
    const cipher = encryptSecret("secret");

    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
    _resetEncryptionKeyCache();

    const { client, queries } = createJsonbMockClient([
      {
        pk: "wp_noschema",
        config: { token: cipher },
        config_schema: null,
      },
    ]);

    const result = await rotateJsonbSelectiveField(client, JSONB_TARGET, 2);

    expect(result.scanned).toBe(1);
    expect(result.skippedEmpty).toBe(1);
    expect(result.updated).toBe(0);
    expect(queries.filter((q) => q.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("rejects unvetted SQL identifiers (table / pk / jsonbColumn / catalog fields)", async () => {
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:k";
    _resetEncryptionKeyCache();
    const { client } = createJsonbMockClient([]);
    await expect(
      rotateJsonbSelectiveField(
        client,
        { ...JSONB_TARGET, table: "workspace_plugins; DROP TABLE x" },
        1,
      ),
    ).rejects.toThrow(/not a valid SQL identifier/);
  });

  it("rolls back the transaction on UPDATE failure (no partial rotation)", async () => {
    // Same belt-and-braces invariant as the column path. The merged
    // JSONB UPDATE must be atomic — a mid-batch crash leaves the row
    // exactly as it was, so the operator can re-run after fixing the
    // failure cause without worrying about half-rotated rows.
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:old";
    _resetEncryptionKeyCache();
    const v1 = encryptSecret("before");

    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
    _resetEncryptionKeyCache();

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT")) {
          return {
            rows: [{
              pk: "wp_disk_full",
              config: { token: v1 },
              config_schema: [{ key: "token", type: "string", secret: true }],
            }],
          };
        }
        if (sql.startsWith("UPDATE")) throw new Error("disk full");
        return { rows: [] };
      },
      release: () => {},
    } as unknown as import("pg").PoolClient;

    await expect(
      rotateJsonbSelectiveField(client, JSONB_TARGET, 2),
    ).rejects.toThrow("disk full");

    expect(
      queries.map((q) => q.sql).filter((s) => s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK"),
    ).toEqual(["BEGIN", "ROLLBACK"]);
  });
});

// ---------------------------------------------------------------------------
// Real-Postgres integration smoke (#2820 acceptance criterion)
// ---------------------------------------------------------------------------

/**
 * End-to-end JSONB rotation against a real Postgres. The acceptance
 * criterion from #2820 calls out the failure mode mock-pool tests can't
 * catch: the SELECT joins workspace_plugins to plugin_catalog and the
 * UPDATE writes a `$1::jsonb` payload — both shapes only fully exercise
 * against the real schema (the JOIN walker, the JSONB cast, the FK).
 *
 * Skips cleanly when TEST_DATABASE_URL is unset so local dev that hasn't
 * run `bun run db:up` is unaffected. CI provides Postgres via a service
 * container in the api-tests workflow.
 */
const PG_INT_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = PG_INT_TEST_DB_URL ? describe : describe.skip;
const PG_INT_TEST_TIMEOUT_MS = 30_000;

describeIfPg("rotateJsonbSelectiveField (real Postgres, #2820)", () => {
  let pool: Pool;
  const schemaName = `rotate_jsonb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;
  const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;
  // Stable across the whole describe block — every test in here runs
  // against a single migrated schema.
  const target = {
    kind: "jsonb-selective-field" as const,
    table: "workspace_plugins",
    pk: "id",
    jsonbColumn: "config",
    catalogIdColumn: "catalog_id",
    catalogTable: "plugin_catalog",
    catalogPk: "id",
    catalogSchemaColumn: "config_schema",
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_INT_TEST_DB_URL });
    // Per-test schema isolation — same pattern as migrate-pg.test.ts.
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`rotate-jsonb: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    // Migrations create plugin_catalog + workspace_plugins (post-#2744).
    // Better-Auth-dependent migrations are skipped — this test doesn't
    // need the auth tables and skipping keeps the smoke fast.
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_INT_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
    // Restore env at the end so other tests in the suite aren't
    // affected by the rotation key juggling below.
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (savedKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = savedKeys;
    else delete process.env.ATLAS_ENCRYPTION_KEYS;
    _resetEncryptionKeyCache();
  });

  /**
   * Seed a catalog row with a `secret: true` field and a workspace_plugins
   * install whose `config.url` is an `enc:v1:` ciphertext for the given
   * plaintext. Returns the install's primary key so the caller can
   * SELECT it back after rotation.
   */
  async function seedInstallWithV1Secret(plaintext: string): Promise<string> {
    // Encrypt under v1 BEFORE rotating the keyset — otherwise the
    // ciphertext lands at whatever the active version is.
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:int-test-old";
    _resetEncryptionKeyCache();
    const v1Cipher = encryptSecret(plaintext);
    expect(v1Cipher.startsWith("enc:v1:")).toBe(true);

    const catalogId = `cat-${Math.random().toString(36).slice(2, 10)}`;
    const installPk = `wp-${Math.random().toString(36).slice(2, 10)}`;

    // plugin_catalog row — config_schema marks `url` as secret.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model, config_schema)
       VALUES ($1, 'Test Datasource', $2, 'datasource', 'datasource', 'form', $3::jsonb)`,
      [
        catalogId,
        `test-ds-${catalogId}`,
        JSON.stringify([
          { key: "url", type: "string", secret: true },
          { key: "name", type: "string" },
        ]),
      ],
    );

    // workspace_plugins row — config.url is the v1 ciphertext.
    await pool.query(
      `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, status)
       VALUES ($1, $2, $3, $4, 'datasource', $5::jsonb, 'published')`,
      [
        installPk,
        `ws-${installPk}`,
        catalogId,
        `inst-${installPk}`,
        JSON.stringify({ url: v1Cipher, name: "prod-us" }),
      ],
    );

    return installPk;
  }

  it("rotates a v1-encrypted JSONB secret field under v2 (acceptance test)", async () => {
    const plaintext = "postgres://u:p@db.example:5432/atlas";
    const installPk = await seedInstallWithV1Secret(plaintext);

    // Stage v2 as the active reader/writer; keep v1 around for the
    // legacy ciphertext read.
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:int-test-new,v1:int-test-old";
    _resetEncryptionKeyCache();

    const client = await pool.connect();
    let result;
    try {
      result = await rotateJsonbSelectiveField(client, target, 2);
    } finally {
      client.release();
    }

    expect(result.table).toBe("workspace_plugins");
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.orphaned).toBe(0);
    expect(result.unprefixed).toBe(0);

    const { rows } = await pool.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM workspace_plugins WHERE id = $1`,
      [installPk],
    );
    const cfg = rows[0]!.config;
    expect(String(cfg.url)).toMatch(/^enc:v2:/);
    // Non-secret fields preserved verbatim by the JSONB merge.
    expect(cfg.name).toBe("prod-us");
    // Round-trip through the active keyset returns the original plaintext.
    expect(decryptSecret(String(cfg.url))).toBe(plaintext);
  }, PG_INT_TEST_TIMEOUT_MS);

  it("is idempotent — a second rotation pass issues no UPDATEs", async () => {
    // Re-running rotation against an already-rotated DB must be a
    // no-op. The acceptance criterion calls this out explicitly:
    // "Idempotent — re-running rotation is a no-op."
    const plaintext = "postgres://idem:p@db.example:5432/atlas";
    await seedInstallWithV1Secret(plaintext);

    process.env.ATLAS_ENCRYPTION_KEYS = "v2:int-test-new,v1:int-test-old";
    _resetEncryptionKeyCache();

    // First pass — rotates everything not at v2.
    const client1 = await pool.connect();
    try {
      await rotateJsonbSelectiveField(client1, target, 2);
    } finally {
      client1.release();
    }

    // Second pass — every row is already at v2, so no UPDATE issues.
    const client2 = await pool.connect();
    let secondResult;
    try {
      secondResult = await rotateJsonbSelectiveField(client2, target, 2);
    } finally {
      client2.release();
    }

    expect(secondResult.updated).toBe(0);
    expect(secondResult.orphaned).toBe(0);
    expect(secondResult.unprefixed).toBe(0);
    // Every scanned row landed in skippedEmpty — either "no secret
    // fields" or "every secret field already at active".
    expect(secondResult.skippedEmpty).toBe(secondResult.scanned);
  }, PG_INT_TEST_TIMEOUT_MS);
});
