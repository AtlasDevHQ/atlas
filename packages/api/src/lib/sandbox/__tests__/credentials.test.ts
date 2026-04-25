/**
 * F-41 integration-credential encryption tests for the sandbox credentials store.
 *
 * Sandbox credentials are a JSONB blob (BYOC tokens for Vercel / E2B /
 * Daytona). Post-#1832 the plaintext JSONB column has been dropped —
 * writes only populate `credentials_encrypted` (TEXT carrying
 * `encryptSecret(JSON.stringify(creds))`), reads decrypt + JSON.parse.
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
  saveSandboxCredential,
  getSandboxCredentialByProvider,
} = await import("../credentials");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

describe("F-41 sandbox_credentials encrypted-only writes + reads", () => {
  it("saveSandboxCredential writes only the encrypted blob", async () => {
    const creds = { token: "vrc_abc123", teamId: "team_xyz" };
    await saveSandboxCredential("org-1", "vercel", creds, "Prod");
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO sandbox_credentials"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("credentials_encrypted");
    // params: [orgId, provider, credentialsEncrypted, displayName, keyVersion]
    expect(insert!.params[2]).toBe(`enc:v1:test:${JSON.stringify(creds)}`);
  });

  it("getSandboxCredentialByProvider decrypts credentials_encrypted", async () => {
    const fresh = { token: "fresh_token" };
    mockInternalQueryResult = [
      {
        id: "c-1",
        org_id: "org-1",
        provider: "vercel",
        credentials_encrypted: `enc:v1:test:${JSON.stringify(fresh)}`,
        display_name: "Prod",
        validated_at: "2026-04-20T00:00:00Z",
        connected_at: "2026-04-20T00:00:00Z",
      },
    ];
    const cred = await getSandboxCredentialByProvider("org-1", "vercel");
    expect(cred?.credentials).toEqual(fresh);
  });

  it("ON CONFLICT DO UPDATE clause refreshes the encrypted column", async () => {
    // Pin the UPDATE shape — a refactor that drops the encrypted column
    // from DO UPDATE would silently keep stale ciphertext on every
    // re-save, but the read path requires it to be fresh.
    await saveSandboxCredential("org-1", "vercel", { token: "t" }, "Prod");
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO sandbox_credentials"));
    const sql = insert!.sql;
    expect(sql).toMatch(/DO UPDATE SET[\s\S]*\bcredentials_encrypted\s*=\s*\$\d/);
    // The dropped plaintext column must not appear in the UPDATE.
    expect(sql).not.toMatch(/DO UPDATE SET[\s\S]*(?<![_\w])credentials\s*=\s*\$\d/);
  });

  it("returns null when credentials_encrypted is missing (malformed row)", async () => {
    mockInternalQueryResult = [
      {
        id: "c-1",
        org_id: "org-1",
        provider: "vercel",
        credentials_encrypted: null,
        display_name: "Prod",
        validated_at: "2026-04-20T00:00:00Z",
        connected_at: "2026-04-20T00:00:00Z",
      },
    ];
    const cred = await getSandboxCredentialByProvider("org-1", "vercel");
    expect(cred).toBeNull();
  });
});
