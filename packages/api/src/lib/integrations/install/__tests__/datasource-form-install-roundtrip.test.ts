/**
 * End-to-end roundtrip for a form-installed SQL plugin datasource (#3300):
 *
 *   install (DatasourceFormInstallHandler.validateConfig)
 *     → persist (encrypted config captured from the workspace_plugins upsert)
 *       → boot-register (decrypt + registerDatasourceInstall via the bridge)
 *         → query (the plugin connection the bridge built is queryable)
 *
 * This proves the slice's whole point: a workspace admin installs ClickHouse
 * from Admin → Connections, the credential lands encrypted, and after a reload
 * `loadSavedConnections` rebuilds a live, queryable connection from that row via
 * the plugin's `createFromConfig` (#3253/#3297). The handler and bridge are
 * exercised against the SAME encrypted blob, so a regression in either half
 * (handler persists the wrong shape, or the bridge can't rebuild it) fails here.
 *
 * The catalog `config_schema` is read live; we mock `internalQuery` to return
 * the ClickHouse schema (`url` is the `secret: true` field) and capture the
 * upserted config, then decrypt it exactly as `loadSavedConnections` does
 * before handing it to the bridge.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { WorkspaceId } from "@useatlas/types";

const CLICKHOUSE_CONFIG_SCHEMA = [
  { key: "url", type: "string", label: "Connection URL", required: true, secret: true },
  { key: "description", type: "string", label: "Description" },
];

interface CapturedQuery {
  sql: string;
  params: unknown[];
}
let captured: CapturedQuery[] = [];

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    if (sql.includes("FROM plugin_catalog")) {
      return [{ id: "catalog:clickhouse", config_schema: CLICKHOUSE_CONFIG_SCHEMA }];
    }
    if (sql.includes("INSERT INTO workspace_plugins")) {
      return [{ id: (params?.[0] as string | undefined) ?? "unknown" }];
    }
    return []; // no existing install (fresh)
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

// Logger — mock every value export (CLAUDE.md partial-mock rule).
const mockLogger = {
  warn: () => {},
  info: () => {},
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

// ── ConnectionRegistry seam — capture the built plugin connection ─────────────
interface BuiltConn {
  query(sql: string, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}
let registeredPlugin: {
  workspaceId: string;
  installId: string;
  conn: BuiltConn;
  dbType: string;
  validate?: unknown;
} | null = null;

mock.module("@atlas/api/lib/db/connection", () => ({
  connections: {
    hasDirectForWorkspace: mock(() => false),
    registerDirectForWorkspace: mock(
      (
        workspaceId: string,
        installId: string,
        conn: BuiltConn,
        dbType: string,
        _description?: string,
        validate?: unknown,
      ) => {
        registeredPlugin = { workspaceId, installId, conn, dbType, validate };
      },
    ),
    // Native-path seam (unused for clickhouse but referenced structurally).
    register: mock(() => {}),
    has: mock(() => false),
    registerForWorkspace: mock(() => {}),
    hasForWorkspace: mock(() => false),
  },
}));

// Plugin registry seam — a fake ClickHouse datasource plugin whose
// createFromConfig builds a queryable connection from the decrypted config.
let lastCreateFromConfigArg: Readonly<Record<string, unknown>> | null = null;
const fakeClickhousePlugin = {
  id: "clickhouse-datasource",
  types: ["datasource"],
  connection: {
    dbType: "clickhouse",
    parserDialect: "PostgresQL",
    forbiddenPatterns: [/\bINSERT\b/i],
    createFromConfig: (cfg: Readonly<Record<string, unknown>>): BuiltConn => {
      lastCreateFromConfigArg = cfg;
      return {
        query: async (_sql: string) => ({
          columns: ["count"],
          rows: [{ count: 42 }],
          // Echo the URL the plugin connected with so the test can assert the
          // decrypted credential reached the live connection.
          connectedUrl: cfg.url,
        }),
        close: async () => {},
      };
    },
  },
};
mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: { getAll: () => [fakeClickhousePlugin] },
}));

const WSID = "ws-roundtrip-1" as WorkspaceId;

type HandlerCtor = typeof import("../datasource-form-handler").DatasourceFormInstallHandler;
type BridgeModule = typeof import("@atlas/api/lib/db/datasource-registry-bridge");
let DatasourceFormInstallHandler!: HandlerCtor;
let bridge!: BridgeModule;

beforeAll(async () => {
  DatasourceFormInstallHandler = (await import("../datasource-form-handler"))
    .DatasourceFormInstallHandler;
  bridge = await import("@atlas/api/lib/db/datasource-registry-bridge");
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:roundtrip-test-key-long-enough-to-be-32-bytes!!";
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ATLAS_DEPLOY_MODE;
  _resetEncryptionKeyCache();
  captured = [];
  registeredPlugin = null;
  lastCreateFromConfigArg = null;
  mockInternalQuery.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

describe("ClickHouse form-install roundtrip — install → persist → boot-register → query", () => {
  it("rebuilds a queryable connection from the persisted, encrypted install row", async () => {
    const url = "clickhouse://reader:s3cret@ch.example.com:8443/analytics";

    // 1. INSTALL — admin submits the form.
    const handler = new DatasourceFormInstallHandler({
      slug: "clickhouse",
      installId: "clickhouse",
      idGenerator: () => "ch-install-roundtrip",
    });
    const result = await handler.validateConfig(WSID, { url, description: "Prod CH" });
    expect(result.credentialWritten).toBe(true);

    // 2. PERSIST — read back the encrypted config blob from the captured upsert.
    const insert = captured.find((q) => q.sql.includes("INSERT INTO workspace_plugins"));
    expect(insert).toBeDefined();
    const persistedConfig = JSON.parse(insert!.params[4] as string) as Record<string, unknown>;
    expect((persistedConfig.url as string).startsWith("enc:v1:")).toBe(true);

    // 3. BOOT-REGISTER — exactly what `loadSavedConnections` does: decrypt the
    // schema-marked secrets, then hand (row, decryptedConfig) to the bridge.
    const schema = parseConfigSchema(CLICKHOUSE_CONFIG_SCHEMA);
    const decrypted = decryptSecretFields(persistedConfig, schema);
    expect(decrypted.url).toBe(url); // decrypts back to the submitted credential

    const fresh = await bridge.registerDatasourceInstall(
      {
        workspaceId: WSID,
        catalogId: "catalog:clickhouse",
        installId: "clickhouse",
        pillar: "datasource",
        catalogSlug: "clickhouse",
      },
      decrypted,
    );
    expect(fresh).toBe(true);

    // The plugin's runtime factory received the DECRYPTED config (not ciphertext).
    expect(lastCreateFromConfigArg).toMatchObject({ url });
    expect(registeredPlugin).not.toBeNull();
    expect(registeredPlugin!.dbType).toBe("clickhouse");
    expect(registeredPlugin!.workspaceId).toBe(WSID);
    expect(registeredPlugin!.installId).toBe("clickhouse");

    // 4. QUERY — the registered connection is live and returns rows.
    const queryResult = (await registeredPlugin!.conn.query("SELECT count() FROM events")) as {
      columns: string[];
      rows: Array<Record<string, unknown>>;
      connectedUrl: string;
    };
    expect(queryResult.columns).toEqual(["count"]);
    expect(queryResult.rows).toEqual([{ count: 42 }]);
    // The credential that round-tripped install → persist(encrypted) → decrypt →
    // createFromConfig is the one the live connection actually uses.
    expect(queryResult.connectedUrl).toBe(url);
  });
});
