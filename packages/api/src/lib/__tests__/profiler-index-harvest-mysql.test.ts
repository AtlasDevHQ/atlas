/**
 * LIVE-MySQL index harvest coverage (#3634, slice A-2).
 *
 * Seeds a table with single-column, composite, and unique indexes, runs
 * `profileMySQL`, and asserts the harvested `TableProfile.indexes` are grouped
 * by index name and ordered by `SEQ_IN_INDEX` (composite order preserved).
 * MySQL has no partial indexes, so every harvested index is `is_partial: false`
 * with a null predicate.
 *
 * Skips cleanly when `TEST_MYSQL_URL` is unset. There is no MySQL container in
 * the default dev stack or CI today, so this test is opt-in: point it at a
 * throwaway MySQL with
 *   export TEST_MYSQL_URL=mysql://user:pass@localhost:3306/atlas_test
 * The grouping/ordering logic also has DB-free coverage in
 * `semantic/generate/__tests__/index-awareness.test.ts` via fixture rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { profileMySQL } from "@atlas/api/lib/profiler";
import type { IndexProfile, TableProfile } from "@useatlas/types";

const TEST_MYSQL_URL = process.env.TEST_MYSQL_URL;
const describeIfMySQL = TEST_MYSQL_URL ? describe : describe.skip;

if (!TEST_MYSQL_URL) {
  console.warn(
    "profiler-index-harvest-mysql: TEST_MYSQL_URL unset — skipping live MySQL index harvest test (set it to opt in).",
  );
}

const MYSQL_TEST_TIMEOUT_MS = 30_000;
const TABLE = `idx_events_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describeIfMySQL("profileMySQL — index harvest (live MySQL, #3634)", () => {
  let profiles: TableProfile[];

  const events = (): TableProfile => profiles.find((p) => p.table_name === TABLE)!;
  const indexNamed = (name: string): IndexProfile | undefined =>
    (events().indexes ?? []).find((i) => i.name === name);

  // Lazily import mysql2 only when the test actually runs.
  let pool: { execute: (sql: string) => Promise<unknown>; end: () => Promise<void> };

  beforeAll(async () => {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    const mysql = require("mysql2/promise");
    pool = mysql.createPool({ uri: TEST_MYSQL_URL });
    await pool.execute(`DROP TABLE IF EXISTS \`${TABLE}\``);
    await pool.execute(`
      CREATE TABLE \`${TABLE}\` (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        tenant_id BINARY(16) NOT NULL,
        created_at DATETIME NOT NULL,
        status VARCHAR(32),
        email VARCHAR(255),
        UNIQUE KEY events_email_uq (email),
        KEY events_status_idx (status),
        KEY events_tenant_created_idx (tenant_id, created_at)
      )
    `);

    const result = await profileMySQL({ url: TEST_MYSQL_URL as string });
    profiles = result.profiles;
  }, MYSQL_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.execute(`DROP TABLE IF EXISTS \`${TABLE}\``).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  it("harvests the PRIMARY index as unique + primary", () => {
    const pk = indexNamed("PRIMARY")!;
    expect(pk.is_primary).toBe(true);
    expect(pk.is_unique).toBe(true);
    expect(pk.columns).toEqual(["id"]);
  });

  it("groups + orders a composite index by SEQ_IN_INDEX", () => {
    const idx = indexNamed("events_tenant_created_idx")!;
    expect(idx.columns).toEqual(["tenant_id", "created_at"]);
    expect(idx.is_partial).toBe(false);
    expect(idx.predicate).toBeNull();
  });

  it("harvests a unique secondary index", () => {
    const idx = indexNamed("events_email_uq")!;
    expect(idx.is_unique).toBe(true);
    expect(idx.columns).toEqual(["email"]);
  });

  it("harvests a single-column non-unique index", () => {
    const idx = indexNamed("events_status_idx")!;
    expect(idx.is_unique).toBe(false);
    expect(idx.columns).toEqual(["status"]);
  });
});
