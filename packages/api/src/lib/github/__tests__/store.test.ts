/**
 * F-41 integration-credential encryption tests for the GitHub store.
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
  saveGitHubInstallation,
  getGitHubInstallation,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

describe("F-41 github encrypted-only writes + reads", () => {
  it("saveGitHubInstallation writes only the encrypted access_token", async () => {
    mockInternalQueryResult = [{ user_id: "u-1" }];
    await saveGitHubInstallation("u-1", {
      orgId: "org-1",
      username: "octocat",
      accessToken: "ghp_abcdef1234",
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO github_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("access_token_encrypted");
    // params: [userId, accessTokenEncrypted, username, orgId, keyVersion]
    expect(insert!.params[1]).toBe("enc:v1:test:ghp_abcdef1234");
  });

  it("getGitHubInstallation decrypts access_token_encrypted", async () => {
    mockInternalQueryResult = [
      {
        user_id: "u-1",
        access_token_encrypted: "enc:v1:test:fresh-token",
        username: "octocat",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getGitHubInstallation("u-1");
    expect(install?.access_token).toBe("fresh-token");
  });

  it("returns null when access_token_encrypted is missing (malformed row)", async () => {
    mockInternalQueryResult = [
      {
        user_id: "u-1",
        access_token_encrypted: null,
        username: "octocat",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getGitHubInstallation("u-1");
    expect(install).toBeNull();
  });
});
