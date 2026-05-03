/**
 * createSubscription must store the token under the F-47 encryption
 * envelope (`enc:vN:...`) — never plaintext. The route test mocks
 * createSubscription itself, so without this file nothing in the suite
 * exercises the encryptSecret call for the new table.
 *
 * Per CLAUDE.md ("Encrypted at rest"): "Bearer secrets in the internal
 * DB ... go through encryptSecret ... no plaintext fallback survives
 * post-#1832." This test locks the contract.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";

const ORIGINAL_KEY = process.env.ATLAS_ENCRYPTION_KEY;

beforeAll(() => {
  // 32 bytes (256 bits) — minimum for AES-256-GCM.
  process.env.ATLAS_ENCRYPTION_KEY = "test-key-32-bytes-of-deterministic!";
});

afterAll(() => {
  if (ORIGINAL_KEY !== undefined) {
    process.env.ATLAS_ENCRYPTION_KEY = ORIGINAL_KEY;
  } else {
    delete process.env.ATLAS_ENCRYPTION_KEY;
  }
});

const insertCalls: { sql: string; params: unknown[] }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params?: unknown[]) => {
    insertCalls.push({ sql, params: params ?? [] });
    return [];
  },
}));

const { createSubscription } = await import("@atlas/api/lib/sub-processor-publisher");
const { _resetEncryptionKeyCache } = await import("@atlas/api/lib/db/encryption-keys");
_resetEncryptionKeyCache();

describe("createSubscription — encryption-at-rest contract", () => {
  it("stores the token under an enc:v<N>: envelope (never plaintext)", async () => {
    insertCalls.length = 0;
    const PLAINTEXT_TOKEN = "shared-secret-must-be-at-least-16-chars";

    await createSubscription({
      id: "subp_test1",
      url: "https://hooks.example.com/sp",
      token: PLAINTEXT_TOKEN,
      createdByUserId: "user-1",
      createdByLabel: "user@example.com",
    });

    expect(insertCalls).toHaveLength(1);
    const params = insertCalls[0].params;
    // Schema: (id, url, token_encrypted, token_key_version, created_by_user_id, created_by_label)
    const tokenEncrypted = params[2] as string;
    const keyVersion = params[3] as number;

    expect(tokenEncrypted).not.toBe(PLAINTEXT_TOKEN);
    expect(tokenEncrypted).toMatch(/^enc:v\d+:/);
    expect(keyVersion).toBeGreaterThanOrEqual(1);

    // Sanity: the envelope must round-trip back to the plaintext.
    const { decryptSecret } = await import("@atlas/api/lib/db/secret-encryption");
    expect(decryptSecret(tokenEncrypted)).toBe(PLAINTEXT_TOKEN);
  });

  it("trims whitespace and collapses empty strings to null in the audit label column", async () => {
    insertCalls.length = 0;

    await createSubscription({
      id: "subp_test2",
      url: "https://hooks.example.com/sp2",
      token: "shared-secret-at-least-16-chars",
      createdByUserId: null,
      createdByLabel: "   ",
    });

    const params = insertCalls[0].params;
    expect(params[5]).toBeNull(); // created_by_label
    expect(params[4]).toBeNull(); // created_by_user_id
  });
});
