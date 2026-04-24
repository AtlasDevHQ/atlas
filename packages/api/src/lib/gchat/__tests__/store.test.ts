/**
 * F-41 integration-credential encryption tests for the Google Chat store.
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
  pickDecryptedSecret: (encrypted: unknown, plaintext: unknown): string | null => {
    if (typeof encrypted === "string" && encrypted.length > 0) {
      return encrypted.startsWith("enc:v1:test:") ? encrypted.slice("enc:v1:test:".length) : encrypted;
    }
    if (typeof plaintext === "string" && plaintext.length > 0) return plaintext;
    return null;
  },
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

describe("F-41 gchat dual-write + read priority", () => {
  it("saveGChatInstallation dual-writes plaintext + encrypted credentials_json", async () => {
    mockInternalQueryResult = [{ project_id: "p-1" }];
    await saveGChatInstallation("p-1", {
      orgId: "org-1",
      serviceAccountEmail: "sa@project.iam.gserviceaccount.com",
      credentialsJson: SA_JSON,
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO gchat_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("credentials_json_encrypted");
    // params: [projectId, serviceAccountEmail, credentialsJson, credentialsJsonEncrypted, orgId]
    expect(insert!.params[2]).toBe(SA_JSON);
    expect(insert!.params[3]).toBe(`enc:v1:test:${SA_JSON}`);
  });

  it("getGChatInstallation prefers credentials_json_encrypted over plaintext", async () => {
    mockInternalQueryResult = [
      {
        project_id: "p-1",
        service_account_email: "sa@project.iam.gserviceaccount.com",
        credentials_json: "stale-json",
        credentials_json_encrypted: `enc:v1:test:${SA_JSON}`,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getGChatInstallation("p-1");
    expect(install?.credentials_json).toBe(SA_JSON);
  });

  it("falls back to plaintext when encrypted is NULL", async () => {
    mockInternalQueryResult = [
      {
        project_id: "p-1",
        service_account_email: "sa@project.iam.gserviceaccount.com",
        credentials_json: SA_JSON,
        credentials_json_encrypted: null,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getGChatInstallation("p-1");
    expect(install?.credentials_json).toBe(SA_JSON);
  });
});
