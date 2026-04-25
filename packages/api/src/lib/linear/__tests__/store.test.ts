/**
 * F-41 integration-credential encryption tests for the Linear store.
 * Post-#1832: encrypted column is the only carrier.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

type CapturedQuery = { sql: string; params: unknown[] };
let capturedQueries: CapturedQuery[] = [];
let mockInternalQueryResult: unknown[] = [];
let mockHasDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: mock((sql: string, params: unknown[] = []) => {
    capturedQueries.push({ sql, params });
    return Promise.resolve(mockInternalQueryResult);
  }),
}));

mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  encryptSecret: (plaintext: string) => `enc:v1:test:${plaintext}`,
  decryptSecret: (stored: string) =>
    stored.startsWith("enc:v1:test:") ? stored.slice("enc:v1:test:".length) : stored,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  saveLinearInstallation,
  getLinearInstallation,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

describe("F-41 linear encrypted-only writes + reads", () => {
  it("saveLinearInstallation writes only the encrypted api_key", async () => {
    mockInternalQueryResult = [{ user_id: "u-1" }];
    await saveLinearInstallation("u-1", {
      orgId: "org-1",
      userName: "Alice",
      userEmail: "a@example.com",
      apiKey: "lin_api_key_12345",
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO linear_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("api_key_encrypted");
    // params: [userId, apiKeyEncrypted, userName, userEmail, orgId, keyVersion]
    expect(insert!.params[1]).toBe("enc:v1:test:lin_api_key_12345");
  });

  it("getLinearInstallation decrypts api_key_encrypted", async () => {
    mockInternalQueryResult = [
      {
        user_id: "u-1",
        api_key_encrypted: "enc:v1:test:fresh-key",
        user_name: "Alice",
        user_email: "a@example.com",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getLinearInstallation("u-1");
    expect(install?.api_key).toBe("fresh-key");
  });

  it("returns null when api_key_encrypted is missing (malformed row)", async () => {
    mockInternalQueryResult = [
      {
        user_id: "u-1",
        api_key_encrypted: null,
        user_name: "Alice",
        user_email: "a@example.com",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getLinearInstallation("u-1");
    expect(install).toBeNull();
  });
});
