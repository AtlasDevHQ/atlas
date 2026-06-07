/**
 * Tests for {@link DatasourceFormInstallHandler} (#3300) — the reusable
 * datasource form-install handler extracted from the ES handler (#3270) and
 * registered for ClickHouse / Snowflake / BigQuery.
 *
 * The ES specialization keeps its own characterization suite
 * (`elasticsearch-form-handler.test.ts`); this file pins the generic across the
 * SQL datasources whose `config_schema` has a different secret-field shape:
 *
 *   - ClickHouse — single `secret: true` field is the connection `url` itself
 *     (the whole URL carries the credential, unlike ES where only `apiKey` is
 *     secret and the `url` is plaintext).
 *   - BigQuery — `service_account_json` is secret, `project_id` is a required
 *     non-secret field that must survive plaintext.
 *
 * The catalog `config_schema` is read live from `plugin_catalog`, so the handler
 * encrypts whatever the schema marks `secret: true` with no per-type branch —
 * these tests assert that schema-driven behavior holds for both shapes.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret, encryptSecret } from "@atlas/api/lib/db/secret-encryption";
import { MASKED_PLACEHOLDER } from "@atlas/api/lib/plugins/secrets";
import type { WorkspaceId } from "@useatlas/types";

/** ClickHouse catalog schema — the `url` is the `secret: true` field. */
const CLICKHOUSE_CONFIG_SCHEMA = [
  { key: "url", type: "string", label: "Connection URL", required: true, secret: true },
  { key: "description", type: "string", label: "Description" },
];

/** BigQuery catalog schema — `service_account_json` is secret, `project_id` is not. */
const BIGQUERY_CONFIG_SCHEMA = [
  {
    key: "service_account_json",
    type: "string",
    label: "Service Account JSON",
    required: true,
    secret: true,
  },
  { key: "project_id", type: "string", label: "GCP Project ID", required: true },
  { key: "description", type: "string", label: "Description" },
];

/** Resolve the schema the mock returns, keyed off the slug ($1 of the catalog query). */
const SCHEMA_BY_SLUG: Record<string, unknown> = {
  clickhouse: CLICKHOUSE_CONFIG_SCHEMA,
  bigquery: BIGQUERY_CONFIG_SCHEMA,
};

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

let captured: CapturedQuery[] = [];
/** Per-test override for the existing-install lookup (restore-on-save path). */
let existingInstallRows: unknown[] = [];
/** Per-test override for the catalog row's config_schema (corrupt-schema path). */
let catalogSchemaOverride: { value: unknown } | null = null;

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    if (sql.includes("FROM plugin_catalog")) {
      const slug = (params?.[0] as string | undefined) ?? "clickhouse";
      const config_schema = catalogSchemaOverride
        ? catalogSchemaOverride.value
        : SCHEMA_BY_SLUG[slug] ?? CLICKHOUSE_CONFIG_SCHEMA;
      return [{ id: `catalog:${slug}`, config_schema }];
    }
    if (sql.includes("INSERT INTO workspace_plugins")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    // Existing-install lookup (FROM workspace_plugins ... config).
    return existingInstallRows;
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

// Mock EVERY value export of the logger module — a partial mock.module() trips
// "Export not found" on a transitive import (CLAUDE.md).
const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogInfo: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogger = {
  warn: mockLogWarn,
  info: mockLogInfo,
  debug: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  child: () => mockLogger,
};
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => mockLogger,
  getLogger: () => mockLogger,
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => undefined,
  setLogLevel: () => true,
  scrubErrSerializer: (v: unknown) => v,
  scrubLogFormatter: (obj: Record<string, unknown>) => obj,
  hashShareToken: (token: string) => token.slice(0, 16),
  redactPaths: [] as string[],
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler"] as const,
}));

const WSID = "ws-ds-1" as WorkspaceId;

type HandlerCtor = typeof import("../datasource-form-handler").DatasourceFormInstallHandler;
type FormErrCtor = typeof import("../email-form-handler").FormInstallValidationError;
let DatasourceFormInstallHandler!: HandlerCtor;
let FormInstallValidationError!: FormErrCtor;

beforeAll(async () => {
  DatasourceFormInstallHandler = (await import("../datasource-form-handler"))
    .DatasourceFormInstallHandler;
  FormInstallValidationError = (await import("../email-form-handler")).FormInstallValidationError;
});

const ORIGINAL_ENV = { ...process.env };

function setKeys(): void {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-for-ds-handler-unit-tests-long-enough-32bytes";
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ATLAS_DEPLOY_MODE;
  _resetEncryptionKeyCache();
}

function newHandler(
  slug: string,
  installId: string = slug,
  idGenerator: () => string = () => `${slug}-install-1`,
) {
  return new DatasourceFormInstallHandler({ slug, installId, idGenerator });
}

/** The config blob written by the (single) upsert INSERT, parsed from JSON. */
function upsertedConfig(): Record<string, unknown> {
  const insert = captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"));
  if (!insert) throw new Error("no INSERT captured");
  const json = insert.params[4] as string;
  return JSON.parse(json) as Record<string, unknown>;
}

beforeEach(() => {
  setKeys();
  captured = [];
  existingInstallRows = [];
  catalogSchemaOverride = null;
  mockLogWarn.mockClear();
  mockLogInfo.mockClear();
  mockInternalQuery.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("DatasourceFormInstallHandler — validation", () => {
  it("rejects a missing required url (ClickHouse) with per-field detail", async () => {
    const handler = newHandler("clickhouse");
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, { description: "no url" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<FormErrCtor>).fieldErrors.url).toBeDefined();
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });

  it("rejects a non-object body", async () => {
    const handler = newHandler("clickhouse");
    await expect(handler.validateConfig(WSID, "not-an-object")).rejects.toBeInstanceOf(
      FormInstallValidationError,
    );
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });
});

// ── Persistence + encryption (ClickHouse — the url IS the secret) ─────────────

describe("DatasourceFormInstallHandler — ClickHouse persistence + encryption", () => {
  it("inserts a datasource-pillar row keyed on the slug install id and encrypts the url", async () => {
    const handler = newHandler("clickhouse", "clickhouse", () => "ch-uuid-1");
    const result = await handler.validateConfig(WSID, {
      url: "clickhouse://user:pass@host:8443/analytics",
      description: "Prod ClickHouse",
    });

    expect(result.installRecord).toEqual({
      id: "ch-uuid-1",
      workspaceId: WSID,
      catalogId: "clickhouse",
    });
    expect(result.credentialWritten).toBe(true);

    const insert = captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("'datasource'");
    expect(insert!.sql).toContain("ON CONFLICT (workspace_id, catalog_id, install_id)");
    // install_id ($4) is the slug for these single-instance datasources.
    expect(insert!.params[3]).toBe("clickhouse");
    // catalog_id ($3) is read live from the catalog row.
    expect(insert!.params[2]).toBe("catalog:clickhouse");

    const cfg = upsertedConfig();
    // The url is `secret: true` here — it must be encrypted at rest (it carries
    // the credential), unlike ES where the url is plaintext.
    expect(typeof cfg.url).toBe("string");
    expect((cfg.url as string).startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(cfg.url as string)).toBe("clickhouse://user:pass@host:8443/analytics");
    // Non-secret description stays plaintext.
    expect(cfg.description).toBe("Prod ClickHouse");
  });
});

// ── Persistence + encryption (BigQuery — JSON secret + plaintext project_id) ──

describe("DatasourceFormInstallHandler — BigQuery persistence + encryption", () => {
  it("encrypts service_account_json and persists project_id in plaintext", async () => {
    const handler = newHandler("bigquery", "bigquery", () => "bq-uuid-1");
    const serviceAccount = JSON.stringify({ type: "service_account", project_id: "atlas-bq" });
    const result = await handler.validateConfig(WSID, {
      service_account_json: serviceAccount,
      project_id: "atlas-bq",
    });

    expect(result.installRecord.catalogId).toBe("bigquery");
    expect(result.credentialWritten).toBe(true);

    const cfg = upsertedConfig();
    // The secret service account JSON encrypts and round-trips.
    expect(typeof cfg.service_account_json).toBe("string");
    expect((cfg.service_account_json as string).startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(cfg.service_account_json as string)).toBe(serviceAccount);
    // project_id is required-but-not-secret → persisted plaintext so the
    // resolver / createFromConfig (#3299) can read it directly.
    expect(cfg.project_id).toBe("atlas-bq");
  });

  it("rejects a missing required project_id", async () => {
    const handler = newHandler("bigquery");
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, {
        service_account_json: JSON.stringify({ type: "service_account" }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<FormErrCtor>).fieldErrors.project_id).toBeDefined();
  });
});

// ── Restore-on-save (the highest-risk piece, inherited from #3270) ────────────

describe("DatasourceFormInstallHandler — restore-on-save", () => {
  it("preserves the stored ClickHouse url when the masked sentinel is re-submitted", async () => {
    const storedCipher = encryptSecret("clickhouse://user:secret@old-host:8443/db");
    existingInstallRows = [{ config: { url: storedCipher, description: "old" } }];

    const handler = newHandler("clickhouse");
    // Admin edits the description but leaves the (masked) url untouched.
    await handler.validateConfig(WSID, {
      url: MASKED_PLACEHOLDER,
      description: "renamed",
    });

    const cfg = upsertedConfig();
    expect(cfg.description).toBe("renamed");
    expect(cfg.url).not.toBe(MASKED_PLACEHOLDER);
    expect(decryptSecret(cfg.url as string)).toBe("clickhouse://user:secret@old-host:8443/db");
  });

  it("replaces the stored secret when an explicit new value is submitted", async () => {
    const storedCipher = encryptSecret("clickhouse://user:secret@old-host:8443/db");
    existingInstallRows = [{ config: { url: storedCipher } }];

    const handler = newHandler("clickhouse");
    await handler.validateConfig(WSID, {
      url: "clickhouse://user:rotated@new-host:8443/db",
    });

    const cfg = upsertedConfig();
    expect(decryptSecret(cfg.url as string)).toBe("clickhouse://user:rotated@new-host:8443/db");
  });

  it("preserves the stored secret when the field is omitted from the form (dirty-fields save)", async () => {
    const storedCipher = encryptSecret("clickhouse://user:secret@old-host:8443/db");
    existingInstallRows = [{ config: { url: storedCipher, description: "old" } }];

    const handler = newHandler("clickhouse");
    const result = await handler.validateConfig(WSID, { description: "only-desc-changed" });

    const cfg = upsertedConfig();
    expect(cfg.description).toBe("only-desc-changed");
    // url was absent yet required — restored, so validation passes and it persists.
    expect(decryptSecret(cfg.url as string)).toBe("clickhouse://user:secret@old-host:8443/db");
    expect(result.credentialWritten).toBe(true);
  });

  it("fails closed (no INSERT) when the existing row's secret cannot be decrypted", async () => {
    const storedCipher = encryptSecret("clickhouse://user:secret@old-host:8443/db");
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:a-completely-different-key-than-the-encrypt-one-32b";
    _resetEncryptionKeyCache();
    existingInstallRows = [{ config: { url: storedCipher } }];

    const handler = newHandler("clickhouse");
    await expect(
      handler.validateConfig(WSID, { url: MASKED_PLACEHOLDER }),
    ).rejects.toThrow();
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });
});

// ── Corrupt-schema guard (fail closed) ────────────────────────────────────────

describe("DatasourceFormInstallHandler — corrupt catalog schema", () => {
  it("refuses the install (no INSERT) when the catalog config_schema is corrupt", async () => {
    catalogSchemaOverride = { value: "not-an-array" };
    const handler = newHandler("clickhouse");
    await expect(
      handler.validateConfig(WSID, { url: "clickhouse://h:8443/db" }),
    ).rejects.toThrow(/corrupt/i);
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });
});

// ── Catalog row missing / disabled ────────────────────────────────────────────

describe("DatasourceFormInstallHandler — catalog row missing", () => {
  it("throws (not a validation error) when no enabled catalog row exists", async () => {
    catalogSchemaOverride = null;
    // Force the catalog lookup to return no rows by using an unknown slug whose
    // mock returns []. We special-case via an empty existingInstallRows path: the
    // mock returns the catalog row for any slug, so instead drive the missing-row
    // branch by overriding the mock for this test.
    mockInternalQuery.mockImplementationOnce(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return []; // catalog lookup → no row
    });
    const handler = newHandler("clickhouse");
    await expect(
      handler.validateConfig(WSID, { url: "clickhouse://h:8443/db" }),
    ).rejects.toThrow(/not found or disabled/i);
  });
});

// ── SaaS keyset gate ──────────────────────────────────────────────────────────

describe("DatasourceFormInstallHandler — SaaS keyset gate", () => {
  it("refuses the install in SaaS mode with no encryption keyset (no plaintext persist)", async () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();

    const handler = newHandler("clickhouse");
    await expect(
      handler.validateConfig(WSID, { url: "clickhouse://h:8443/db" }),
    ).rejects.toThrow(/keyset/i);
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });
});
