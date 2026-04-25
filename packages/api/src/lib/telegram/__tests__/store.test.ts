/**
 * F-41 integration-credential encryption tests for the Telegram store.
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
  saveTelegramInstallation,
  getTelegramInstallation,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

describe("F-41 telegram encrypted-only writes + reads", () => {
  it("saveTelegramInstallation writes only the encrypted bot_token (with colons)", async () => {
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
    // params: [botId, botTokenEncrypted, botUsername, orgId, keyVersion]
    expect(insert!.params[1]).toBe("enc:v1:test:1234567890:ABC-def_ghi:jkl");
  });

  it("getTelegramInstallation decrypts bot_token_encrypted (round-trips colons)", async () => {
    mockInternalQueryResult = [
      {
        bot_id: "b-1",
        bot_token_encrypted: "enc:v1:test:fresh-token:with:colons",
        bot_username: "AtlasBot",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTelegramInstallation("b-1");
    expect(install?.bot_token).toBe("fresh-token:with:colons");
  });

  it("returns null when bot_token_encrypted is missing (malformed row)", async () => {
    mockInternalQueryResult = [
      {
        bot_id: "b-1",
        bot_token_encrypted: null,
        bot_username: "AtlasBot",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTelegramInstallation("b-1");
    expect(install).toBeNull();
  });
});
