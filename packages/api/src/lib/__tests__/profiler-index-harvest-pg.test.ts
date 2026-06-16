/**
 * LIVE-Postgres index harvest coverage (#3634, slice A-2).
 *
 * Seeds a dedicated source schema with single-column, composite, partial,
 * unique, and expression indexes, runs `profilePostgres`, and asserts the
 * harvested `TableProfile.indexes` carry ordered columns, the access method,
 * `is_unique` / `is_primary` / `is_partial`, and the partial predicate — i.e.
 * everything the YAML generator and prompt surfacing build on.
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset (CI sets it; opt in locally
 * with `bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { profilePostgres } from "@atlas/api/lib/profiler";
import type { IndexProfile, TableProfile } from "@useatlas/types";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  console.warn(
    "profiler-index-harvest-pg: TEST_DATABASE_URL unset — skipping live index harvest test (set it to opt in).",
  );
}

const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("profilePostgres — index harvest (live Postgres, #3634)", () => {
  const srcSchema = `idx_src_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: Pool;
  let profiles: TableProfile[];

  const byTable = (name: string): TableProfile =>
    profiles.find((p) => p.table_name === name)!;
  const indexNamed = (t: TableProfile, name: string): IndexProfile | undefined =>
    (t.indexes ?? []).find((i) => i.name === name);

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${srcSchema}"`);

    // Single-column + unique + composite + partial + expression indexes.
    await pool.query(`
      CREATE TABLE "${srcSchema}".events (
        id          bigserial PRIMARY KEY,
        tenant_id   uuid NOT NULL,
        created_at  timestamptz NOT NULL,
        status      text,
        email       text,
        deleted_at  timestamptz
      );
      CREATE INDEX events_status_idx ON "${srcSchema}".events (status);
      CREATE UNIQUE INDEX events_email_uq ON "${srcSchema}".events (email);
      CREATE INDEX events_tenant_created_idx ON "${srcSchema}".events (tenant_id, created_at);
      CREATE INDEX events_active_idx ON "${srcSchema}".events (status) WHERE deleted_at IS NULL;
      CREATE INDEX events_lower_email_idx ON "${srcSchema}".events (lower(email));
    `);

    const result = await profilePostgres({ url: TEST_DB_URL as string, schema: srcSchema });
    profiles = result.profiles;
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${srcSchema}" CASCADE`).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  it("harvests the primary-key index as unique + primary", () => {
    const events = byTable("events");
    const pk = (events.indexes ?? []).find((i) => i.is_primary);
    expect(pk).toBeDefined();
    expect(pk!.is_unique).toBe(true);
    expect(pk!.columns).toEqual(["id"]);
    expect(pk!.index_type).toBe("btree");
  });

  it("harvests a single-column btree index", () => {
    const idx = indexNamed(byTable("events"), "events_status_idx")!;
    expect(idx.columns).toEqual(["status"]);
    expect(idx.index_type).toBe("btree");
    expect(idx.is_unique).toBe(false);
    expect(idx.is_partial).toBe(false);
    expect(idx.predicate).toBeNull();
  });

  it("harvests a unique index", () => {
    const idx = indexNamed(byTable("events"), "events_email_uq")!;
    expect(idx.is_unique).toBe(true);
    expect(idx.columns).toEqual(["email"]);
  });

  it("harvests a composite index preserving column order", () => {
    const idx = indexNamed(byTable("events"), "events_tenant_created_idx")!;
    expect(idx.columns).toEqual(["tenant_id", "created_at"]);
  });

  it("harvests a partial index with its predicate", () => {
    const idx = indexNamed(byTable("events"), "events_active_idx")!;
    expect(idx.is_partial).toBe(true);
    expect(idx.predicate).toBeTruthy();
    expect(idx.predicate!.toLowerCase()).toContain("deleted_at is null");
    expect(idx.columns).toEqual(["status"]);
  });

  it("harvests an expression index rendering the expression text", () => {
    const idx = indexNamed(byTable("events"), "events_lower_email_idx")!;
    expect(idx.columns).toHaveLength(1);
    expect(idx.columns[0].toLowerCase()).toContain("lower(email)");
  });

  it("fails soft — index harvest never blocks profiling", () => {
    // The whole table profiled successfully (columns present) AND carried
    // indexes; a soft failure would have left indexes empty but columns intact.
    const events = byTable("events");
    expect(events.columns.length).toBeGreaterThan(0);
    expect((events.indexes ?? []).length).toBeGreaterThan(0);
  });
});
