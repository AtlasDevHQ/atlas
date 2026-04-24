/**
 * F-41 integration-credential encryption tests for the Discord store.
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
  saveDiscordInstallation,
  getDiscordInstallation,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

describe("F-41 discord dual-write + read priority", () => {
  it("saveDiscordInstallation dual-writes plaintext + encrypted bot_token", async () => {
    mockInternalQueryResult = [{ guild_id: "g-1" }];
    await saveDiscordInstallation("g-1", {
      orgId: "org-1",
      guildName: "Test",
      botToken: "discord-bot-token",
      applicationId: "app-1",
      publicKey: "pub-1",
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO discord_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("bot_token_encrypted");
    // params: [guildId, orgId, guildName, botToken, botTokenEncrypted, applicationId, publicKey]
    expect(insert!.params[3]).toBe("discord-bot-token");
    expect(insert!.params[4]).toBe("enc:v1:test:discord-bot-token");
  });

  it("getDiscordInstallation prefers bot_token_encrypted over plaintext", async () => {
    mockInternalQueryResult = [
      {
        guild_id: "g-1",
        org_id: "org-1",
        guild_name: "Test",
        bot_token: "stale",
        bot_token_encrypted: "enc:v1:test:fresh-token",
        application_id: "app-1",
        public_key: "pub-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getDiscordInstallation("g-1");
    expect(install?.bot_token).toBe("fresh-token");
  });

  it("falls back to plaintext when encrypted is NULL", async () => {
    mockInternalQueryResult = [
      {
        guild_id: "g-1",
        org_id: "org-1",
        guild_name: "Test",
        bot_token: "legacy-token",
        bot_token_encrypted: null,
        application_id: "app-1",
        public_key: "pub-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getDiscordInstallation("g-1");
    expect(install?.bot_token).toBe("legacy-token");
  });
});
