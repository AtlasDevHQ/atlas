/**
 * Tests for the data-candidate catalog seed (v0.0.2 slice 6a #3028, extended in
 * 6c #3030): per-row idempotency via a capturing mock db, per-candidate
 * install_model + config_schema binding, and migration ↔ code alignment for both
 * the Stripe (0109, form) and GitHub (0111, oauth-datasource) rows. Mirrors
 * `catalog-seed.test.ts` for the generic row.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { seedDataCandidateCatalog } from "../data-candidate-seed";
import type { OpenApiDatasourceCatalogSeedDb } from "../catalog-seed";
import {
  DATA_CANDIDATES,
  DATA_CANDIDATE_CONFIG_SCHEMA,
  GITHUB_DATA_CANDIDATE,
  OAUTH_DATASOURCE_CONFIG_SCHEMA,
  STRIPE_DATA_CANDIDATE,
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

/** Find the captured INSERT for a given candidate catalog id. */
function callForCatalogId(
  calls: Array<{ sql: string; params?: unknown[] }>,
  catalogId: string,
): { sql: string; params?: unknown[] } {
  const call = calls.find((c) => c.params?.[0] === catalogId);
  expect(call).toBeDefined();
  return call!;
}

describe("seedDataCandidateCatalog", () => {
  it("INSERTs each candidate row with its catalog id/slug + per-candidate install_model + config_schema", async () => {
    const { db, calls } = captureDb(() => [{ slug: "x" }]);
    const result = await seedDataCandidateCatalog(db);

    expect(result.insertedSlugs).toEqual(DATA_CANDIDATES.map((c) => c.slug));
    expect(calls).toHaveLength(DATA_CANDIDATES.length);

    // Common SQL shape (type + pillar are literals; install_model + config_schema bound).
    for (const { sql } of calls) {
      expect(sql).toContain("INSERT INTO plugin_catalog");
      expect(sql).toContain("ON CONFLICT DO NOTHING");
      expect(sql).toContain("'datasource'"); // type + pillar literals
    }

    // Stripe — a FORM candidate carrying the shared credential schema.
    const stripe = callForCatalogId(calls, STRIPE_DATA_CANDIDATE.catalogId);
    expect(stripe.params?.[2]).toBe(STRIPE_DATA_CANDIDATE.slug);
    expect(stripe.params?.[4]).toBe("form");
    expect(JSON.parse(stripe.params?.[5] as string)).toEqual(DATA_CANDIDATE_CONFIG_SCHEMA);

    // GitHub — an OAUTH-DATASOURCE candidate with an empty admin form schema.
    const github = callForCatalogId(calls, GITHUB_DATA_CANDIDATE.catalogId);
    expect(github.params?.[2]).toBe(GITHUB_DATA_CANDIDATE.slug);
    expect(github.params?.[4]).toBe("oauth-datasource");
    expect(JSON.parse(github.params?.[5] as string)).toEqual(OAUTH_DATASOURCE_CONFIG_SCHEMA);
  });

  it("reports no insertedSlugs when every row already existed (ON CONFLICT DO NOTHING)", async () => {
    const { db } = captureDb(() => []); // no RETURNING rows = conflict path for every row
    const result = await seedDataCandidateCatalog(db);
    expect(result.insertedSlugs).toEqual([]);
  });
});

describe("migration 0109 ↔ code alignment (stripe-data)", () => {
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
    const sql = migrationSql();
    const esc = (s: string) => s.replace(/'/g, "''");
    expect(sql).toContain(`'${esc(STRIPE_DATA_CANDIDATE.name)}'`);
    expect(sql).toContain(esc(STRIPE_DATA_CANDIDATE.description));
  });
});

describe("migration 0111 ↔ code alignment (github-data)", () => {
  function migrationSql(): string {
    return fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "db", "migrations", "0111_github_data_catalog.sql"),
      "utf8",
    );
  }

  it("widens the install_model CHECK to admit 'oauth-datasource'", () => {
    const sql = migrationSql();
    expect(sql).toContain("chk_plugin_catalog_install_model");
    expect(sql).toContain("'oauth-datasource'");
  });

  it("seeds the github-data canonical id + slug + install_model, idempotently", () => {
    const sql = migrationSql();
    expect(sql).toContain(GITHUB_DATA_CANDIDATE.catalogId);
    expect(sql).toContain("'github-data'");
    expect(sql).toContain("'oauth-datasource'");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });

  it("the migration's config_schema matches OAUTH_DATASOURCE_CONFIG_SCHEMA (empty form)", () => {
    const sql = migrationSql();
    // github-data has no admin form fields → the seeded config_schema is `[]`.
    const start = sql.indexOf("'[");
    const end = sql.indexOf("]'::jsonb");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const jsonText = sql.slice(start + 1, end + 1).replace(/''/g, "'");
    expect(JSON.parse(jsonText)).toEqual(OAUTH_DATASOURCE_CONFIG_SCHEMA);
  });

  it("the migration's name + description match the GITHUB_DATA_CANDIDATE registry literal", () => {
    const sql = migrationSql();
    const esc = (s: string) => s.replace(/'/g, "''");
    expect(sql).toContain(`'${esc(GITHUB_DATA_CANDIDATE.name)}'`);
    expect(sql).toContain(esc(GITHUB_DATA_CANDIDATE.description));
  });
});
