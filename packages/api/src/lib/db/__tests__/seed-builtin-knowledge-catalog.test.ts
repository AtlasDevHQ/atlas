/**
 * Tests for the built-in Knowledge Base catalog seed pass (#4206, ADR-0028).
 *
 * Two surfaces under test:
 *
 *  1. `seedBuiltinKnowledgeCatalog(db)` — the runtime seeder. Asserts the single
 *     `okf-upload` row is inserted with `ON CONFLICT DO NOTHING` semantics
 *     through the operator-curated seam, with the ADR-0028 §5 shape (type
 *     `context`, pillar `knowledge`, install_model `form`, no credentials).
 *
 *  2. `BUILTIN_KNOWLEDGE_CATALOG_ROW` — the in-process source of truth. Asserts
 *     content-level invariants.
 *
 * The migration/CHECK interaction is checked end-to-end by `migrate-pg.test.ts`
 * against a real Postgres; here we exercise the boot-time seed against an
 * in-memory mock pool.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  seedBuiltinKnowledgeCatalog,
  BUILTIN_KNOWLEDGE_CATALOG_ROW,
  type BuiltinKnowledgeCatalogSeedDb,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captureDb = (
  insertedSlugs: ReadonlyArray<string> = [BUILTIN_KNOWLEDGE_CATALOG_ROW.slug],
): { db: BuiltinKnowledgeCatalogSeedDb; captured: CapturedQuery[] } => {
  const captured: CapturedQuery[] = [];
  const db: BuiltinKnowledgeCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      captured.push({ sql, params: params ?? [] });
      return { rows: insertedSlugs.map((slug) => ({ slug })) as T[] };
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
    expect(BUILTIN_KNOWLEDGE_CATALOG_ROW.id).toBe(
      `catalog:${BUILTIN_KNOWLEDGE_CATALOG_ROW.slug}`,
    );
  });
});

describe("seedBuiltinKnowledgeCatalog (idempotent boot seed)", () => {
  it("issues a single INSERT with type 'context' and pillar 'knowledge'", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinKnowledgeCatalog(db);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("INSERT INTO plugin_catalog");
    expect(captured[0]!.sql).toContain("'context'");
    expect(captured[0]!.sql).toContain("'knowledge'");
    // Unqualified ON CONFLICT DO NOTHING covers both the slug unique index
    // AND the id PK (mirrors the datasource seed's edge-case handling).
    expect(captured[0]!.sql).toContain("ON CONFLICT DO NOTHING");
    expect(captured[0]!.sql).not.toContain("ON CONFLICT (slug)");
    expect(captured[0]!.sql).toContain("RETURNING slug");
  });

  it("binds the row's 8 params and serializes config_schema as JSON", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinKnowledgeCatalog(db);
    expect(captured[0]!.params).toHaveLength(8);
    const configParam = captured[0]!.params[7];
    expect(typeof configParam).toBe("string");
    expect(JSON.parse(configParam as string)).toEqual(
      BUILTIN_KNOWLEDGE_CATALOG_ROW.configSchema,
    );
  });

  it("reports inserted on a fresh catalog and preserved on a re-boot", async () => {
    const fresh = await seedBuiltinKnowledgeCatalog(captureDb().db);
    expect(fresh.inserted).toBe(true);
    // Empty RETURNING = row already existed (ON CONFLICT DO NOTHING path).
    const reboot = await seedBuiltinKnowledgeCatalog(captureDb([]).db);
    expect(reboot.inserted).toBe(false);
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
