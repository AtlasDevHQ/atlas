/**
 * F-41 integration-credential encryption tests for the Telegram store.
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
  saveTelegramInstallation,
  getTelegramInstallation,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

describe("F-41 telegram dual-write + read priority", () => {
  it("saveTelegramInstallation dual-writes plaintext + encrypted bot_token (with colons)", async () => {
    mockInternalQueryResult = [{ bot_id: "b-1" }];
    // Telegram tokens famously contain a colon — this is exactly the
    // plaintext shape encryptSecret must round-trip cleanly.
    await saveTelegramInstallation("b-1", {
      orgId: "org-1",
      botUsername: "AtlasBot",
      botToken: "1234567890:ABC-def_ghi:jkl",
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO telegram_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("bot_token_encrypted");
    // params: [botId, botToken, botTokenEncrypted, botUsername, orgId]
    expect(insert!.params[1]).toBe("1234567890:ABC-def_ghi:jkl");
    expect(insert!.params[2]).toBe("enc:v1:test:1234567890:ABC-def_ghi:jkl");
  });

  it("getTelegramInstallation prefers bot_token_encrypted over plaintext", async () => {
    mockInternalQueryResult = [
      {
        bot_id: "b-1",
        bot_token: "stale-token",
        bot_token_encrypted: "enc:v1:test:fresh-token:with:colons",
        bot_username: "AtlasBot",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTelegramInstallation("b-1");
    expect(install?.bot_token).toBe("fresh-token:with:colons");
  });

  it("falls back to plaintext when encrypted is NULL", async () => {
    mockInternalQueryResult = [
      {
        bot_id: "b-1",
        bot_token: "legacy-token",
        bot_token_encrypted: null,
        bot_username: "AtlasBot",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTelegramInstallation("b-1");
    expect(install?.bot_token).toBe("legacy-token");
  });
});
