/**
 * Tests for the Twenty integration store.
 *
 * Mirrors the Linear-store F-41 test shape: mock the internal query +
 * encryption modules, assert that the encrypted column is the only
 * carrier of the apiKey and that the public read path returns the
 * configured fields without the secret.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { TwentyDecryptError } from "@useatlas/twenty";

type CapturedQuery = { sql: string; params: unknown[] };
let capturedQueries: CapturedQuery[] = [];
let mockInternalQueryResult: unknown[] = [];
let mockInternalQueryResultBySql: ((sql: string) => unknown[]) | null = null;
let mockHasDB = true;
let decryptSecretShouldThrow = false;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: mock((sql: string, params: unknown[] = []) => {
    capturedQueries.push({ sql, params });
    const rows = mockInternalQueryResultBySql
      ? mockInternalQueryResultBySql(sql)
      : mockInternalQueryResult;
    return Promise.resolve(rows);
  }),
}));

mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  encryptSecret: (plaintext: string) => `enc:v1:test:${plaintext}`,
  decryptSecret: (stored: string) => {
    if (decryptSecretShouldThrow) {
      throw new Error("simulated decrypt failure (wrong key version)");
    }
    return stored.startsWith("enc:v1:test:") ? stored.slice("enc:v1:test:".length) : stored;
  },
}));

mock.module("@atlas/api/lib/db/encryption-keys", () => ({
  activeKeyVersion: () => 1,
  getEncryptionKeyset: () => ({ active: { version: 1, key: Buffer.alloc(32) } }),
  _resetEncryptionKeyCache: () => {},
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const {
  saveTwentyIntegration,
  getTwentyIntegrationPublic,
  getTwentyIntegrationWithSecret,
  deleteTwentyIntegration,
} = await import("../store");

const originalDeployMode = process.env.ATLAS_DEPLOY_MODE;

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockInternalQueryResultBySql = null;
  mockHasDB = true;
  decryptSecretShouldThrow = false;
  delete process.env.ATLAS_DEPLOY_MODE;
});

afterEach(() => {
  if (originalDeployMode === undefined) {
    delete process.env.ATLAS_DEPLOY_MODE;
  } else {
    process.env.ATLAS_DEPLOY_MODE = originalDeployMode;
  }
});

describe("saveTwentyIntegration", () => {
  it("writes the encrypted api_key and persists base_url verbatim", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: "https://crm.example.com",
        updated_at: "2026-05-26T00:00:00.000Z",
      },
    ];

    const saved = await saveTwentyIntegration("ws-1", {
      apiKey: "raw-api-key",
      baseUrl: "https://crm.example.com",
    });

    expect(saved).toMatchObject({
      workspaceId: "ws-1",
      baseUrl: "https://crm.example.com",
      updatedAt: "2026-05-26T00:00:00.000Z",
    });

    const insert = capturedQueries.find((q) =>
      q.sql.includes("INSERT INTO twenty_integrations"),
    );
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("api_key_encrypted");
    expect(insert!.sql).toContain("api_key_key_version");
    // params: [workspaceId, baseUrl, apiKeyEncrypted, keyVersion]
    expect(insert!.params[0]).toBe("ws-1");
    expect(insert!.params[1]).toBe("https://crm.example.com");
    expect(insert!.params[2]).toBe("enc:v1:test:raw-api-key");
    expect(insert!.params[3]).toBe(1);
  });

  it("upserts on conflict (workspace_id is the unique key)", async () => {
    mockInternalQueryResult = [
      { workspace_id: "ws-1", base_url: "https://b", updated_at: "2026-05-26T00:00:00.000Z" },
    ];
    await saveTwentyIntegration("ws-1", { apiKey: "k", baseUrl: "https://b" });
    const insert = capturedQueries.find((q) =>
      q.sql.includes("INSERT INTO twenty_integrations"),
    );
    expect(insert!.sql).toContain("ON CONFLICT (workspace_id)");
    expect(insert!.sql).toContain("api_key_encrypted = EXCLUDED.api_key_encrypted");
  });

  it("throws when hasInternalDB returns false", async () => {
    mockHasDB = false;
    await expect(
      saveTwentyIntegration("ws-1", { apiKey: "k", baseUrl: "https://b" }),
    ).rejects.toThrow(/no internal database/i);
  });

  it("synthesises a public row when RETURNING comes back empty", async () => {
    mockInternalQueryResult = [];
    const saved = await saveTwentyIntegration("ws-1", {
      apiKey: "k",
      baseUrl: "https://b",
    });
    expect(saved.workspaceId).toBe("ws-1");
    expect(saved.baseUrl).toBe("https://b");
    expect(typeof saved.updatedAt).toBe("string");
  });
});

describe("saveTwentyIntegration — multi-tenant safety (#2850)", () => {
  it("does NOT consult cross-workspace state — each workspace owns its own row", async () => {
    // Pre-#2850 the store ran a "is another workspace already installed?"
    // SELECT before every INSERT under SaaS mode, because the operator
    // dispatcher used findLatestTwentyDbCredentials. With the resolver
    // split, the SaaS operator path is env-only and cross-workspace
    // routing is gone — so the guard SELECT must NOT run.
    process.env.ATLAS_DEPLOY_MODE = "saas";
    mockInternalQueryResult = [
      {
        workspace_id: "ws-saas",
        base_url: "https://b",
        updated_at: "2026-05-26T00:00:00.000Z",
      },
    ];
    await saveTwentyIntegration("ws-saas", { apiKey: "k", baseUrl: "https://b" });
    expect(capturedQueries.find((q) => q.sql.includes("workspace_id <>"))).toBeUndefined();
  });
});

describe("getTwentyIntegrationPublic", () => {
  it("returns the row without the api_key", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: "https://crm.example.com",
        updated_at: "2026-05-26T00:00:00.000Z",
      },
    ];
    const pub = await getTwentyIntegrationPublic("ws-1");
    expect(pub).toEqual({
      workspaceId: "ws-1",
      baseUrl: "https://crm.example.com",
      updatedAt: "2026-05-26T00:00:00.000Z",
    });
    // Public reader must not pull the encrypted column.
    const select = capturedQueries.find((q) => q.sql.includes("FROM twenty_integrations"));
    expect(select!.sql).not.toContain("api_key_encrypted");
  });

  it("returns null when no row exists", async () => {
    mockInternalQueryResult = [];
    const pub = await getTwentyIntegrationPublic("ws-1");
    expect(pub).toBeNull();
  });

  it("returns null when hasInternalDB is false", async () => {
    mockHasDB = false;
    const pub = await getTwentyIntegrationPublic("ws-1");
    expect(pub).toBeNull();
  });

  it("supports null base_url (admin saved without override)", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: null,
        updated_at: "2026-05-26T00:00:00.000Z",
      },
    ];
    const pub = await getTwentyIntegrationPublic("ws-1");
    expect(pub?.baseUrl).toBeNull();
  });

  it("returns null when updated_at is missing / non-string (malformed row)", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: "https://crm.example.com",
        updated_at: null,
      },
    ];
    const pub = await getTwentyIntegrationPublic("ws-1");
    expect(pub).toBeNull();
  });
});

describe("getTwentyIntegrationWithSecret", () => {
  it("decrypts api_key_encrypted into apiKey", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: "https://crm.example.com",
        updated_at: "2026-05-26T00:00:00.000Z",
        api_key_encrypted: "enc:v1:test:secret-key",
      },
    ];
    const row = await getTwentyIntegrationWithSecret("ws-1");
    expect(row?.apiKey).toBe("secret-key");
    expect(row?.baseUrl).toBe("https://crm.example.com");
  });

  it("returns null when api_key_encrypted is missing", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: "https://b",
        updated_at: "2026-05-26T00:00:00.000Z",
        api_key_encrypted: null,
      },
    ];
    const row = await getTwentyIntegrationWithSecret("ws-1");
    expect(row).toBeNull();
  });

  it("returns null when no row exists", async () => {
    mockInternalQueryResult = [];
    const row = await getTwentyIntegrationWithSecret("ws-1");
    expect(row).toBeNull();
  });

  it("throws TwentyDecryptError when decryptSecret fails on a present ciphertext", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: "https://crm.example.com",
        updated_at: "2026-05-26T00:00:00.000Z",
        api_key_encrypted: "enc:v99:rotated-away:opaque",
      },
    ];
    decryptSecretShouldThrow = true;
    await expect(getTwentyIntegrationWithSecret("ws-1")).rejects.toBeInstanceOf(
      TwentyDecryptError,
    );
  });
});

describe("deleteTwentyIntegration", () => {
  it("returns true when a row was deleted", async () => {
    mockInternalQueryResult = [{ workspace_id: "ws-1" }];
    const result = await deleteTwentyIntegration("ws-1");
    expect(result).toBe(true);
    const del = capturedQueries.find((q) =>
      q.sql.includes("DELETE FROM twenty_integrations"),
    );
    expect(del).toBeDefined();
    expect(del!.params[0]).toBe("ws-1");
  });

  it("returns false when no row matched", async () => {
    mockInternalQueryResult = [];
    const result = await deleteTwentyIntegration("ws-1");
    expect(result).toBe(false);
  });

  it("throws when hasInternalDB is false", async () => {
    mockHasDB = false;
    await expect(deleteTwentyIntegration("ws-1")).rejects.toThrow(/no internal database/i);
  });
});
