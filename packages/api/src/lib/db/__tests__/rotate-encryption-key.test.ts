/**
 * Tests for the F-47 re-encryption script.
 *
 * The script walks every encrypted column, decrypts under whichever
 * keyset entry the ciphertext prefix names, re-encrypts with the
 * active key, and stamps the companion `<col>_key_version` column.
 * These tests pin the per-row rotate contract and the idempotence
 * guard that makes the script safe to run repeatedly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rotateTable } from "../../../../scripts/rotate-encryption-key";
import {
  _resetEncryptionKeyCache,
  encryptUrl,
  decryptUrl,
} from "../internal";
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
      table: "slack_installations",
      pk: "team_id",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
      kind: "secret",
    }, 2);

    expect(result.table).toBe("slack_installations");
    expect(result.updated).toBe(1);
    expect(result.skippedEmpty).toBe(0);
    expect(result.orphaned).toBe(0);

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
      table: "slack_installations",
      pk: "team_id",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
      kind: "secret",
    }, 2);

    const select = queries.find((q) => q.sql.startsWith("SELECT"));
    expect(select).toBeDefined();
    expect(select!.sql).toMatch(/bot_token_key_version\s*<\s*\$1/);
    expect(select!.params).toEqual([2]);
  });

  it("rotates a pre-F-47 unversioned connection URL ciphertext to versioned", async () => {
    // Build an unversioned ciphertext by stripping the `enc:v1:` prefix
    // from a v1 write — simulates rows that predate F-47.
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
    _resetEncryptionKeyCache();
    const v1Ciphertext = encryptUrl("postgresql://admin:pw@host/db");
    expect(v1Ciphertext.startsWith("enc:v1:")).toBe(true);
    const unversionedCiphertext = v1Ciphertext.replace(/^enc:v1:/, "");

    // Bump to v2. The rotation script must:
    //  • decrypt the unversioned form via the legacy-fallback path;
    //  • re-encrypt under v2; stamp key_version=2.
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
    _resetEncryptionKeyCache();

    const { client, queries } = createMockClient([{ pk: "conn-1", encrypted: unversionedCiphertext }]);
    const result = await rotateTable(client, {
      table: "connections",
      pk: "id",
      encrypted: "url",
      keyVersionColumn: "url_key_version",
      kind: "url",
    }, 2);

    expect(result.updated).toBe(1);
    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(String(updates[0].params![0])).toMatch(/^enc:v2:/);
    expect(decryptUrl(String(updates[0].params![0]))).toBe("postgresql://admin:pw@host/db");
  });

  it("encrypts a plaintext connection URL for the first time under the active key", async () => {
    // Legacy self-hosted deployments may carry rows with
    // `postgres://…` (no prior encryption at all). The rotation script
    // is a natural moment to close out the pre-encryption back-compat
    // window.
    process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw";
    _resetEncryptionKeyCache();

    const plaintextUrl = "postgresql://user:pass@host/db";
    const { client, queries } = createMockClient([{ pk: "conn-legacy", encrypted: plaintextUrl }]);
    const result = await rotateTable(client, {
      table: "connections",
      pk: "id",
      encrypted: "url",
      keyVersionColumn: "url_key_version",
      kind: "url",
    }, 2);
    expect(result.updated).toBe(1);
    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(String(updates[0].params![0])).toMatch(/^enc:v2:/);
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
      table: "slack_installations",
      pk: "team_id",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
      kind: "secret",
    }, 5);

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(1);
    // Orphan path bumps `orphaned`, not `skippedEmpty` — ops need to
    // distinguish "bad data drift" from "you dropped a legacy key".
    expect(result.orphaned).toBe(1);
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
      table: "slack_installations",
      pk: "team_id",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
      kind: "secret",
    }, 2);
    expect(result.updated).toBe(0);
    expect(result.skippedEmpty).toBe(2);
    expect(result.orphaned).toBe(0);
  });

  it("rejects unvetted SQL identifiers to prevent injection", async () => {
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:k";
    _resetEncryptionKeyCache();
    const { client } = createMockClient([]);
    await expect(
      rotateTable(client, {
        table: "slack_installations; DROP TABLE x",
        pk: "team_id",
        encrypted: "bot_token_encrypted",
        keyVersionColumn: "bot_token_key_version",
        kind: "secret",
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
        table: "slack_installations",
        pk: "team_id",
        encrypted: "bot_token_encrypted",
        keyVersionColumn: "bot_token_key_version",
        kind: "secret",
      }, 2),
    ).rejects.toThrow("disk full");

    expect(
      queries.map((q) => q.sql).filter((s) => s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK"),
    ).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
