/**
 * Tests for `DatasourcePoolResolver` — pure function that translates a
 * `workspace_plugins` row (with `pillar = 'datasource'`) plus a decrypted
 * config blob into the typed `DatasourcePoolConfig` shape ConnectionRegistry
 * will consume in slice 6 (#2744).
 *
 * This slice (#2743) ships the resolver inert — no production caller wires
 * it up; ConnectionRegistry still reads from the `connections` table. The
 * tests below pin the per-`db_type` translation contract so slice 6 can
 * pivot ConnectionRegistry without re-deriving the per-`db_type`
 * conventions (Postgres `search_path` init SQL, MySQL read-only session
 * var, ClickHouse `readonly: 1`, etc.).
 *
 * The decryption round-trip uses real `encryptSecretFields` /
 * `decryptSecretFields` against the catalog `config_schema` so the test
 * exercises the same path slice 6 will: row arrives with `url` ciphertext,
 * caller decrypts, resolver translates.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resolveDatasourcePoolConfig,
  type DatasourceWorkspacePluginRow,
  type DatasourcePoolConfig,
  BUILTIN_DATASOURCE_CATALOG_SLUGS,
  catalogSlugToDbType,
} from "@atlas/api/lib/db/datasource-pool-resolver";
import {
  encryptSecretFields,
  decryptSecretFields,
  type ConfigSchema,
} from "@atlas/api/lib/plugins/secrets";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/internal";

const baseRow = (
  catalogSlug: string,
  overrides: Partial<DatasourceWorkspacePluginRow> = {},
): DatasourceWorkspacePluginRow => ({
  workspaceId: "ws-1",
  catalogId: `catalog:${catalogSlug}`,
  installId: "prod-us",
  pillar: "datasource",
  catalogSlug,
  ...overrides,
});

const parsedSchema = (fields: { key: string; secret?: boolean }[]): ConfigSchema => ({
  state: "parsed",
  fields: fields.map((f) => ({
    key: f.key,
    type: "string",
    secret: f.secret ?? false,
  })),
});

describe("resolveDatasourcePoolConfig", () => {
  describe("catalog slug → db_type mapping", () => {
    it("maps `demo-postgres` to db_type `postgres`", () => {
      expect(catalogSlugToDbType("demo-postgres")).toBe("postgres");
    });

    it("maps each native catalog slug to the matching db_type", () => {
      const cases = [
        { slug: "postgres", dbType: "postgres" as const },
        { slug: "mysql", dbType: "mysql" as const },
        { slug: "snowflake", dbType: "snowflake" as const },
        { slug: "clickhouse", dbType: "clickhouse" as const },
        { slug: "bigquery", dbType: "bigquery" as const },
        { slug: "duckdb", dbType: "duckdb" as const },
        { slug: "salesforce", dbType: "salesforce" as const },
      ];
      for (const { slug, dbType } of cases) {
        expect(catalogSlugToDbType(slug)).toBe(dbType);
      }
    });

    it("rejects unknown catalog slugs", () => {
      expect(() => catalogSlugToDbType("oracle")).toThrow(
        /unknown built-in datasource catalog slug/i,
      );
    });

    it("covers every BUILTIN_DATASOURCE_CATALOG_SLUGS entry", () => {
      expect(BUILTIN_DATASOURCE_CATALOG_SLUGS).toHaveLength(8);
      for (const slug of BUILTIN_DATASOURCE_CATALOG_SLUGS) {
        catalogSlugToDbType(slug);
      }
    });
  });

  describe("pillar guard", () => {
    it("rejects rows where pillar is not `datasource`", () => {
      const row = baseRow("postgres");
      expect(() =>
        resolveDatasourcePoolConfig(
          { ...row, pillar: "action" as unknown as "datasource" },
          { url: "postgresql://x:y@localhost/db" },
        ),
      ).toThrow(/pillar must be 'datasource'/i);
    });
  });

  describe("postgres", () => {
    it("emits a PostgresPoolConfig with init SQL when `schema` is set", () => {
      const config = resolveDatasourcePoolConfig(baseRow("postgres"), {
        url: "postgresql://user:pw@localhost:5432/mydb",
        schema: "analytics",
        description: "US prod read replica",
      });
      expect(config.dbType).toBe("postgres");
      if (config.dbType !== "postgres") throw new Error("type narrowing");
      expect(config.url).toBe("postgresql://user:pw@localhost:5432/mydb");
      expect(config.schema).toBe("analytics");
      expect(config.description).toBe("US prod read replica");
      // search_path init SQL — quoted identifier, includes `public` fallback.
      expect(config.initSql).toEqual([
        `SET search_path TO "analytics", public`,
      ]);
    });

    it("omits init SQL when no schema (default search_path retained)", () => {
      const config = resolveDatasourcePoolConfig(baseRow("postgres"), {
        url: "postgresql://x:y@localhost/db",
      });
      if (config.dbType !== "postgres") throw new Error("type narrowing");
      expect(config.schema).toBeUndefined();
      expect(config.initSql).toEqual([]);
    });

    it("rejects schema values that aren't valid SQL identifiers", () => {
      expect(() =>
        resolveDatasourcePoolConfig(baseRow("postgres"), {
          url: "postgresql://x:y@localhost/db",
          schema: "drop table users; --",
        }),
      ).toThrow(/invalid schema/i);
    });

    it("treats `public` schema as a no-op (no init SQL)", () => {
      const config = resolveDatasourcePoolConfig(baseRow("postgres"), {
        url: "postgresql://x:y@localhost/db",
        schema: "public",
      });
      if (config.dbType !== "postgres") throw new Error("type narrowing");
      expect(config.initSql).toEqual([]);
    });

    it("emits the same shape for the `demo-postgres` catalog slug", () => {
      const config = resolveDatasourcePoolConfig(baseRow("demo-postgres"), {
        url: "postgresql://demo:demo@demo-host/demo",
        schema: "demo",
      });
      expect(config.dbType).toBe("postgres");
    });

    it("requires `url` in the decrypted config", () => {
      expect(() =>
        resolveDatasourcePoolConfig(baseRow("postgres"), {
          schema: "x",
        }),
      ).toThrow(/missing.+url/i);
    });
  });

  describe("mysql", () => {
    it("emits a MySQLPoolConfig with read-only session var init SQL", () => {
      const config = resolveDatasourcePoolConfig(baseRow("mysql"), {
        url: "mysql://user:pw@localhost:3306/mydb",
        description: "EU mysql",
      });
      expect(config.dbType).toBe("mysql");
      if (config.dbType !== "mysql") throw new Error("type narrowing");
      expect(config.url).toBe("mysql://user:pw@localhost:3306/mydb");
      expect(config.initSql).toEqual(["SET SESSION TRANSACTION READ ONLY"]);
      expect(config.description).toBe("EU mysql");
    });
  });

  describe("snowflake", () => {
    it("emits a SnowflakePoolConfig with no init SQL (defense-in-depth lives in plugin)", () => {
      const config = resolveDatasourcePoolConfig(baseRow("snowflake"), {
        url: "snowflake://user:pw@account/db/schema?warehouse=WH&role=ROLE",
        schema: "analytics",
      });
      expect(config.dbType).toBe("snowflake");
      if (config.dbType !== "snowflake") throw new Error("type narrowing");
      expect(config.url).toBe(
        "snowflake://user:pw@account/db/schema?warehouse=WH&role=ROLE",
      );
      expect(config.schema).toBe("analytics");
    });
  });

  describe("clickhouse", () => {
    it("emits a ClickHousePoolConfig flagging `readonly: 1`", () => {
      const config = resolveDatasourcePoolConfig(baseRow("clickhouse"), {
        url: "clickhouse://user:pw@host:8443/db",
      });
      expect(config.dbType).toBe("clickhouse");
      if (config.dbType !== "clickhouse") throw new Error("type narrowing");
      expect(config.url).toBe("clickhouse://user:pw@host:8443/db");
      expect(config.readonly).toBe(1);
    });
  });

  describe("bigquery", () => {
    it("emits a BigQueryPoolConfig with serviceAccountJson + projectId", () => {
      const config = resolveDatasourcePoolConfig(baseRow("bigquery"), {
        service_account_json: '{"type":"service_account","project_id":"x"}',
        project_id: "my-gcp-project",
        description: "GA exports",
      });
      expect(config.dbType).toBe("bigquery");
      if (config.dbType !== "bigquery") throw new Error("type narrowing");
      expect(config.serviceAccountJson).toBe(
        '{"type":"service_account","project_id":"x"}',
      );
      expect(config.projectId).toBe("my-gcp-project");
      expect(config.description).toBe("GA exports");
    });

    it("requires both serviceAccountJson and projectId", () => {
      expect(() =>
        resolveDatasourcePoolConfig(baseRow("bigquery"), {
          service_account_json: "{}",
        }),
      ).toThrow(/missing.+project_id/i);
      expect(() =>
        resolveDatasourcePoolConfig(baseRow("bigquery"), {
          project_id: "x",
        }),
      ).toThrow(/missing.+service_account_json/i);
    });
  });

  describe("duckdb", () => {
    it("emits a DuckDBPoolConfig with file path", () => {
      const config = resolveDatasourcePoolConfig(baseRow("duckdb"), {
        path: "/var/atlas/data/duck.db",
      });
      expect(config.dbType).toBe("duckdb");
      if (config.dbType !== "duckdb") throw new Error("type narrowing");
      expect(config.path).toBe("/var/atlas/data/duck.db");
    });

    it("requires `path` (no implicit `:memory:`)", () => {
      expect(() =>
        resolveDatasourcePoolConfig(baseRow("duckdb"), {}),
      ).toThrow(/missing.+path/i);
    });
  });

  describe("salesforce", () => {
    it("emits a SalesforcePoolConfig with description only (handler-managed creds)", () => {
      const config = resolveDatasourcePoolConfig(baseRow("salesforce"), {
        description: "CRM read access",
      });
      expect(config.dbType).toBe("salesforce");
      if (config.dbType !== "salesforce") throw new Error("type narrowing");
      expect(config.description).toBe("CRM read access");
    });

    it("does not require any config fields (creds live in integration_credentials)", () => {
      const config = resolveDatasourcePoolConfig(baseRow("salesforce"), {});
      expect(config.dbType).toBe("salesforce");
    });
  });

  describe("optional pool tuning fields", () => {
    it.each(["postgres", "mysql"] as const)(
      "passes maxConnections + idleTimeoutMs through for %s",
      (slug) => {
        const config = resolveDatasourcePoolConfig(baseRow(slug), {
          url:
            slug === "postgres"
              ? "postgresql://x:y@h/db"
              : "mysql://x:y@h/db",
          maxConnections: 25,
          idleTimeoutMs: 60_000,
        });
        if (config.dbType !== "postgres" && config.dbType !== "mysql") {
          throw new Error("type narrowing");
        }
        expect(config.maxConnections).toBe(25);
        expect(config.idleTimeoutMs).toBe(60_000);
      },
    );
  });

  describe("exhaustive coverage of supported dbTypes", () => {
    it("produces a PoolConfig for every BUILTIN_DATASOURCE_CATALOG_SLUGS entry", () => {
      const fixtures: Record<string, Record<string, unknown>> = {
        postgres: { url: "postgresql://x:y@h/db" },
        mysql: { url: "mysql://x:y@h/db" },
        snowflake: { url: "snowflake://x:y@a/d/s" },
        clickhouse: { url: "clickhouse://x:y@h/db" },
        bigquery: { service_account_json: "{}", project_id: "p" },
        duckdb: { path: "/tmp/x.db" },
        salesforce: {},
        "demo-postgres": { url: "postgresql://demo:demo@h/demo" },
      };
      const seen = new Set<DatasourcePoolConfig["dbType"]>();
      for (const slug of BUILTIN_DATASOURCE_CATALOG_SLUGS) {
        const config = resolveDatasourcePoolConfig(
          baseRow(slug),
          fixtures[slug] ?? {},
        );
        seen.add(config.dbType);
      }
      // Every built-in db_type produced at least one PoolConfig.
      expect(seen.size).toBe(7);
    });
  });
});

describe("DatasourcePoolResolver URL decryption round-trip", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;
  const savedAuth = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    process.env.ATLAS_ENCRYPTION_KEY = "atlas-test-pool-resolver-key";
    delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (savedAuth !== undefined) process.env.BETTER_AUTH_SECRET = savedAuth;
    else delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
  });

  it("decrypts an `enc:v1:` workspace_plugins.config blob and feeds the resolver", () => {
    // Catalog schema for built-in postgres row (matches slice-5 migration).
    const schema = parsedSchema([
      { key: "url", secret: true },
      { key: "schema" },
      { key: "description" },
    ]);

    const plaintext = {
      url: "postgresql://user:pw@prod-host:5432/atlas",
      schema: "events",
      description: "US production",
    };

    // Simulate persisted state: encrypted config in workspace_plugins.config.
    const encrypted = encryptSecretFields(plaintext, schema);
    expect(typeof encrypted.url).toBe("string");
    expect((encrypted.url as string).startsWith("enc:v1:")).toBe(true);
    // Non-secret fields stay plaintext (DB ops grep-able).
    expect(encrypted.schema).toBe("events");
    expect(encrypted.description).toBe("US production");

    // Read path: decrypt, then resolve into a PoolConfig.
    const decrypted = decryptSecretFields(encrypted, schema);
    expect(decrypted.url).toBe("postgresql://user:pw@prod-host:5432/atlas");

    const config = resolveDatasourcePoolConfig(baseRow("postgres"), decrypted);
    if (config.dbType !== "postgres") throw new Error("type narrowing");
    expect(config.url).toBe("postgresql://user:pw@prod-host:5432/atlas");
    expect(config.schema).toBe("events");
    expect(config.initSql).toEqual([
      `SET search_path TO "events", public`,
    ]);
  });

  it("decrypts the bigquery service_account_json blob and preserves projectId plaintext", () => {
    const schema = parsedSchema([
      { key: "service_account_json", secret: true },
      { key: "project_id" },
      { key: "description" },
    ]);
    const plaintext = {
      service_account_json: '{"type":"service_account","private_key":"-----BEGIN..."}',
      project_id: "analytics-prod-123",
      description: "GA4 + Search Console",
    };
    const encrypted = encryptSecretFields(plaintext, schema);
    expect((encrypted.service_account_json as string).startsWith("enc:v1:")).toBe(true);
    expect(encrypted.project_id).toBe("analytics-prod-123");

    const decrypted = decryptSecretFields(encrypted, schema);
    const config = resolveDatasourcePoolConfig(baseRow("bigquery"), decrypted);
    if (config.dbType !== "bigquery") throw new Error("type narrowing");
    expect(config.serviceAccountJson).toBe(plaintext.service_account_json);
    expect(config.projectId).toBe("analytics-prod-123");
  });
});
