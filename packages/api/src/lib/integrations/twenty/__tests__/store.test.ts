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
  findLatestTwentyDbCredentials,
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

describe("saveTwentyIntegration — SaaS multi-tenant guard (#2849 follow-up)", () => {
  it("refuses the upsert when SaaS mode + a row exists for a DIFFERENT workspace", async () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    mockInternalQueryResultBySql = (sql: string) => {
      if (sql.includes("workspace_id <>")) {
        return [{ workspace_id: "ws-other" }];
      }
      // Should never reach the INSERT — guard refuses first.
      return [];
    };
    await expect(
      saveTwentyIntegration("ws-new", { apiKey: "k", baseUrl: "https://b" }),
    ).rejects.toThrow(/Refusing Twenty install/);
    // Guard ran before any INSERT.
    expect(capturedQueries.find((q) => q.sql.includes("INSERT INTO twenty_integrations"))).toBeUndefined();
  });

  it("permits the upsert when SaaS mode but the conflicting row IS the same workspace", async () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    mockInternalQueryResultBySql = (sql: string) => {
      if (sql.includes("workspace_id <>")) {
        return []; // No other workspace
      }
      if (sql.includes("INSERT INTO twenty_integrations")) {
        return [
          {
            workspace_id: "ws-1",
            base_url: "https://b",
            updated_at: "2026-05-26T00:00:00.000Z",
          },
        ];
      }
      return [];
    };
    const saved = await saveTwentyIntegration("ws-1", { apiKey: "k", baseUrl: "https://b" });
    expect(saved.workspaceId).toBe("ws-1");
  });

  it("self-hosted (no SaaS env) skips the guard entirely", async () => {
    delete process.env.ATLAS_DEPLOY_MODE;
    mockInternalQueryResultBySql = (sql: string) => {
      if (sql.includes("INSERT INTO twenty_integrations")) {
        return [
          {
            workspace_id: "ws-self",
            base_url: "https://b",
            updated_at: "2026-05-26T00:00:00.000Z",
          },
        ];
      }
      return [];
    };
    const saved = await saveTwentyIntegration("ws-self", {
      apiKey: "k",
      baseUrl: "https://b",
    });
    expect(saved.workspaceId).toBe("ws-self");
    // Confirm the guard SELECT did NOT run.
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

describe("findLatestTwentyDbCredentials", () => {
  it("returns the latest-updated row with the decrypted api_key", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: "https://crm.example.com",
        updated_at: "2026-05-26T00:00:00.000Z",
        api_key_encrypted: "enc:v1:test:latest-key",
      },
    ];
    const row = await findLatestTwentyDbCredentials();
    expect(row?.apiKey).toBe("latest-key");
    expect(row?.workspaceId).toBe("ws-1");
    const select = capturedQueries.find((q) => q.sql.includes("FROM twenty_integrations"));
    expect(select!.sql).toMatch(/ORDER BY updated_at DESC/);
    expect(select!.sql).toMatch(/LIMIT 1/);
  });

  it("returns null when the table is empty", async () => {
    mockInternalQueryResult = [];
    const row = await findLatestTwentyDbCredentials();
    expect(row).toBeNull();
  });

  it("returns null when hasInternalDB is false", async () => {
    mockHasDB = false;
    const row = await findLatestTwentyDbCredentials();
    expect(row).toBeNull();
  });

  it("throws TwentyDecryptError when the chosen row's ciphertext fails to decrypt", async () => {
    mockInternalQueryResult = [
      {
        workspace_id: "ws-1",
        base_url: "https://crm.example.com",
        updated_at: "2026-05-26T00:00:00.000Z",
        api_key_encrypted: "enc:v99:rotated-away:opaque",
      },
    ];
    decryptSecretShouldThrow = true;
    await expect(findLatestTwentyDbCredentials()).rejects.toBeInstanceOf(TwentyDecryptError);
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
