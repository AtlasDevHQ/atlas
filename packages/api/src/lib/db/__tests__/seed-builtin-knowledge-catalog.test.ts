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
  BUILTIN_CONFLUENCE_CATALOG_ROW,
  BUILTIN_CONFLUENCE_DC_CATALOG_ROW,
  BUILTIN_ZENDESK_CATALOG_ROW,
  BUILTIN_SALESFORCE_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_INTERCOM_CATALOG_ROW,
  BUILTIN_FRONT_CATALOG_ROW,
  BUILTIN_HELPSCOUT_CATALOG_ROW,
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

describe("BUILTIN_CONFLUENCE_CATALOG_ROW (#4377)", () => {
  it("is the `confluence` form install: base URL + email + space key + secret token", () => {
    const row = BUILTIN_CONFLUENCE_CATALOG_ROW;
    expect(row.slug).toBe("confluence");
    expect(row.id).toBe("catalog:confluence");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("base_url");
    expect(keys).toContain("email");
    expect(keys).toContain("space_key");
    expect(keys).toContain("api_token");
    // Exactly one secret field: the API token (never echoed). The base URL,
    // email, and space key are non-secret config.
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "api_token",
    ]);
    for (const key of ["base_url", "email", "space_key", "api_token"]) {
      expect(row.configSchema.find((f) => f.key === key)?.required).toBe(true);
    }
  });
});

describe("BUILTIN_CONFLUENCE_DC_CATALOG_ROW (#4394)", () => {
  it("is the `confluence-datacenter` form install: base URL + space key + secret PAT, NO email", () => {
    const row = BUILTIN_CONFLUENCE_DC_CATALOG_ROW;
    expect(row.slug).toBe("confluence-datacenter");
    expect(row.id).toBe("catalog:confluence-datacenter");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("base_url");
    expect(keys).toContain("space_key");
    expect(keys).toContain("api_token");
    // A Server/DC PAT is a Bearer credential with no paired username — the
    // Cloud-only email field must be absent.
    expect(keys).not.toContain("email");
    // Exactly one secret field: the PAT (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "api_token",
    ]);
    for (const key of ["base_url", "space_key", "api_token"]) {
      expect(row.configSchema.find((f) => f.key === key)?.required).toBe(true);
    }
  });
});

describe("BUILTIN_ZENDESK_CATALOG_ROW (#4396)", () => {
  it("is the `zendesk` form install: subdomain + email + secret token, NO base URL", () => {
    const row = BUILTIN_ZENDESK_CATALOG_ROW;
    expect(row.slug).toBe("zendesk");
    expect(row.id).toBe("catalog:zendesk");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("subdomain");
    expect(keys).toContain("email");
    expect(keys).toContain("api_token");
    // Hosts are composed `*.zendesk.com` labels — no free-form URL field, and
    // no brand field: brands are enumerated at install time (one collection
    // per help-center-enabled brand).
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("brand_id");
    // Exactly one secret field: the API token (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "api_token",
    ]);
    for (const key of ["subdomain", "email", "api_token"]) {
      expect(row.configSchema.find((f) => f.key === key)?.required).toBe(true);
    }
  });
});

describe("BUILTIN_SALESFORCE_KNOWLEDGE_CATALOG_ROW (#4397)", () => {
  it("is the `salesforce-knowledge` form install: scope-only config, NO secret field", () => {
    const row = BUILTIN_SALESFORCE_KNOWLEDGE_CATALOG_ROW;
    expect(row.slug).toBe("salesforce-knowledge");
    expect(row.id).toBe("catalog:salesforce-knowledge");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("channel");
    expect(keys).toContain("article_object");
    expect(keys).toContain("description");
    // The tier's credential-model departure: the connector reuses the
    // workspace's existing Salesforce OAuth install (catalog:salesforce), so
    // this row collects NO secret and NO endpoint — zero secret fields.
    expect(row.configSchema.filter((f) => f.secret === true)).toEqual([]);
    expect(keys).not.toContain("api_token");
    expect(keys).not.toContain("base_url");
    // Every field is optional — an empty form installs the Knowledge__kav
    // default scope.
    expect(row.configSchema.filter((f) => f.required === true)).toEqual([]);
  });
});

describe("BUILTIN_INTERCOM_CATALOG_ROW (#4399)", () => {
  it("is the `intercom` form install: a required secret access_token + optional description, NO base URL", () => {
    const row = BUILTIN_INTERCOM_CATALOG_ROW;
    expect(row.slug).toBe("intercom");
    expect(row.id).toBe("catalog:intercom");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("access_token");
    expect(keys).toContain("description");
    // The access token is the only secret; the API host is a fixed vendor
    // constant, so there is no free-form base-URL field.
    expect(row.configSchema.find((f) => f.key === "access_token")?.secret).toBe(true);
    expect(row.configSchema.find((f) => f.key === "access_token")?.required).toBe(true);
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("subdomain");
  });
});

describe("BUILTIN_FRONT_CATALOG_ROW (#4400)", () => {
  it("is the `front` form install: a single secret Bearer token, NO base URL / KB field", () => {
    const row = BUILTIN_FRONT_CATALOG_ROW;
    expect(row.slug).toBe("front");
    expect(row.id).toBe("catalog:front");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("api_token");
    expect(keys).toContain("description");
    // Front's Core API is a fixed vendor host — no free-form URL field, and no
    // KB field: knowledge bases are enumerated at install time (one collection
    // per KB).
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("knowledge_base_id");
    // Exactly one secret field: the API token (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual(["api_token"]);
    expect(row.configSchema.find((f) => f.key === "api_token")?.required).toBe(true);
  });
});

describe("BUILTIN_HELPSCOUT_CATALOG_ROW (#4398)", () => {
  it("is the `helpscout` form install: a single secret Docs API key, NO host/subdomain", () => {
    const row = BUILTIN_HELPSCOUT_CATALOG_ROW;
    expect(row.slug).toBe("helpscout");
    expect(row.id).toBe("catalog:helpscout");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("api_key");
    expect(keys).toContain("description");
    // Fixed vendor host + auto-discovered sites — no free-form URL, no subdomain
    // field, no email (a single Docs API key is the whole credential).
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("subdomain");
    expect(keys).not.toContain("email");
    // Exactly one secret field: the Docs API key (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "api_key",
    ]);
    expect(row.configSchema.find((f) => f.key === "api_key")?.required).toBe(true);
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
      "confluence",
      "confluence-datacenter",
      "gitbook",
      "zendesk",
      "salesforce-knowledge",
      "intercom",
      "front",
      "helpscout",
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
    expect(fresh.insertedSlugs).toEqual([
      "okf-upload",
      "bundle-sync",
      "notion-knowledge",
      "confluence",
      "confluence-datacenter",
      "gitbook",
      "zendesk",
      "salesforce-knowledge",
      "intercom",
      "front",
      "helpscout",
    ]);
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

  void mock.module("@atlas/api/lib/db/internal", () => ({
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
