/**
 * Tests for the `openapi-generic` catalog row: the boot seed
 * (`catalog-seed.ts`), the config-schema invariants the install + encryption
 * depend on, and migration 0108 ↔ code alignment (#2926, AC1/AC3).
 */

import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  seedOpenApiDatasourceCatalog,
  type OpenApiDatasourceCatalogSeedDb,
} from "../catalog-seed";
import {
  OPENAPI_GENERIC_CATALOG_ID,
  OPENAPI_GENERIC_SLUG,
  OPENAPI_GENERIC_CONFIG_SCHEMA,
} from "../catalog";

function captureDb(returnedRows: Array<{ slug: string }>): {
  db: OpenApiDatasourceCatalogSeedDb;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: OpenApiDatasourceCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: returnedRows as T[] };
    },
  };
  return { db, calls };
}

describe("seedOpenApiDatasourceCatalog", () => {
  it("INSERTs the openapi-generic datasource-pillar row with the canonical id + schema", async () => {
    const { db, calls } = captureDb([{ slug: OPENAPI_GENERIC_SLUG }]);
    const result = await seedOpenApiDatasourceCatalog(db);

    expect(result.inserted).toBe(true);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toContain("INSERT INTO plugin_catalog");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("'datasource'"); // type + pillar literals
    expect(sql).toContain("'form'");
    expect(params?.[0]).toBe(OPENAPI_GENERIC_CATALOG_ID);
    expect(params?.[2]).toBe(OPENAPI_GENERIC_SLUG);
    // config_schema serialized as the canonical array.
    const schema = JSON.parse(params?.[4] as string);
    expect(schema).toEqual(OPENAPI_GENERIC_CONFIG_SCHEMA);
  });

  it("reports inserted:false when the row already existed (ON CONFLICT DO NOTHING)", async () => {
    const { db } = captureDb([]); // no RETURNING rows = conflict path
    const result = await seedOpenApiDatasourceCatalog(db);
    expect(result.inserted).toBe(false);
  });
});

describe("OPENAPI_GENERIC_CONFIG_SCHEMA invariants", () => {
  it("marks auth_value as the sole secret field (drives encryptSecretFields)", () => {
    const secretKeys = OPENAPI_GENERIC_CONFIG_SCHEMA.filter((f) => f.secret === true).map((f) => f.key);
    expect(secretKeys).toEqual(["auth_value"]);
  });

  it("requires openapi_url + auth_kind", () => {
    const required = OPENAPI_GENERIC_CONFIG_SCHEMA.filter((f) => f.required === true).map((f) => f.key).sort();
    expect(required).toEqual(["auth_kind", "openapi_url"]);
  });

  it("models auth_kind as a select with the full enum", () => {
    const authKind = OPENAPI_GENERIC_CONFIG_SCHEMA.find((f) => f.key === "auth_kind");
    expect(authKind?.type).toBe("select");
    expect(authKind?.options).toEqual(["none", "bearer", "basic", "apikey-header", "apikey-query", "oauth2"]);
  });
});

describe("migration 0108 ↔ code alignment", () => {
  /** Extract the JSONB config_schema array literal from the migration SQL. */
  function migrationConfigSchema(): unknown {
    const sql = fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "db", "migrations", "0108_openapi_generic_catalog.sql"),
      "utf8",
    );
    const start = sql.indexOf("'[");
    const end = sql.indexOf("]'::jsonb");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // The literal is single-quoted SQL; unescape doubled single-quotes ('' -> ').
    const jsonText = sql.slice(start + 1, end + 1).replace(/''/g, "'");
    return JSON.parse(jsonText);
  }

  it("the migration's config_schema matches OPENAPI_GENERIC_CONFIG_SCHEMA", () => {
    expect(migrationConfigSchema()).toEqual(OPENAPI_GENERIC_CONFIG_SCHEMA);
  });

  it("the migration seeds the canonical id + slug", () => {
    const sql = fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "db", "migrations", "0108_openapi_generic_catalog.sql"),
      "utf8",
    );
    expect(sql).toContain(OPENAPI_GENERIC_CATALOG_ID);
    expect(sql).toContain("'openapi-generic'");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });
});
