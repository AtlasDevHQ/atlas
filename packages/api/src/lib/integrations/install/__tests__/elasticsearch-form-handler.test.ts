/**
 * Tests for {@link ElasticsearchFormInstallHandler} (#3270).
 *
 * Mirrors `openapi-generic-form-handler.test.ts`: validation rejection emits
 * {@link FormInstallValidationError} with per-field detail; the happy path
 * encrypts the `secret: true` field (`apiKey`), and upserts a
 * `datasource`-pillar `workspace_plugins` row.
 *
 * The highest-risk piece (#3270) is the mask-on-read / restore-on-save flow:
 * a re-save that carries the masked sentinel for `apiKey` MUST preserve the
 * stored credential (decrypts to the original), while an explicit new value
 * replaces it. Those are the load-bearing assertions below.
 *
 * The catalog `config_schema` is read live from `plugin_catalog`, so the
 * handler picks up future auth fields (Basic / CloudID / SigV4 — #3263–#3265)
 * the moment they land in the catalog row, with no handler change. The mock
 * returns the API-key-only schema the foundation (#3261) ships today.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret, encryptSecret } from "@atlas/api/lib/db/secret-encryption";
import { MASKED_PLACEHOLDER } from "@atlas/api/lib/plugins/secrets";
import type { WorkspaceId } from "@useatlas/types";

/** The API-key-only config schema the ES foundation (#3261) ships today. */
const ES_CONFIG_SCHEMA = [
  { key: "url", type: "string", label: "Connection URL", required: true },
  { key: "apiKey", type: "string", label: "API Key", required: true, secret: true },
  { key: "description", type: "string", label: "Description" },
];

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
      const config_schema = catalogSchemaOverride ? catalogSchemaOverride.value : ES_CONFIG_SCHEMA;
      return [{ id: "catalog:elasticsearch", config_schema }];
    }
    if (sql.includes("INSERT INTO workspace_plugins")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    // Existing-install lookup (FROM workspace_plugins ... config).
    return existingInstallRows;
  },
);

void mock.module("@atlas/api/lib/db/internal", () => ({
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
void mock.module("@atlas/api/lib/logger", () => ({
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

const WSID = "ws-es-1" as WorkspaceId;

type HandlerCtor = typeof import("../elasticsearch-form-handler").ElasticsearchFormInstallHandler;
type FormErrCtor = typeof import("../email-form-handler").FormInstallValidationError;
let ElasticsearchFormInstallHandler!: HandlerCtor;
let FormInstallValidationError!: FormErrCtor;
let DATASOURCE_INSTALL_ID_FIELD!: string;

beforeAll(async () => {
  ElasticsearchFormInstallHandler = (await import("../elasticsearch-form-handler"))
    .ElasticsearchFormInstallHandler;
  DATASOURCE_INSTALL_ID_FIELD = (await import("../datasource-form-handler"))
    .DATASOURCE_INSTALL_ID_FIELD;
  FormInstallValidationError = (await import("../email-form-handler")).FormInstallValidationError;
});

const ORIGINAL_ENV = { ...process.env };

function setKeys(): void {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-for-es-handler-unit-tests-long-enough-32bytes";
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ATLAS_DEPLOY_MODE;
  _resetEncryptionKeyCache();
}

function validForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "elasticsearch://es.example.com:9243",
    apiKey: "base64-encoded-api-key",
    ...overrides,
  };
}

function newHandler(idGenerator: () => string = () => "es-install-1") {
  return new ElasticsearchFormInstallHandler({ idGenerator });
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

describe("ElasticsearchFormInstallHandler — validation", () => {
  it("rejects a missing required url", async () => {
    const handler = newHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, { apiKey: "k" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<FormErrCtor>).fieldErrors.url).toBeDefined();
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });

  it("rejects a missing required apiKey on a fresh install", async () => {
    const handler = newHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, { url: "elasticsearch://es.example.com:9243" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<FormErrCtor>).fieldErrors.apiKey).toBeDefined();
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });
});

// ── Persistence + encryption ──────────────────────────────────────────────────

describe("ElasticsearchFormInstallHandler — persistence + encryption", () => {
  it("inserts a datasource-pillar row and encrypts apiKey at rest", async () => {
    const handler = newHandler(() => "es-uuid-1");
    const result = await handler.validateConfig(WSID, validForm());

    expect(result.installRecord).toEqual({
      id: "es-uuid-1",
      workspaceId: WSID,
      catalogId: "elasticsearch",
    });
    expect(result.credentialWritten).toBe(true);

    const insert = captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("'datasource'");
    expect(insert!.sql).toContain("ON CONFLICT (workspace_id, catalog_id, install_id)");
    // The ES subclass defaults install_id ($4) to its slug for the first install
    // (#3858) — pins that the production subclass wires `ELASTICSEARCH_INSTALL_ID`
    // through, not just the generic handler.
    expect(insert!.params[3]).toBe("elasticsearch");

    const cfg = upsertedConfig();
    // Non-secret url stays plaintext (DB ops grep-able).
    expect(cfg.url).toBe("elasticsearch://es.example.com:9243");
    // apiKey is encrypted at rest and decrypts to the submitted value.
    expect(typeof cfg.apiKey).toBe("string");
    expect((cfg.apiKey as string).startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(cfg.apiKey as string)).toBe("base64-encoded-api-key");
  });
});

// ── Multi-instance: ES + OpenSearch under one slug (#3858) ────────────────────
// The unified `@useatlas/elasticsearch` plugin serves BOTH engines under slug
// `elasticsearch`. A custom connection id on the ES form lets a second
// connection (e.g. an OpenSearch cluster) coexist with the first.
describe("ElasticsearchFormInstallHandler — multi-instance install id (#3858)", () => {
  it("routes a custom connection id to the upsert so OpenSearch coexists with Elasticsearch", async () => {
    const handler = newHandler(() => "es-uuid-2");
    const result = await handler.validateConfig(
      WSID,
      validForm({ [DATASOURCE_INSTALL_ID_FIELD]: "opensearch-logs" }),
    );
    const insert = captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"));
    expect(insert!.params[3]).toBe("opensearch-logs");
    // The user-facing record's catalogId stays the slug; the row keys on the
    // custom install id, so it's a distinct connection from the first install.
    expect(result.installRecord.catalogId).toBe("elasticsearch");
    // The reserved meta-field is stripped — never a config value.
    expect(upsertedConfig()[DATASOURCE_INSTALL_ID_FIELD]).toBeUndefined();
  });
});

// ── Restore-on-save (the highest-risk piece, #3270) ───────────────────────────

describe("ElasticsearchFormInstallHandler — restore-on-save", () => {
  it("preserves the stored secret when the masked sentinel is re-submitted", async () => {
    // Existing install: apiKey already encrypted at rest.
    const storedCipher = encryptSecret("the-original-api-key");
    existingInstallRows = [{ config: { url: "elasticsearch://old:9243", apiKey: storedCipher } }];

    const handler = newHandler();
    // Admin edits the URL but leaves the (masked) apiKey untouched.
    await handler.validateConfig(
      WSID,
      validForm({ url: "elasticsearch://new:9243", apiKey: MASKED_PLACEHOLDER }),
    );

    const cfg = upsertedConfig();
    expect(cfg.url).toBe("elasticsearch://new:9243");
    // The masked sentinel must NOT clear or persist the bullets — the original
    // credential is preserved (round-trips to the same plaintext).
    expect(cfg.apiKey).not.toBe(MASKED_PLACEHOLDER);
    expect(decryptSecret(cfg.apiKey as string)).toBe("the-original-api-key");
  });

  it("replaces the stored secret when an explicit new value is submitted", async () => {
    const storedCipher = encryptSecret("the-original-api-key");
    existingInstallRows = [{ config: { url: "elasticsearch://old:9243", apiKey: storedCipher } }];

    const handler = newHandler();
    await handler.validateConfig(WSID, validForm({ apiKey: "a-freshly-rotated-key" }));

    const cfg = upsertedConfig();
    expect(decryptSecret(cfg.apiKey as string)).toBe("a-freshly-rotated-key");
  });

  it("preserves the stored secret when apiKey is omitted from the form (dirty-fields save)", async () => {
    // A UI that PATCHes only changed fields omits the untouched apiKey entirely.
    // restoreMaskedSecrets' absent-key branch must preserve it — never clear it.
    const storedCipher = encryptSecret("the-original-api-key");
    existingInstallRows = [{ config: { url: "elasticsearch://old:9243", apiKey: storedCipher } }];

    const handler = newHandler();
    const result = await handler.validateConfig(WSID, { url: "elasticsearch://new:9243" });

    const cfg = upsertedConfig();
    expect(cfg.url).toBe("elasticsearch://new:9243");
    // apiKey was absent from the form yet must still decrypt to the original —
    // required validation runs on the restored config so it isn't rejected.
    expect(decryptSecret(cfg.apiKey as string)).toBe("the-original-api-key");
    // credentialWritten reflects the restored (preserved) credential.
    expect(result.credentialWritten).toBe(true);
  });

  it("fails closed (no INSERT) when the existing row's secret cannot be decrypted", async () => {
    // Encrypt under the test key, then rotate the v1 key out from under it so
    // decryptSecretFields throws on read. A silently-empty config here would let
    // this re-save wipe the live credential — the handler must surface the error.
    const storedCipher = encryptSecret("the-original-api-key");
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:a-completely-different-key-than-the-encrypt-one-32b";
    _resetEncryptionKeyCache();
    existingInstallRows = [{ config: { url: "elasticsearch://old:9243", apiKey: storedCipher } }];

    const handler = newHandler();
    await expect(
      handler.validateConfig(WSID, validForm({ apiKey: MASKED_PLACEHOLDER })),
    ).rejects.toThrow();
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });
});

// ── Corrupt-schema guard (fail closed) ────────────────────────────────────────

describe("ElasticsearchFormInstallHandler — corrupt catalog schema", () => {
  it("refuses the install (no INSERT) when the catalog config_schema is corrupt", async () => {
    // A non-array config_schema (ops edit / migration typo) would make the
    // walkers act on every string and persist the mask sentinel as the
    // credential — the handler must reject instead.
    catalogSchemaOverride = { value: "not-an-array" };
    const handler = newHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(/corrupt/i);
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });
});

// ── SaaS keyset gate ──────────────────────────────────────────────────────────

describe("ElasticsearchFormInstallHandler — SaaS keyset gate", () => {
  it("refuses the install in SaaS mode with no encryption keyset (no plaintext persist)", async () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();

    const handler = newHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(/keyset/i);
    expect(captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });
});
