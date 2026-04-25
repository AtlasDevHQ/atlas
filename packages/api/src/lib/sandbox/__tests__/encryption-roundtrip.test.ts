/**
 * F-41 real-AES round-trip test for the sandbox credentials store.
 *
 * See `email/__tests__/encryption-roundtrip.test.ts` for rationale —
 * same pattern, different store.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/internal";

type CapturedQuery = { sql: string; params: unknown[] };
let capturedQueries: CapturedQuery[] = [];
let mockInternalQueryResult: unknown[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: mock((sql: string, params: unknown[] = []) => {
    capturedQueries.push({ sql, params });
    return Promise.resolve(mockInternalQueryResult);
  }),
  getEncryptionKey: () => {
    const raw = process.env.ATLAS_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
    if (!raw) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(raw).digest();
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { saveSandboxCredential, getSandboxCredentialByProvider } = await import("../credentials");

describe("F-41 sandbox real-AES round-trip", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ATLAS_ENCRYPTION_KEY = "atlas-sandbox-roundtrip-key";
    _resetEncryptionKeyCache();
    capturedQueries = [];
    mockInternalQueryResult = [];
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    _resetEncryptionKeyCache();
  });

  it("save → read returns the original credentials via real AES-GCM", async () => {
    const creds = { token: "vrc_real_round_trip", teamId: "team_xyz" };
    await saveSandboxCredential("org-1", "vercel", creds, "Prod");
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO sandbox_credentials"));
    // Post-#1832 params: [orgId, provider, credentialsEncrypted, displayName, keyVersion]
    const encryptedBlob = insert!.params[2] as string;

    expect(encryptedBlob.startsWith("enc:v1:")).toBe(true);
    expect(encryptedBlob).not.toContain("vrc_real_round_trip");

    mockInternalQueryResult = [
      {
        id: "c-rt",
        org_id: "org-1",
        provider: "vercel",
        credentials_encrypted: encryptedBlob,
        display_name: "Prod",
        validated_at: "2026-04-24T00:00:00Z",
        connected_at: "2026-04-24T00:00:00Z",
      },
    ];
    const loaded = await getSandboxCredentialByProvider("org-1", "vercel");
    expect(loaded?.credentials).toEqual(creds);
  });
});
