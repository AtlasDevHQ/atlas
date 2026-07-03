/**
 * Tests for the installed-datasource load + secret-config decrypt seam
 * (#4194) — `lib/integrations/installed-connection.ts`.
 *
 * The contract pinned here (once, instead of per-route):
 *
 *   1. Decrypt-failure classification — `decryptStoredConfig` wraps any
 *      walker throw in `InstalledConfigDecryptError` so routes classify
 *      with `instanceof`, and the loaders degrade it to the
 *      `decrypt_failed` union state without losing row metadata.
 *   2. Masked-echo behavior — `applyConfigEdit` encodes the
 *      decrypt → restore-masked → encrypt → mask ordering: the persisted
 *      blob is freshly-encrypted plaintext (never the mask sentinel,
 *      never double-encrypted ciphertext) and the response echo contains
 *      neither plaintext secrets nor ciphertext.
 *   3. Predicates stated once — the loaders emit
 *      `pillar = 'datasource'` / `status != 'archived'` (toggled by
 *      `includeArchived`), and the demo probe pins its
 *      `__demo__` / `demo-postgres` / status-set shape.
 *
 * The underlying walkers (selective encryption, corrupt-schema
 * fail-closed, placeholder semantics) are covered by
 * `lib/plugins/__tests__/secrets.test.ts` + `secrets-encryption.test.ts`;
 * crypto is faked here so failures are triggerable deterministically.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mocks (all exports per testing discipline) ---

let mockQueryResult: Record<string, unknown>[] = [];
const capturedQueries: { sql: string; params: unknown[] }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: mock((sql: string, params: unknown[] = []) => {
    capturedQueries.push({ sql, params });
    return Promise.resolve(mockQueryResult);
  }),
}));

// Deterministic fake crypto: `enc:v1:test:<plaintext>` round-trips;
// `enc:v1:throw:<reason>` raises on decrypt (drives the failure paths).
mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  activeKeyVersion: () => "v1",
  UnknownKeyVersionError: class UnknownKeyVersionError extends Error {},
  hasVersionedPrefix: (stored: string) => stored.startsWith("enc:"),
  isPlaintextCredentialRisk: () => false,
  encryptSecret: (plaintext: string) => `enc:v1:test:${plaintext}`,
  decryptSecret: (stored: string) => {
    if (stored.startsWith("enc:v1:throw:")) {
      throw new Error(`mock decrypt failure: ${stored.slice("enc:v1:throw:".length)}`);
    }
    return stored.startsWith("enc:v1:test:") ? stored.slice("enc:v1:test:".length) : stored;
  },
}));

const logError = mock((..._args: unknown[]) => {});
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: logError, debug: () => {} }),
}));

const {
  InstalledConfigDecryptError,
  decryptStoredConfig,
  loadInstalledConnection,
  listInstalledConnections,
  countActiveDatasourceInstalls,
  datasourceGroupExists,
  applyConfigEdit,
  demoInstallActiveSql,
  isDemoInstallActive,
  DEMO_INSTALL_ID,
  DEMO_CATALOG_SLUG,
} = await import("../installed-connection");
const { parseConfigSchema, MASKED_PLACEHOLDER } = await import(
  "@atlas/api/lib/plugins/secrets"
);

// --- Fixtures ---

const SCHEMA = parseConfigSchema([
  { key: "apiKey", type: "string", secret: true },
  { key: "url", type: "string", secret: true },
  { key: "region", type: "string" },
]);

function installRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "row-1",
    catalog_id: "cat-ch",
    catalog_slug: "clickhouse",
    install_id: "warehouse",
    status: "published",
    group_id: "prod",
    config: { url: "enc:v1:test:clickhouse://u:p@host/db", region: "eu" },
    config_schema: [
      { key: "url", type: "string", secret: true },
      { key: "region", type: "string" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockQueryResult = [];
  capturedQueries.length = 0;
  logError.mockClear();
});

// --- decryptStoredConfig: failure classification stated once ---

describe("decryptStoredConfig", () => {
  it("decrypts secret fields and passes non-secrets through", () => {
    const out = decryptStoredConfig(
      { apiKey: "enc:v1:test:sk-live-1", region: "eu" },
      SCHEMA,
    );
    expect(out.apiKey).toBe("sk-live-1");
    expect(out.region).toBe("eu");
  });

  it("classifies a walker throw as InstalledConfigDecryptError, logs once, and preserves the cause", () => {
    let thrown: unknown;
    try {
      decryptStoredConfig({ apiKey: "enc:v1:throw:rotated-key" }, SCHEMA, {
        installId: "warehouse",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InstalledConfigDecryptError);
    const typed = thrown as InstanceType<typeof InstalledConfigDecryptError>;
    expect(typed.name).toBe("InstalledConfigDecryptError");
    expect(typed.message).toContain("mock decrypt failure");
    expect(typed.cause).toBeInstanceOf(Error);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

// --- applyConfigEdit: masked-echo behavior stated once ---

describe("applyConfigEdit", () => {
  const existing = { apiKey: "sk-live-1", url: "https://u:p@host", region: "eu" };

  it("restores an echoed placeholder to the stored plaintext, then freshly encrypts it", () => {
    const { persistConfig, responseConfig } = applyConfigEdit(
      existing,
      { apiKey: MASKED_PLACEHOLDER, url: MASKED_PLACEHOLDER, region: "us" },
      SCHEMA,
    );
    // Persisted: plaintext restored from `existing`, re-encrypted — never
    // the mask sentinel and never double-encrypted ciphertext.
    expect(persistConfig.apiKey).toBe("enc:v1:test:sk-live-1");
    expect(persistConfig.url).toBe("enc:v1:test:https://u:p@host");
    expect(persistConfig.region).toBe("us");
    // Echo: masked, plaintext-free, ciphertext-free.
    expect(responseConfig.apiKey).toBe(MASKED_PLACEHOLDER);
    expect(responseConfig.url).toBe(MASKED_PLACEHOLDER);
    expect(responseConfig.region).toBe("us");
    const echoed = JSON.stringify(responseConfig);
    expect(echoed).not.toContain("sk-live-1");
    expect(echoed).not.toContain("enc:v1:");
  });

  it("preserves a secret the caller omitted entirely (dirty-field saves)", () => {
    const { persistConfig, responseConfig } = applyConfigEdit(
      existing,
      { region: "us" },
      SCHEMA,
    );
    expect(persistConfig.apiKey).toBe("enc:v1:test:sk-live-1");
    expect(responseConfig.apiKey).toBe(MASKED_PLACEHOLDER);
  });

  it("trusts an explicit rotation and encrypts the new value", () => {
    const { persistConfig, responseConfig } = applyConfigEdit(
      existing,
      { apiKey: "sk-live-2", region: "eu" },
      SCHEMA,
    );
    expect(persistConfig.apiKey).toBe("enc:v1:test:sk-live-2");
    expect(responseConfig.apiKey).toBe(MASKED_PLACEHOLDER);
    expect(JSON.stringify(responseConfig)).not.toContain("sk-live-2");
  });

  it("fails closed on a corrupt schema — every string encrypted on persist, masked on echo", () => {
    const corrupt = parseConfigSchema("not-an-array");
    expect(corrupt.state).toBe("corrupt");
    const { persistConfig, responseConfig } = applyConfigEdit(
      { apiKey: "sk-live-1" },
      { apiKey: "sk-live-2", note: "plain" },
      corrupt,
    );
    expect(persistConfig.apiKey).toBe("enc:v1:test:sk-live-2");
    expect(persistConfig.note).toBe("enc:v1:test:plain");
    expect(responseConfig.apiKey).toBe(MASKED_PLACEHOLDER);
    expect(responseConfig.note).toBe(MASKED_PLACEHOLDER);
  });
});

// --- loadInstalledConnection ---

describe("loadInstalledConnection", () => {
  it("returns the typed struct with decrypted config for a found row", async () => {
    mockQueryResult = [installRow()];
    const conn = await loadInstalledConnection("org-1", "warehouse");
    expect(conn).not.toBeNull();
    expect(conn!.rowId).toBe("row-1");
    expect(conn!.catalogId).toBe("cat-ch");
    expect(conn!.catalogSlug).toBe("clickhouse");
    expect(conn!.installId).toBe("warehouse");
    expect(conn!.status).toBe("published");
    expect(conn!.groupId).toBe("prod");
    expect(conn!.configSchema.state).toBe("parsed");
    expect(conn!.config.state).toBe("decrypted");
    if (conn!.config.state === "decrypted") {
      expect(conn!.config.values.url).toBe("clickhouse://u:p@host/db");
      expect(conn!.config.values.region).toBe("eu");
    }
  });

  it("scopes by workspace + install_id with the pillar and not-archived predicates", async () => {
    mockQueryResult = [];
    await loadInstalledConnection("org-1", "warehouse");
    expect(capturedQueries).toHaveLength(1);
    const { sql, params } = capturedQueries[0];
    expect(sql).toContain("pillar = 'datasource'");
    expect(sql).toContain("status != 'archived'");
    expect(sql).toContain("JOIN plugin_catalog");
    expect(params).toEqual(["org-1", "warehouse"]);
  });

  it("includes archived rows when includeArchived is set", async () => {
    mockQueryResult = [installRow({ status: "archived" })];
    const conn = await loadInstalledConnection("org-1", "warehouse", { includeArchived: true });
    expect(capturedQueries[0].sql).not.toContain("status != 'archived'");
    expect(conn!.status).toBe("archived");
  });

  it("returns null when no row matches", async () => {
    mockQueryResult = [];
    expect(await loadInstalledConnection("org-1", "missing")).toBeNull();
  });

  it("degrades a decrypt failure to the decrypt_failed state, keeping row metadata", async () => {
    mockQueryResult = [installRow({ config: { url: "enc:v1:throw:key-rotated", region: "eu" } })];
    const conn = await loadInstalledConnection("org-1", "warehouse");
    expect(conn).not.toBeNull();
    expect(conn!.config.state).toBe("decrypt_failed");
    if (conn!.config.state === "decrypt_failed") {
      expect(conn!.config.reason).toContain("mock decrypt failure");
    }
    // Metadata survives so detail views can render a degraded row.
    expect(conn!.groupId).toBe("prod");
    expect(conn!.catalogSlug).toBe("clickhouse");
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

// --- listInstalledConnections ---

describe("listInstalledConnections", () => {
  it("narrows to installIds via ANY and isolates per-row decrypt failures", async () => {
    mockQueryResult = [
      installRow(),
      installRow({
        id: "row-2",
        install_id: "broken",
        group_id: null,
        config: { url: "enc:v1:throw:bad", region: "us" },
      }),
    ];
    const rows = await listInstalledConnections("org-1", { installIds: ["warehouse", "broken"] });
    const { sql, params } = capturedQueries[0];
    expect(sql).toContain("ANY($2::text[])");
    expect(sql).toContain("status != 'archived'");
    expect(params).toEqual(["org-1", ["warehouse", "broken"]]);

    expect(rows).toHaveLength(2);
    expect(rows[0].config.state).toBe("decrypted");
    expect(rows[1].config.state).toBe("decrypt_failed");
    expect(rows[1].groupId).toBeNull();
  });

  it("lists the whole workspace when no installIds filter is given", async () => {
    mockQueryResult = [];
    await listInstalledConnections("org-1");
    const { sql, params } = capturedQueries[0];
    expect(sql).not.toContain("ANY(");
    expect(params).toEqual(["org-1"]);
  });
});

// --- Billing count + group existence ---

describe("countActiveDatasourceInstalls", () => {
  it("counts non-archived datasource installs for the workspace", async () => {
    mockQueryResult = [{ count: 3 }];
    expect(await countActiveDatasourceInstalls("org-1")).toBe(3);
    const { sql, params } = capturedQueries[0];
    expect(sql).toContain("COUNT(*)::int");
    expect(sql).toContain("pillar = 'datasource'");
    expect(sql).toContain("status != 'archived'");
    expect(params).toEqual(["org-1"]);
  });

  it("returns 0 on an empty result", async () => {
    mockQueryResult = [];
    expect(await countActiveDatasourceInstalls("org-1")).toBe(0);
  });
});

describe("datasourceGroupExists", () => {
  it("is true when some install claims the group_id", async () => {
    mockQueryResult = [{ install_id: "warehouse" }];
    expect(await datasourceGroupExists("org-1", "prod")).toBe(true);
    const { sql, params } = capturedQueries[0];
    expect(sql).toContain("config->>'group_id' = $2");
    expect(sql).toContain("pillar = 'datasource'");
    expect(params).toEqual(["org-1", "prod"]);
  });

  it("is false when no install claims it", async () => {
    mockQueryResult = [];
    expect(await datasourceGroupExists("org-1", "ghost")).toBe(false);
  });
});

// --- Demo-install probe ---

describe("demoInstallActiveSql / isDemoInstallActive", () => {
  it("pins the per-workspace demo probe shape", () => {
    const sql = demoInstallActiveSql(["published", "draft"]);
    expect(sql).toContain(`install_id = '${DEMO_INSTALL_ID}'`);
    expect(sql).toContain(`slug = '${DEMO_CATALOG_SLUG}'`);
    expect(sql).toContain("pillar = 'datasource'");
    expect(sql).toContain("IN ('published', 'draft')");
    expect(sql).toContain("AS active");
  });

  it("rejects an empty status list and out-of-domain literals", () => {
    expect(() => demoInstallActiveSql([])).toThrow("at least one status");
    expect(() =>
      demoInstallActiveSql(["published'; DROP TABLE x; --" as unknown as "published"]),
    ).toThrow("invalid status");
  });

  it("resolves the EXISTS probe to a boolean", async () => {
    mockQueryResult = [{ active: true }];
    expect(await isDemoInstallActive("org-1", ["published"])).toBe(true);
    expect(capturedQueries[0].params).toEqual(["org-1"]);

    mockQueryResult = [];
    expect(await isDemoInstallActive("org-1", ["published"])).toBe(false);
  });
});
