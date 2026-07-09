/**
 * F-41 integration-credential encryption tests for the Discord store.
 * Post-#1832: the plaintext column has been dropped — reads come from
 * `bot_token_encrypted` only, writes only populate the encrypted column.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

type CapturedQuery = { sql: string; params: unknown[] };
let capturedQueries: CapturedQuery[] = [];
let mockInternalQueryResult: unknown[] = [];
let mockHasDB = true;

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: mock((sql: string, params: unknown[] = []) => {
    capturedQueries.push({ sql, params });
    return Promise.resolve(mockInternalQueryResult);
  }),
}));

void mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  encryptSecret: (plaintext: string) => `enc:v1:test:${plaintext}`,
  decryptSecret: (stored: string) => {
    if (stored.startsWith("enc:v1:throw:")) {
      throw new Error(`mock decrypt failure: ${stored.slice("enc:v1:throw:".length)}`);
    }
    return stored.startsWith("enc:v1:test:") ? stored.slice("enc:v1:test:".length) : stored;
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  saveDiscordInstallation,
  getDiscordInstallation,
  getDiscordInstallationByOrg,
  deleteDiscordInstallation,
  deleteDiscordInstallationByOrg,
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

/**
 * Byte-compat coverage for the four operations the seam now routes but
 * the F-41 block above didn't exercise on the real `discord_installations`
 * backend — most importantly the org-hijack rejection (a workspace-
 * takeover invariant) driven through the actual upsert WHERE clause.
 */
describe("discord store — remaining ops through the seam", () => {
  it("rejects when the guild is bound to a different org (hijack protection)", async () => {
    // Atomic upsert returns 0 rows when the org-guard WHERE clause matches
    // nothing — the seam maps that to the uniform hijack rejection.
    mockInternalQueryResult = [];
    await expect(
      saveDiscordInstallation("g-1", { orgId: "org-mine" }),
    ).rejects.toThrow("Guild g-1 is already bound to a different organization");
  });

  it("getDiscordInstallationByOrg queries by org_id and strips the secret", async () => {
    mockInternalQueryResult = [
      {
        guild_id: "g-1",
        org_id: "org-1",
        guild_name: "Test",
        bot_token_encrypted: "enc:v1:test:secret-token",
        application_id: "app-1",
        public_key: "pub-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const result = await getDiscordInstallationByOrg("org-1");
    expect(result).toEqual({
      guild_id: "g-1",
      org_id: "org-1",
      guild_name: "Test",
      application_id: "app-1",
      public_key: "pub-1",
      installed_at: "2026-04-20T00:00:00Z",
    });
    // Secret field stripped from the public shape.
    expect((result as unknown as Record<string, unknown>).bot_token).toBeUndefined();
    const select = capturedQueries.find((q) => q.sql.includes("SELECT"));
    expect(select!.sql).toContain("WHERE org_id = $1");
    expect(select!.params).toEqual(["org-1"]);
  });

  it("getDiscordInstallationByOrg returns null when no internal DB", async () => {
    mockHasDB = false;
    const result = await getDiscordInstallationByOrg("org-1");
    expect(result).toBeNull();
    expect(capturedQueries).toEqual([]);
  });

  it("deleteDiscordInstallation deletes by guild_id", async () => {
    await deleteDiscordInstallation("g-1");
    const del = capturedQueries.find((q) => q.sql.includes("DELETE"));
    expect(del!.sql).toContain("WHERE guild_id = $1");
    expect(del!.params).toEqual(["g-1"]);
  });

  it("deleteDiscordInstallation throws when no internal DB", async () => {
    mockHasDB = false;
    await expect(deleteDiscordInstallation("g-1")).rejects.toThrow(
      "no internal database configured",
    );
  });

  it("deleteDiscordInstallationByOrg returns true when a row was deleted", async () => {
    mockInternalQueryResult = [{ guild_id: "g-1" }];
    const result = await deleteDiscordInstallationByOrg("org-1");
    expect(result).toBe(true);
    const del = capturedQueries.find((q) => q.sql.includes("DELETE"));
    expect(del!.sql).toContain("WHERE org_id = $1");
    expect(del!.sql).toContain("RETURNING guild_id");
    expect(del!.params).toEqual(["org-1"]);
  });

  it("deleteDiscordInstallationByOrg returns false when no matching row", async () => {
    mockInternalQueryResult = [];
    expect(await deleteDiscordInstallationByOrg("org-none")).toBe(false);
  });
});

describe("discord store — single-guild env fallback", () => {
  const savedClientId = process.env.DISCORD_CLIENT_ID;
  beforeEach(() => {
    mockHasDB = false;
    delete process.env.DISCORD_CLIENT_ID;
  });
  afterEach(() => {
    if (savedClientId !== undefined) process.env.DISCORD_CLIENT_ID = savedClientId;
    else delete process.env.DISCORD_CLIENT_ID;
  });

  it("returns a single-guild record (bot_token null) when DISCORD_CLIENT_ID is set and no DB", async () => {
    process.env.DISCORD_CLIENT_ID = "client-123";
    const install = await getDiscordInstallation("g-1");
    expect(install).toEqual({
      guild_id: "g-1",
      org_id: null,
      guild_name: null,
      bot_token: null,
      application_id: null,
      public_key: null,
      installed_at: expect.any(String),
    });
    expect(capturedQueries).toEqual([]);
  });

  it("returns null when no DB and DISCORD_CLIENT_ID unset", async () => {
    const install = await getDiscordInstallation("g-1");
    expect(install).toBeNull();
  });
});
