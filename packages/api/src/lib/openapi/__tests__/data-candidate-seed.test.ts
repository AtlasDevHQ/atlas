/**
 * Tests for the data-candidate catalog seed (v0.0.2 slice 6a, #3028): per-row
 * idempotency via a capturing mock db, and migration 0109 ↔ code alignment.
 * Mirrors `catalog-seed.test.ts` for the generic row.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { seedDataCandidateCatalog } from "../data-candidate-seed";
import type { OpenApiDatasourceCatalogSeedDb } from "../catalog-seed";
import {
  DATA_CANDIDATES,
  DATA_CANDIDATE_CONFIG_SCHEMA,
  STRIPE_DATA_CANDIDATE,
  NOTION_DATA_CANDIDATE,
} from "../data-candidates";

function captureDb(returnRowsPerCall: (callIndex: number) => Array<{ slug: string }>): {
  db: OpenApiDatasourceCatalogSeedDb;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: OpenApiDatasourceCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const rows = returnRowsPerCall(calls.length);
      calls.push({ sql, params });
      return { rows: rows as T[] };
    },
  };
  return { db, calls };
}

describe("seedDataCandidateCatalog", () => {
  it("INSERTs each candidate row with the canonical id/slug + shared schema", async () => {
    const { db, calls } = captureDb(() => [{ slug: STRIPE_DATA_CANDIDATE.slug }]);
    const result = await seedDataCandidateCatalog(db);

    expect(result.insertedSlugs).toEqual(DATA_CANDIDATES.map((c) => c.slug));
    expect(calls).toHaveLength(DATA_CANDIDATES.length);

    const { sql, params } = calls[0];
    expect(sql).toContain("INSERT INTO plugin_catalog");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("'datasource'"); // type + pillar literals
    expect(sql).toContain("'form'");
    expect(params?.[0]).toBe(STRIPE_DATA_CANDIDATE.catalogId);
    expect(params?.[2]).toBe(STRIPE_DATA_CANDIDATE.slug);
    expect(JSON.parse(params?.[4] as string)).toEqual(DATA_CANDIDATE_CONFIG_SCHEMA);
  });

  it("reports no insertedSlugs when every row already existed (ON CONFLICT DO NOTHING)", async () => {
    const { db } = captureDb(() => []); // no RETURNING rows = conflict path for every row
    const result = await seedDataCandidateCatalog(db);
    expect(result.insertedSlugs).toEqual([]);
  });
});

describe("migration 0109 ↔ code alignment", () => {
  function migrationSql(): string {
    return fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "db", "migrations", "0109_data_candidate_catalog.sql"),
      "utf8",
    );
  }

  it("the migration's config_schema matches DATA_CANDIDATE_CONFIG_SCHEMA", () => {
    const sql = migrationSql();
    const start = sql.indexOf("'[");
    const end = sql.indexOf("]'::jsonb");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const jsonText = sql.slice(start + 1, end + 1).replace(/''/g, "'");
    expect(JSON.parse(jsonText)).toEqual(DATA_CANDIDATE_CONFIG_SCHEMA);
  });

  it("the migration seeds the stripe-data canonical id + slug, idempotently", () => {
    const sql = migrationSql();
    expect(sql).toContain(STRIPE_DATA_CANDIDATE.catalogId);
    expect(sql).toContain("'stripe-data'");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });

  it("the migration's name + description match the STRIPE_DATA_CANDIDATE registry literal", () => {
    // On a fresh DB the migration row is authoritative (it runs before the boot
    // seed's `ON CONFLICT DO NOTHING`), so its name/description must not drift from
    // the registry — else the catalog card copy differs by deploy age. SQL doubles
    // a literal `'`, so escape before substring-matching.
    const sql = migrationSql();
    const esc = (s: string) => s.replace(/'/g, "''");
    expect(sql).toContain(`'${esc(STRIPE_DATA_CANDIDATE.name)}'`);
    expect(sql).toContain(esc(STRIPE_DATA_CANDIDATE.description));
  });
});

describe("migration 0110 ↔ code alignment (notion-data, slice 6b #3029)", () => {
  function migrationSql(): string {
    return fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "db", "migrations", "0110_notion_data_catalog.sql"),
      "utf8",
    );
  }

  it("the migration's config_schema matches the shared DATA_CANDIDATE_CONFIG_SCHEMA", () => {
    const sql = migrationSql();
    const start = sql.indexOf("'[");
    const end = sql.indexOf("]'::jsonb");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const jsonText = sql.slice(start + 1, end + 1).replace(/''/g, "'");
    expect(JSON.parse(jsonText)).toEqual(DATA_CANDIDATE_CONFIG_SCHEMA);
  });

  it("seeds the notion-data canonical id + slug, idempotently", () => {
    const sql = migrationSql();
    expect(sql).toContain(NOTION_DATA_CANDIDATE.catalogId);
    expect(sql).toContain("'notion-data'");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });

  it("the migration's name + description match the NOTION_DATA_CANDIDATE registry literal", () => {
    const sql = migrationSql();
    const esc = (s: string) => s.replace(/'/g, "''");
    expect(sql).toContain(`'${esc(NOTION_DATA_CANDIDATE.name)}'`);
    expect(sql).toContain(esc(NOTION_DATA_CANDIDATE.description));
  });
});
