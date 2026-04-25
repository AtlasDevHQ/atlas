/**
 * F-41 integration-credential encryption tests for the Google Chat store.
 * Post-#1832: the plaintext column has been dropped — reads come from
 * `credentials_json_encrypted` only, writes only populate the encrypted
 * column.
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
  saveGChatInstallation,
  getGChatInstallation,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

const SA_JSON = JSON.stringify({ type: "service_account", private_key: "-----BEGIN" });

describe("F-41 gchat encrypted-only writes + reads", () => {
  it("saveGChatInstallation writes only the encrypted credentials_json", async () => {
    mockInternalQueryResult = [{ project_id: "p-1" }];
    await saveGChatInstallation("p-1", {
      orgId: "org-1",
      serviceAccountEmail: "sa@project.iam.gserviceaccount.com",
      credentialsJson: SA_JSON,
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO gchat_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("credentials_json_encrypted");
    // params: [projectId, serviceAccountEmail, credentialsJsonEncrypted, orgId, keyVersion]
    expect(insert!.params[2]).toBe(`enc:v1:test:${SA_JSON}`);
  });

  it("getGChatInstallation decrypts credentials_json_encrypted", async () => {
    mockInternalQueryResult = [
      {
        project_id: "p-1",
        service_account_email: "sa@project.iam.gserviceaccount.com",
        credentials_json_encrypted: `enc:v1:test:${SA_JSON}`,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getGChatInstallation("p-1");
    expect(install?.credentials_json).toBe(SA_JSON);
  });

  it("returns null when credentials_json_encrypted is missing (malformed row)", async () => {
    mockInternalQueryResult = [
      {
        project_id: "p-1",
        service_account_email: "sa@project.iam.gserviceaccount.com",
        credentials_json_encrypted: null,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getGChatInstallation("p-1");
    expect(install).toBeNull();
  });
});
