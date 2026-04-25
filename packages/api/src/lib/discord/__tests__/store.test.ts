/**
 * F-41 integration-credential encryption tests for the Discord store.
 * Post-#1832: the plaintext column has been dropped — reads come from
 * `bot_token_encrypted` only, writes only populate the encrypted column.
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
  decryptSecret: (stored: string) => {
    if (stored.startsWith("enc:v1:throw:")) {
      throw new Error(`mock decrypt failure: ${stored.slice("enc:v1:throw:".length)}`);
    }
    return stored.startsWith("enc:v1:test:") ? stored.slice("enc:v1:test:".length) : stored;
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

describe("F-41 discord encrypted-only writes + reads", () => {
  it("saveDiscordInstallation writes only the encrypted bot_token", async () => {
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
    // The dropped plaintext `bot_token` column must not appear as a
    // standalone identifier — only `bot_token_encrypted` and
    // `bot_token_key_version` should match a `bot_token` substring.
    expect(insert!.sql).not.toMatch(/(?<![_\w])bot_token(?![_\w])/);
    // params: [guildId, orgId, guildName, botTokenEncrypted, applicationId, publicKey, botTokenKeyVersion]
    expect(insert!.params[3]).toBe("enc:v1:test:discord-bot-token");
  });

  it("getDiscordInstallation decrypts bot_token_encrypted", async () => {
    mockInternalQueryResult = [
      {
        guild_id: "g-1",
        org_id: "org-1",
        guild_name: "Test",
        bot_token_encrypted: "enc:v1:test:fresh-token",
        application_id: "app-1",
        public_key: "pub-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getDiscordInstallation("g-1");
    expect(install?.bot_token).toBe("fresh-token");
  });

  it("returns bot_token: null when bot_token_encrypted is NULL (OAuth-only install)", async () => {
    mockInternalQueryResult = [
      {
        guild_id: "g-1",
        org_id: "org-1",
        guild_name: "Test",
        bot_token_encrypted: null,
        application_id: "app-1",
        public_key: "pub-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getDiscordInstallation("g-1");
    expect(install?.bot_token).toBeNull();
  });

  it("hides the row when decryptSecret throws (decrypt failure ≠ OAuth-only install)", async () => {
    // Pin the M2 fix: decrypt failure on the nullable encrypted column
    // returns null for the whole row instead of `{ ..., bot_token: null }`,
    // which would be indistinguishable from a healthy OAuth-only install.
    mockInternalQueryResult = [
      {
        guild_id: "g-1",
        org_id: "org-1",
        guild_name: "Test",
        bot_token_encrypted: "enc:v1:throw:auth-tag-failure",
        application_id: "app-1",
        public_key: "pub-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getDiscordInstallation("g-1");
    expect(install).toBeNull();
  });
});
