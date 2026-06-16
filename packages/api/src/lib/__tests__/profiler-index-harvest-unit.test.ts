/**
 * DB-free unit coverage for the index-harvest helpers (#3634).
 *
 * The live-DB tests (`profiler-index-harvest-pg.test.ts`,
 * `profiler-index-harvest-mysql.test.ts`) `describe.skip` unless
 * `TEST_DATABASE_URL` / `TEST_MYSQL_URL` are set — and there is no MySQL
 * container in CI — so the catalog queries and their row→IndexProfile mapping
 * had no guaranteed CI coverage. These stub the pool's `query`/`execute` so the
 * version-branch column selection (PG `indnkeyatts` vs `indnatts`) and the
 * MySQL functional-key-part skipping run on every CI pass.
 */
import { describe, test, expect } from "bun:test";
import { queryPostgresIndexes, queryMySQLIndexes } from "@atlas/api/lib/profiler";

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/** Minimal pg.Pool stub that records the SQL it was handed and returns canned rows. */
function makePgPool(rows: unknown[]) {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows };
    },
  };
  return { pool: pool as unknown as import("pg").Pool, calls };
}

describe("queryPostgresIndexes — version branch (C2)", () => {
  test("PG 11+ counts key columns via indnkeyatts (excludes INCLUDE/covering cols)", async () => {
    const { pool, calls } = makePgPool([]);
    await queryPostgresIndexes(pool, "orders", "public", 110000);
    expect(calls[0]).toContain("ix.indnkeyatts");
    expect(calls[0]).not.toContain("ix.indnatts AS key_count");
  });

  test("pre-11 / unknown server falls back to the portable indnatts", async () => {
    const { pool, calls } = makePgPool([]);
    await queryPostgresIndexes(pool, "orders", "public", 100000);
    expect(calls[0]).toContain("ix.indnatts");
    expect(calls[0]).not.toContain("indnkeyatts");

    const { pool: pool0, calls: calls0 } = makePgPool([]);
    await queryPostgresIndexes(pool0, "orders", "public", 0); // version undetected
    expect(calls0[0]).toContain("ix.indnatts");
    expect(calls0[0]).not.toContain("indnkeyatts");
  });
});

describe("queryPostgresIndexes — row mapping", () => {
  test("orders columns, normalizes type, and nulls the predicate on non-partial indexes", async () => {
    const { pool } = makePgPool([
      {
        index_name: "orders_pkey",
        index_type: "btree",
        is_unique: true,
        is_primary: true,
        is_partial: false,
        predicate: null,
        key_defs: ["id"],
      },
      {
        index_name: "orders_customer_created_idx",
        index_type: "btree",
        is_unique: false,
        is_primary: false,
        is_partial: true,
        predicate: "(status = 'active'::text)",
        // generate_series ordering preserved; blank/whitespace members dropped.
        key_defs: ["customer_id", "  created_at  ", ""],
      },
    ]);

    const indexes = await queryPostgresIndexes(pool, "orders", "public", 110000);
    expect(indexes).toHaveLength(2);

    const pk = indexes[0];
    expect(pk.is_primary).toBe(true);
    expect(pk.is_unique).toBe(true);
    expect(pk.is_partial).toBe(false);
    expect(pk.predicate).toBeNull();

    const composite = indexes[1];
    // Leading-prefix order preserved; trimmed; empty member filtered out.
    expect(composite.columns).toEqual(["customer_id", "created_at"]);
    expect(composite.is_partial).toBe(true);
    expect(composite.predicate).toBe("(status = 'active'::text)");
  });

  test("a partial-flag-false row drops a stray predicate (defensive)", async () => {
    const { pool } = makePgPool([
      {
        index_name: "i",
        index_type: "gin",
        is_unique: false,
        is_primary: false,
        is_partial: false,
        predicate: "(x > 0)", // present but is_partial=false → must be nulled
        key_defs: ["doc"],
      },
    ]);
    const [idx] = await queryPostgresIndexes(pool, "t", "public", 110000);
    expect(idx.predicate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

/** Minimal mysql2 pool stub: `execute` returns the [rows, fields] tuple. */
function makeMySqlPool(rows: unknown[]) {
  return {
    execute: async (): Promise<[unknown[], unknown]> => [rows, undefined],
  };
}

describe("queryMySQLIndexes — functional/expression key parts (C3)", () => {
  test("skips null COLUMN_NAME parts; a wholly-functional index drops out", async () => {
    const pool = makeMySqlPool([
      // A normal composite index.
      { INDEX_NAME: "idx_a", COLUMN_NAME: "x", SEQ_IN_INDEX: 1, NON_UNIQUE: 1, INDEX_TYPE: "BTREE" },
      { INDEX_NAME: "idx_a", COLUMN_NAME: "y", SEQ_IN_INDEX: 2, NON_UNIQUE: 1, INDEX_TYPE: "BTREE" },
      // A wholly-functional index — every part has a null COLUMN_NAME.
      { INDEX_NAME: "idx_fn", COLUMN_NAME: null, SEQ_IN_INDEX: 1, NON_UNIQUE: 1, INDEX_TYPE: "BTREE" },
    ]);

    const indexes = await queryMySQLIndexes(pool, "orders");
    // idx_fn drops out entirely; only idx_a survives with both columns in order.
    expect(indexes).toHaveLength(1);
    expect(indexes[0].name).toBe("idx_a");
    expect(indexes[0].columns).toEqual(["x", "y"]);
    expect(indexes[0].is_unique).toBe(false); // NON_UNIQUE=1
  });

  test("PRIMARY is is_primary+is_unique; NON_UNIQUE=0 is unique", async () => {
    const pool = makeMySqlPool([
      { INDEX_NAME: "PRIMARY", COLUMN_NAME: "id", SEQ_IN_INDEX: 1, NON_UNIQUE: 0, INDEX_TYPE: "BTREE" },
      { INDEX_NAME: "uq_email", COLUMN_NAME: "email", SEQ_IN_INDEX: 1, NON_UNIQUE: 0, INDEX_TYPE: "BTREE" },
    ]);
    const indexes = await queryMySQLIndexes(pool, "users");
    const pk = indexes.find((i) => i.name === "PRIMARY")!;
    expect(pk.is_primary).toBe(true);
    expect(pk.is_unique).toBe(true);
    const uq = indexes.find((i) => i.name === "uq_email")!;
    expect(uq.is_primary).toBe(false);
    expect(uq.is_unique).toBe(true);
  });

  test("an index with one functional part among real columns keeps the real columns", async () => {
    const pool = makeMySqlPool([
      { INDEX_NAME: "idx_mix", COLUMN_NAME: "a", SEQ_IN_INDEX: 1, NON_UNIQUE: 1, INDEX_TYPE: "BTREE" },
      { INDEX_NAME: "idx_mix", COLUMN_NAME: null, SEQ_IN_INDEX: 2, NON_UNIQUE: 1, INDEX_TYPE: "BTREE" },
      { INDEX_NAME: "idx_mix", COLUMN_NAME: "b", SEQ_IN_INDEX: 3, NON_UNIQUE: 1, INDEX_TYPE: "BTREE" },
    ]);
    const [idx] = await queryMySQLIndexes(pool, "t");
    expect(idx.columns).toEqual(["a", "b"]);
  });
});
