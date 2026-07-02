/**
 * Unit tests for the `knowledge_sync_credentials` store (#4211) — pins the
 * encrypt-before-write contract the consumer tests mock away: the param bound
 * for `auth_secret_encrypted` is the CIPHERTEXT (never the plaintext), the key
 * version rides along for F-47 rotation, reads decrypt, no-row reads return
 * null, and a corrupt ciphertext THROWS (fail-loud — the sync must never
 * silently fetch a private endpoint unauthenticated).
 *
 * `secret-encryption` is mocked (all exports) with a reversible fake so the
 * assertions are about the STORE's routing, not the crypto; the crypto itself
 * is covered by secret-encryption's own tests.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const captured: { sql: string; params: unknown[] }[] = [];
let SELECT_ROWS: Array<{ auth_secret_encrypted: string }> = [];

const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  captured.push({ sql, params });
  if (sql.includes("SELECT auth_secret_encrypted")) return SELECT_ROWS;
  return [];
});

mock.module("@atlas/api/lib/db/internal", () => buildInternalDbMockDefaults({ internalQuery }));

// Reversible fake crypto — mock ALL exports of secret-encryption.
class UnknownKeyVersionError extends Error {}
mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  encryptSecret: (plaintext: string) => `enc:v7:${Buffer.from(plaintext).toString("base64")}`,
  decryptSecret: (stored: string) => {
    if (!stored.startsWith("enc:v7:")) throw new UnknownKeyVersionError(`corrupt ciphertext`);
    return Buffer.from(stored.slice("enc:v7:".length), "base64").toString();
  },
  activeKeyVersion: () => 7,
  hasVersionedPrefix: (stored: string) => stored.startsWith("enc:"),
  isPlaintextCredentialRisk: () => false,
  UnknownKeyVersionError,
}));

const { saveSyncCredential, readSyncCredential, deleteSyncCredential } = await import(
  "@atlas/api/lib/knowledge/sync-credentials"
);

beforeEach(() => {
  captured.length = 0;
  SELECT_ROWS = [];
  internalQuery.mockClear();
});

describe("saveSyncCredential", () => {
  it("binds the CIPHERTEXT (never the plaintext) plus the active key version", async () => {
    await saveSyncCredential("org-1", "docs", "hunter2-token");
    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0];
    expect(sql).toContain("INSERT INTO knowledge_sync_credentials");
    expect(sql).toContain("ON CONFLICT (workspace_id, collection_id)");
    expect(params[0]).toBe("org-1");
    expect(params[1]).toBe("docs");
    // The bound secret is the encrypted form — the plaintext never reaches SQL.
    expect(params[2]).toBe(`enc:v7:${Buffer.from("hunter2-token").toString("base64")}`);
    expect(params[2]).not.toContain("hunter2-token");
    expect(params[3]).toBe(7);
  });
});

describe("readSyncCredential", () => {
  it("returns the decrypted plaintext when a row exists", async () => {
    SELECT_ROWS = [
      { auth_secret_encrypted: `enc:v7:${Buffer.from("hunter2-token").toString("base64")}` },
    ];
    expect(await readSyncCredential("org-1", "docs")).toBe("hunter2-token");
  });

  it("returns null when the collection has no credential (public endpoint)", async () => {
    SELECT_ROWS = [];
    expect(await readSyncCredential("org-1", "docs")).toBeNull();
  });

  it("THROWS on a corrupt/undecryptable ciphertext — never a silent null", async () => {
    SELECT_ROWS = [{ auth_secret_encrypted: "garbage-not-ciphertext" }];
    await expect(readSyncCredential("org-1", "docs")).rejects.toThrow(/corrupt ciphertext/);
  });
});

describe("deleteSyncCredential", () => {
  it("hard-deletes the collection's row", async () => {
    await deleteSyncCredential("org-1", "docs");
    expect(captured[0].sql).toContain("DELETE FROM knowledge_sync_credentials");
    expect(captured[0].params).toEqual(["org-1", "docs"]);
  });
});
