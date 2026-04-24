/**
 * Tests for the F-41 backfill script.
 *
 * The script walks every integration table once and, for rows where the
 * encrypted column is NULL but the plaintext column is populated, writes
 * `encryptSecret(plaintext)` into the encrypted column. These tests
 * exercise that loop with a mock pg pool so the per-table SQL and
 * JSONB-vs-text handling don't drift from the production wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { backfillTable, TABLES } from "../backfill-integration-credentials";
import { _resetEncryptionKeyCache } from "../internal";

/**
 * Minimal pg-pool stub. Captures every query routed through `connect` so
 * tests can assert BEGIN / SELECT / UPDATE / COMMIT ordering and inspect
 * the UPDATE parameters.
 */
function createMockPool(selectRows: Array<{ pk: string; plaintext: unknown }>) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const release = () => {};
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT")) return { rows: selectRows };
      return { rows: [] };
    },
    release,
  };
  return {
    queries,
    pool: { connect: async () => client },
  };
}

describe("backfillTable", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ATLAS_ENCRYPTION_KEY = "atlas-backfill-test-key";
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    _resetEncryptionKeyCache();
  });

  it("updates every plaintext row with an encrypted ciphertext (text table)", async () => {
    const { pool, queries } = createMockPool([
      { pk: "T1", plaintext: "xoxb-one" },
      { pk: "T2", plaintext: "xoxb-two" },
    ]);

    const result = await backfillTable(pool, {
      kind: "text",
      table: "slack_installations",
      pk: "team_id",
      plaintext: "bot_token",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
    });

    expect(result.table).toBe("slack_installations");
    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);

    const txnEvents = queries.filter((q) => q.sql === "BEGIN" || q.sql === "COMMIT");
    expect(txnEvents.map((e) => e.sql)).toEqual(["BEGIN", "COMMIT"]);

    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(2);
    // First param is the encrypted ciphertext — assert the enc:v1: prefix
    // and that the PK lines up with the source row. F-47 added the
    // `<col>_key_version = $3` stamp so the rotation script can
    // identify rows below the active version.
    expect(updates[0].sql).toContain(
      "UPDATE slack_installations SET bot_token_encrypted = $1, bot_token_key_version = $3 WHERE team_id = $2",
    );
    expect(String(updates[0].params![0])).toMatch(/^enc:v1:/);
    expect(updates[0].params![1]).toBe("T1");
    expect(updates[0].params![2]).toBe(1);
    expect(String(updates[1].params![0])).toMatch(/^enc:v1:/);
    expect(updates[1].params![1]).toBe("T2");
    expect(updates[1].params![2]).toBe(1);
  });

  it("serializes JSONB objects before encrypting", async () => {
    const blob = { apiKey: "sk-one", region: "us-east-1" };
    const { pool, queries } = createMockPool([{ pk: "cfg-1", plaintext: blob }]);

    const result = await backfillTable(pool, {
      kind: "jsonb",
      table: "email_installations",
      pk: "config_id",
      plaintext: "config",
      encrypted: "config_encrypted",
      keyVersionColumn: "config_key_version",
    });

    expect(result.updated).toBe(1);
    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    const ciphertext = String(updates[0].params![0]);
    expect(ciphertext).toMatch(/^enc:v1:/);
    // Deserialize the encrypted payload via the real decryptSecret to
    // prove the backfill round-trips correctly — avoids baking the
    // cipher format into the test assertions.
    const { decryptSecret } = await import("@atlas/api/lib/db/secret-encryption");
    expect(JSON.parse(decryptSecret(ciphertext))).toEqual(blob);
  });

  it("skips rows with empty or non-usable plaintext", async () => {
    const { pool, queries } = createMockPool([
      { pk: "A", plaintext: null },
      { pk: "B", plaintext: "" },
      { pk: "C", plaintext: 42 },
      { pk: "D", plaintext: "valid-token" },
    ]);

    const result = await backfillTable(pool, {
      kind: "text",
      table: "linear_installations",
      pk: "user_id",
      plaintext: "api_key",
      encrypted: "api_key_encrypted",
      keyVersionColumn: "api_key_key_version",
    });

    expect(result.scanned).toBe(4);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(3);
    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0].params![1]).toBe("D");
  });

  it("scans only rows where encrypted IS NULL AND plaintext IS NOT NULL (idempotent re-run)", async () => {
    // Lock in the idempotence predicate — a regression that dropped the
    // filter would re-encrypt already-encrypted rows and produce
    // `enc:v1:enc:v1:…` on the second run, which would then fail
    // `decryptSecret`'s three-part split. This is cheap to pin.
    const { pool, queries } = createMockPool([]);
    await backfillTable(pool, {
      kind: "text",
      table: "slack_installations",
      pk: "team_id",
      plaintext: "bot_token",
      encrypted: "bot_token_encrypted",
      keyVersionColumn: "bot_token_key_version",
    });
    const select = queries.find((q) => q.sql.startsWith("SELECT"));
    expect(select).toBeDefined();
    expect(select!.sql).toMatch(/WHERE\s+bot_token_encrypted\s+IS\s+NULL/);
    expect(select!.sql).toMatch(/AND\s+bot_token\s+IS\s+NOT\s+NULL/);
  });

  it("every TABLES entry produces the expected per-table SQL shape", async () => {
    // Typo-catcher: if someone adds a new integration (or renames a
    // column) and the TABLES entry references a non-existent column or
    // PK, this exercises the full path so the shape regression is caught
    // at unit-test time instead of in production.
    for (const config of TABLES) {
      const { pool, queries } = createMockPool([{ pk: "row-x", plaintext: "value" }]);
      await backfillTable(pool, config);
      const select = queries.find((q) => q.sql.startsWith("SELECT"));
      const update = queries.find((q) => q.sql.startsWith("UPDATE"));
      expect(select!.sql).toContain(`FROM ${config.table}`);
      expect(select!.sql).toContain(`WHERE ${config.encrypted} IS NULL`);
      expect(select!.sql).toContain(`AND ${config.plaintext} IS NOT NULL`);
      expect(update!.sql).toBe(
        `UPDATE ${config.table} SET ${config.encrypted} = $1, ${config.keyVersionColumn} = $3 WHERE ${config.pk} = $2`,
      );
    }
  });

  it("rejects configs with non-identifier table or column names (defense in depth)", async () => {
    // `TABLES` is the only caller today, but guard against a future
    // caller passing unvetted config — SQL identifiers go into string
    // concatenation so the validator must fail-loud.
    const { pool } = createMockPool([]);
    await expect(
      backfillTable(pool, {
        kind: "text",
        table: "slack_installations; DROP TABLE x",
        pk: "team_id",
        plaintext: "bot_token",
        encrypted: "bot_token_encrypted",
        keyVersionColumn: "bot_token_key_version",
      }),
    ).rejects.toThrow(/not a valid SQL identifier/);
  });

  it("rolls back the transaction when an UPDATE fails", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT")) return { rows: [{ pk: "bad", plaintext: "value" }] };
        if (sql.startsWith("UPDATE")) throw new Error("disk full");
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = { connect: async () => client };

    await expect(
      backfillTable(pool, {
        kind: "text",
        table: "slack_installations",
        pk: "team_id",
        plaintext: "bot_token",
        encrypted: "bot_token_encrypted",
        keyVersionColumn: "bot_token_key_version",
      }),
    ).rejects.toThrow("disk full");

    // BEGIN + SELECT + failed UPDATE + ROLLBACK — no COMMIT.
    expect(queries.map((q) => q.sql).filter((s) => s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK"))
      .toEqual(["BEGIN", "ROLLBACK"]);
  });
});
