/**
 * Tests for the built-in Knowledge Base catalog seed pass (#4206, ADR-0028).
 *
 * Two surfaces under test:
 *
 *  1. `seedBuiltinKnowledgeCatalog(db)` — the runtime seeder. Asserts the
 *     built-in rows (`okf-upload` #4206, `bundle-sync` #4211) are inserted with
 *     `ON CONFLICT DO NOTHING` semantics through the operator-curated seam,
 *     with the ADR-0028 §5 shape (type `context`, pillar `knowledge`,
 *     install_model `form`).
 *
 *  2. `BUILTIN_KNOWLEDGE_CATALOG_ROW(S)` — the in-process source of truth.
 *     Asserts content-level invariants (okf-upload credential-less; bundle-sync
 *     endpoint config with exactly one secret field).
 *
 * The migration/CHECK interaction is checked end-to-end by `migrate-pg.test.ts`
 * against a real Postgres; here we exercise the boot-time seed against an
 * in-memory mock pool.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  seedBuiltinKnowledgeCatalog,
  BUILTIN_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_BUNDLE_SYNC_CATALOG_ROW,
  BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_KNOWLEDGE_CATALOG_ROWS,
  type BuiltinKnowledgeCatalogSeedDb,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Mock pool: when `insert` is true every INSERT "succeeds" (RETURNING echoes
 * the bound slug param); when false every row "already exists" (empty
 * RETURNING — the ON CONFLICT DO NOTHING path).
 */
const captureDb = (
  insert = true,
): { db: BuiltinKnowledgeCatalogSeedDb; captured: CapturedQuery[] } => {
  const captured: CapturedQuery[] = [];
  const db: BuiltinKnowledgeCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      captured.push({ sql, params: params ?? [] });
      return { rows: insert ? ([{ slug: params?.[2] }] as T[]) : [] };
    },
  };
  return { db, captured };
};

describe("BUILTIN_KNOWLEDGE_CATALOG_ROW", () => {
  it("is the credential-less `okf-upload` form install (ADR-0028 §5)", () => {
    const row = BUILTIN_KNOWLEDGE_CATALOG_ROW;
    expect(row.slug).toBe("okf-upload");
    expect(row.id).toBe("catalog:okf-upload");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    // No credentials: no field is flagged secret.
    expect(row.configSchema.every((f) => f.secret !== true)).toBe(true);
  });

  it("uses the `catalog:<slug>` id convention", () => {
    for (const row of BUILTIN_KNOWLEDGE_CATALOG_ROWS) {
      expect(row.id).toBe(`catalog:${row.slug}`);
    }
  });
});

describe("BUILTIN_BUNDLE_SYNC_CATALOG_ROW (#4211)", () => {
  it("is the `bundle-sync` form install: endpoint + auth config, secret flagged", () => {
    const row = BUILTIN_BUNDLE_SYNC_CATALOG_ROW;
    expect(row.slug).toBe("bundle-sync");
    expect(row.id).toBe("catalog:bundle-sync");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("endpoint_url");
    expect(keys).toContain("auth_scheme");
    expect(keys).toContain("auth_secret");
    // Exactly one secret field: the auth secret (rendered as a password
    // input, never echoed) — the endpoint URL itself is not secret.
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "auth_secret",
    ]);
    const endpoint = row.configSchema.find((f) => f.key === "endpoint_url");
    expect(endpoint?.required).toBe(true);
  });
});

describe("BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW (#4378)", () => {
  it("is the `notion-knowledge` form install: required token (secret), optional description", () => {
    const row = BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW;
    expect(row.slug).toBe("notion-knowledge");
    expect(row.id).toBe("catalog:notion-knowledge");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("integration_token");
    expect(keys).toContain("description");
    // No endpoint/auth-scheme fields — the shared pages ARE the scope.
    expect(keys).not.toContain("endpoint_url");
    // Exactly one secret field: the integration token (password input, never
    // echoed), and it is required.
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "integration_token",
    ]);
    expect(row.configSchema.find((f) => f.key === "integration_token")?.required).toBe(true);
  });
});

describe("seedBuiltinKnowledgeCatalog (idempotent boot seed)", () => {
  it("issues one INSERT per built-in row with type 'context' and pillar 'knowledge'", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinKnowledgeCatalog(db);
    expect(captured).toHaveLength(BUILTIN_KNOWLEDGE_CATALOG_ROWS.length);
    for (const q of captured) {
      expect(q.sql).toContain("INSERT INTO plugin_catalog");
      expect(q.sql).toContain("'context'");
      expect(q.sql).toContain("'knowledge'");
      // Unqualified ON CONFLICT DO NOTHING covers both the slug unique index
      // AND the id PK (mirrors the datasource seed's edge-case handling).
      expect(q.sql).toContain("ON CONFLICT DO NOTHING");
      expect(q.sql).not.toContain("ON CONFLICT (slug)");
      expect(q.sql).toContain("RETURNING slug");
    }
    expect(captured.map((q) => q.params[2])).toEqual([
      "okf-upload",
      "bundle-sync",
      "notion-knowledge",
    ]);
  });

  it("binds each row's 8 params and serializes config_schema as JSON", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinKnowledgeCatalog(db);
    captured.forEach((q, i) => {
      expect(q.params).toHaveLength(8);
      const configParam = q.params[7];
      expect(typeof configParam).toBe("string");
      expect(JSON.parse(configParam as string)).toEqual(
        BUILTIN_KNOWLEDGE_CATALOG_ROWS[i]!.configSchema,
      );
    });
  });

  it("reports inserted slugs on a fresh catalog and none on a re-boot", async () => {
    const fresh = await seedBuiltinKnowledgeCatalog(captureDb().db);
    expect(fresh.inserted).toBe(true);
    expect(fresh.insertedSlugs).toEqual(["okf-upload", "bundle-sync", "notion-knowledge"]);
    // Empty RETURNING = rows already existed (ON CONFLICT DO NOTHING path).
    const reboot = await seedBuiltinKnowledgeCatalog(captureDb(false).db);
    expect(reboot.inserted).toBe(false);
    expect(reboot.insertedSlugs).toEqual([]);
  });

  it("propagates DB errors instead of swallowing them", async () => {
    const failing: BuiltinKnowledgeCatalogSeedDb = {
      async query() {
        throw new Error("simulated pg error");
      },
    };
    await expect(seedBuiltinKnowledgeCatalog(failing)).rejects.toThrow(
      /simulated pg error/,
    );
  });
});

describe("runBuiltinKnowledgeCatalogSeedBoot (discriminated outcomes)", () => {
  const mockQuery = mock<
    (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  >(() => Promise.resolve({ rows: [{ slug: "okf-upload" }] }));

  let hasInternalDBReturns = true;

  mock.module("@atlas/api/lib/db/internal", () => ({
    hasInternalDB: () => hasInternalDBReturns,
    getInternalDB: () => ({ query: mockQuery }),
    _resetEncryptionKeyCache: () => {},
  }));

  afterEach(() => {
    mockQuery.mockClear();
    hasInternalDBReturns = true;
  });

  it("returns `{ kind: 'skipped' }` when no internal DB is configured", async () => {
    hasInternalDBReturns = false;
    const { runBuiltinKnowledgeCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-knowledge-catalog"
    );
    const result = await runBuiltinKnowledgeCatalogSeedBoot();
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("no-internal-db");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns `{ kind: 'seeded', inserted: true }` on a successful insert", async () => {
    hasInternalDBReturns = true;
    mockQuery.mockImplementation(() =>
      Promise.resolve({ rows: [{ slug: "okf-upload" }] }),
    );
    const { runBuiltinKnowledgeCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-knowledge-catalog"
    );
    const result = await runBuiltinKnowledgeCatalogSeedBoot();
    expect(result.kind).toBe("seeded");
    if (result.kind === "seeded") expect(result.inserted).toBe(true);
  });

  it("returns `{ kind: 'error' }` when the pool query throws", async () => {
    hasInternalDBReturns = true;
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("simulated pg failure")),
    );
    const { runBuiltinKnowledgeCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-knowledge-catalog"
    );
    const result = await runBuiltinKnowledgeCatalogSeedBoot();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("simulated pg failure");
    }
  });
});
