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
import { backfillTable } from "../backfill-integration-credentials";
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
    // and that the PK lines up with the source row.
    expect(updates[0].sql).toContain("UPDATE slack_installations SET bot_token_encrypted = $1 WHERE team_id = $2");
    expect(String(updates[0].params![0])).toMatch(/^enc:v1:/);
    expect(updates[0].params![1]).toBe("T1");
    expect(String(updates[1].params![0])).toMatch(/^enc:v1:/);
    expect(updates[1].params![1]).toBe("T2");
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
    });

    expect(result.scanned).toBe(4);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(3);
    const updates = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0].params![1]).toBe("D");
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
      }),
    ).rejects.toThrow("disk full");

    // BEGIN + SELECT + failed UPDATE + ROLLBACK — no COMMIT.
    expect(queries.map((q) => q.sql).filter((s) => s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK"))
      .toEqual(["BEGIN", "ROLLBACK"]);
  });
});
