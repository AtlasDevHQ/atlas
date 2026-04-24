/**
 * F-41 integration-credential encryption tests for the sandbox credentials store.
 *
 * Sandbox credentials are a JSONB blob (BYOC tokens for Vercel / E2B /
 * Daytona). The dual-write pattern stringifies the JSON, writes it to
 * both `credentials` JSONB and `credentials_encrypted` TEXT, and reads
 * back by preferring the decrypted/JSON-parsed encrypted column.
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

describe("F-41 sandbox_credentials dual-write + read priority", () => {
  it("saveSandboxCredential dual-writes plaintext JSONB + encrypted blob", async () => {
    const creds = { token: "vrc_abc123", teamId: "team_xyz" };
    await saveSandboxCredential("org-1", "vercel", creds, "Prod");
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO sandbox_credentials"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("credentials_encrypted");
    // params: [orgId, provider, credentialsJson, credentialsEncrypted, displayName]
    expect(insert!.params[2]).toBe(JSON.stringify(creds));
    expect(insert!.params[3]).toBe(`enc:v1:test:${JSON.stringify(creds)}`);
  });

  it("getSandboxCredentialByProvider prefers credentials_encrypted over plaintext JSONB", async () => {
    const fresh = { token: "fresh_token" };
    mockInternalQueryResult = [
      {
        id: "c-1",
        org_id: "org-1",
        provider: "vercel",
        credentials: { token: "stale_token" },
        credentials_encrypted: `enc:v1:test:${JSON.stringify(fresh)}`,
        display_name: "Prod",
        validated_at: "2026-04-20T00:00:00Z",
        connected_at: "2026-04-20T00:00:00Z",
      },
    ];
    const cred = await getSandboxCredentialByProvider("org-1", "vercel");
    expect(cred?.credentials).toEqual(fresh);
  });

  it("ON CONFLICT DO UPDATE clause writes both JSONB and encrypted columns", async () => {
    // JSONB analogue of the Slack test: a future refactor that drops
    // `credentials_encrypted` from the UPDATE clause would leave the
    // encrypted column stale on every re-save, invisible during
    // dual-write but fatal post-#1832. Pin both column refs.
    await saveSandboxCredential("org-1", "vercel", { token: "t" }, "Prod");
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO sandbox_credentials"));
    const sql = insert!.sql;
    expect(sql).toMatch(/DO UPDATE SET[\s\S]*\bcredentials\s*=\s*\$\d/);
    expect(sql).toMatch(/DO UPDATE SET[\s\S]*\bcredentials_encrypted\s*=\s*\$\d/);
  });

  it("falls back to plaintext JSONB when credentials_encrypted is NULL", async () => {
    const legacy = { token: "legacy_token" };
    mockInternalQueryResult = [
      {
        id: "c-1",
        org_id: "org-1",
        provider: "vercel",
        credentials: legacy,
        credentials_encrypted: null,
        display_name: "Prod",
        validated_at: "2026-04-20T00:00:00Z",
        connected_at: "2026-04-20T00:00:00Z",
      },
    ];
    const cred = await getSandboxCredentialByProvider("org-1", "vercel");
    expect(cred?.credentials).toEqual(legacy);
  });
});
