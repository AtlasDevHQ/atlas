/**
 * Tests for Slack installation storage (store.ts).
 *
 * Post-#2634 the store reads/writes `chat_cache` (the same table the
 * chat plugin's `@chat-adapter/slack` uses for multi-workspace
 * installs). Mocks the internal DB layer to exercise the consolidated
 * read/write paths and the env-var fallback.
 */

import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";

// --- Mocks ---

const mockHasInternalDB: Mock<() => boolean> = mock(() => true);
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(() =>
  Promise.resolve([]),
);

const mockPoolQuery: Mock<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>> = mock(() =>
  Promise.resolve({ rows: [] }),
);
const mockGetInternalDB: Mock<() => { query: typeof mockPoolQuery }> = mock(() => ({
  query: mockPoolQuery,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  internalQuery: mockInternalQuery,
  getInternalDB: mockGetInternalDB,
  getApprovedPatterns: async () => [],
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import after mocks are registered
const {
  getInstallation,
  getInstallationByOrg,
  saveInstallation,
  preserveOrgIdOnInstall,
  deleteInstallation,
  deleteInstallationByOrg,
  getBotToken,
} = await import("../store");
const { resetSlackEncryptionKeyCache } = await import("../installation-encryption");

describe("store (chat_cache-backed)", () => {
  const savedBotToken = process.env.SLACK_BOT_TOKEN;
  const savedEncryptionKey = process.env.SLACK_ENCRYPTION_KEY;

  beforeEach(() => {
    mockHasInternalDB.mockClear();
    mockInternalQuery.mockClear();
    mockPoolQuery.mockClear();
    mockGetInternalDB.mockClear();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_ENCRYPTION_KEY;
    resetSlackEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedBotToken !== undefined) process.env.SLACK_BOT_TOKEN = savedBotToken;
    else delete process.env.SLACK_BOT_TOKEN;
    if (savedEncryptionKey !== undefined) process.env.SLACK_ENCRYPTION_KEY = savedEncryptionKey;
    else delete process.env.SLACK_ENCRYPTION_KEY;
    resetSlackEncryptionKeyCache();
  });

  describe("getInstallation", () => {
    it("reads from chat_cache with the slack:installation:<teamId> key", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        {
          value: { botToken: "xoxb-fresh", orgId: null, teamName: null },
          installed_at: "2025-01-01T00:00:00.000Z",
        },
      ]);

      const result = await getInstallation("T123");
      expect(result).toEqual({
        team_id: "T123",
        bot_token: "xoxb-fresh",
        org_id: null,
        workspace_name: null,
        installed_at: "2025-01-01T00:00:00.000Z",
      });
      expect(mockInternalQuery).toHaveBeenCalledTimes(1);
      const [selectSql, params] = mockInternalQuery.mock.calls[0];
      expect(selectSql).toContain("FROM chat_cache");
      expect(selectSql).toContain("WHERE key = $1");
      expect(params).toEqual(["slack:installation:T123"]);
    });

    it("decrypts the AES-GCM envelope when SLACK_ENCRYPTION_KEY is set", async () => {
      // 32 zero bytes as base64 — deterministic key for the round trip.
      process.env.SLACK_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
      resetSlackEncryptionKeyCache();

      // Encrypt a plaintext via the same helper the writer uses so we
      // exercise the round-trip (not a hand-built envelope).
      const { encryptSlackInstallationToken } = await import("../installation-encryption");
      const encrypted = encryptSlackInstallationToken("xoxb-secret");
      expect(typeof encrypted).not.toBe("string");

      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        {
          value: { botToken: encrypted, orgId: "org-1" },
          installed_at: "2025-01-01T00:00:00.000Z",
        },
      ]);

      const result = await getInstallation("T123");
      expect(result?.bot_token).toBe("xoxb-secret");
      expect(result?.org_id).toBe("org-1");
    });

    it("returns null when no chat_cache row exists", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([]);

      const result = await getInstallation("T999");
      expect(result).toBeNull();
    });

    it("throws when chat_cache query fails (does NOT fall through to env var)", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockRejectedValue(new Error("connection refused"));
      process.env.SLACK_BOT_TOKEN = "xoxb-env-fallback";

      await expect(getInstallation("T123")).rejects.toThrow("connection refused");
    });

    it("returns env var token when hasInternalDB() is false and SLACK_BOT_TOKEN is set", async () => {
      mockHasInternalDB.mockReturnValue(false);
      process.env.SLACK_BOT_TOKEN = "xoxb-env-token";

      const result = await getInstallation("T123");
      expect(result).not.toBeNull();
      expect(result!.bot_token).toBe("xoxb-env-token");
      expect(result!.team_id).toBe("T123");
      expect(mockInternalQuery).not.toHaveBeenCalled();
    });

    it("returns null when hasInternalDB() is false and no env var", async () => {
      mockHasInternalDB.mockReturnValue(false);
      delete process.env.SLACK_BOT_TOKEN;

      const result = await getInstallation("T123");
      expect(result).toBeNull();
    });

    it("returns null when value.botToken is missing", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        { value: { orgId: "org-1" }, installed_at: "2025-01-01T00:00:00.000Z" },
      ]);

      const result = await getInstallation("T123");
      expect(result).toBeNull();
    });
  });

  describe("getInstallationByOrg", () => {
    it("queries chat_cache by org_id using the partial expression index", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        {
          key: "slack:installation:T123",
          value: {
            botToken: "xoxb-fresh",
            orgId: "org-1",
            teamName: "My Team",
            workspaceName: "My Team",
          },
          installed_at: "2025-01-01T00:00:00.000Z",
        },
      ]);

      const result = await getInstallationByOrg("org-1");
      // Secret fields are stripped at runtime — only public fields returned
      expect(result).toEqual({
        team_id: "T123",
        org_id: "org-1",
        workspace_name: "My Team",
        installed_at: "2025-01-01T00:00:00.000Z",
      });
      expect((result as unknown as Record<string, unknown>).bot_token).toBeUndefined();
      expect(mockInternalQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockInternalQuery.mock.calls[0];
      expect(sql).toContain("FROM chat_cache");
      // The key prefix is LITERAL (not parameterized) so the planner can
      // match the partial expression index `idx_chat_cache_slack_org_id`.
      expect(sql).toContain("key LIKE 'slack:installation:%'");
      expect(sql).toContain("value->>'orgId' = $1");
      expect(params).toEqual(["org-1"]);
    });

    it("returns null when no matching chat_cache row", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([]);

      const result = await getInstallationByOrg("org-999");
      expect(result).toBeNull();
    });

    it("returns null when no internal DB", async () => {
      mockHasInternalDB.mockReturnValue(false);
      process.env.SLACK_BOT_TOKEN = "xoxb-env-token";

      const result = await getInstallationByOrg("org-1");
      expect(result).toBeNull();
      expect(mockInternalQuery).not.toHaveBeenCalled();
    });

    it("throws when DB query fails", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockRejectedValue(new Error("timeout"));

      await expect(getInstallationByOrg("org-1")).rejects.toThrow("timeout");
    });
  });

  describe("saveInstallation", () => {
    it("upserts into chat_cache with the slack:installation key", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [{ key: "slack:installation:T123" }] });

      await expect(saveInstallation("T123", "xoxb-new")).resolves.toBeUndefined();
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);

      const [insertSql, insertParams] = mockPoolQuery.mock.calls[0];
      expect(insertSql).toContain("INSERT INTO chat_cache");
      expect(insertSql).toContain("ON CONFLICT (key) DO UPDATE");
      expect(insertSql).toContain("RETURNING key");

      // Params: (key, value::jsonb, orgId-for-hijack-check)
      expect(insertParams).toHaveLength(3);
      expect(insertParams![0]).toBe("slack:installation:T123");
      expect(insertParams![2]).toBeNull();
      // Value is JSON — verify the bot token field
      const value = JSON.parse(insertParams![1] as string);
      // Without SLACK_ENCRYPTION_KEY the token persists as plaintext
      expect(value.botToken).toBe("xoxb-new");
      expect(typeof value.installedAt).toBe("string");
    });

    it("includes orgId + workspaceName when provided", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [{ key: "slack:installation:T123" }] });

      await saveInstallation("T123", "xoxb-new", { orgId: "org-1", workspaceName: "My Team" });
      const [, insertParams] = mockPoolQuery.mock.calls[0];
      expect(insertParams![2]).toBe("org-1");
      const value = JSON.parse(insertParams![1] as string);
      expect(value.orgId).toBe("org-1");
      expect(value.workspaceName).toBe("My Team");
      expect(value.teamName).toBe("My Team");
    });

    it("encrypts the bot token when SLACK_ENCRYPTION_KEY is set", async () => {
      process.env.SLACK_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
      resetSlackEncryptionKeyCache();
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [{ key: "slack:installation:T123" }] });

      await saveInstallation("T123", "xoxb-plain");
      const [, insertParams] = mockPoolQuery.mock.calls[0];
      const value = JSON.parse(insertParams![1] as string);
      expect(typeof value.botToken).toBe("object");
      expect(value.botToken).toMatchObject({
        iv: expect.any(String),
        data: expect.any(String),
        tag: expect.any(String),
      });
      // Most importantly: the plaintext is NOT in the persisted blob
      expect(JSON.stringify(value)).not.toContain("xoxb-plain");
    });

    it("rejects when team is bound to a different org (hijack protection)", async () => {
      mockHasInternalDB.mockReturnValue(true);
      // Atomic upsert returns 0 rows when orgId doesn't match (the WHERE clause filters)
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await expect(
        saveInstallation("T123", "xoxb-new", { orgId: "org-mine" }),
      ).rejects.toThrow("already bound to a different organization");
    });

    it("throws when no internal DB", async () => {
      mockHasInternalDB.mockReturnValue(false);

      await expect(saveInstallation("T123", "xoxb-token")).rejects.toThrow(
        "no internal database configured",
      );
    });

    it("throws when DB write fails", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockRejectedValue(new Error("disk full"));

      await expect(saveInstallation("T123", "xoxb-token")).rejects.toThrow("disk full");
    });
  });

  describe("preserveOrgIdOnInstall (#2676)", () => {
    it("stamps orgId via jsonb_set when the row is missing the field", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ key: "slack:installation:T123" }] });

      await expect(
        preserveOrgIdOnInstall("T123", "org-1"),
      ).resolves.toBeUndefined();

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain("UPDATE chat_cache");
      expect(sql).toContain("jsonb_set(value, '{orgId}'");
      expect(sql).toContain("to_jsonb($2::text)");
      // Hijack-guard WHERE clause mirrors saveInstallation
      expect(sql).toContain("value->>'orgId' IS NULL");
      expect(sql).toContain("value->>'orgId' = $2");
      expect(params).toEqual(["slack:installation:T123", "org-1"]);
    });

    it("is idempotent when the row's orgId already matches", async () => {
      // Same SQL semantics as the "missing" case — jsonb_set is a no-op
      // when path's value equals the new value. RETURNING still emits
      // the row.
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ key: "slack:installation:T123" }] });

      await expect(
        preserveOrgIdOnInstall("T123", "org-1"),
      ).resolves.toBeUndefined();
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it("warns and returns (no throw) when the chat_cache row doesn't exist", async () => {
      // UPDATE returns 0 rows; follow-up probe SELECT returns 0 rows →
      // distinguishes "row absent" from "hijack" and returns soft.
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // UPDATE — no row matched
        .mockResolvedValueOnce({ rows: [] }); // probe — row absent

      await expect(
        preserveOrgIdOnInstall("T123", "org-1"),
      ).resolves.toBeUndefined();
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    });

    it("throws on cross-tenant hijack", async () => {
      // UPDATE returns 0 rows; follow-up probe returns the conflicting orgId.
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // UPDATE — no row matched
        .mockResolvedValueOnce({ rows: [{ existing_org_id: "org-other" }] });

      await expect(
        preserveOrgIdOnInstall("T123", "org-mine"),
      ).rejects.toThrow("already bound to a different organization (org-other)");
    });

    it("treats a same-orgId race as idempotent success", async () => {
      // UPDATE returns 0 rows (another writer beat us between WHERE eval
      // and RETURNING); probe shows the row now has the matching orgId
      // we wanted to stamp. Return success.
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ existing_org_id: "org-1" }] });

      await expect(
        preserveOrgIdOnInstall("T123", "org-1"),
      ).resolves.toBeUndefined();
    });

    it("rejects empty orgId", async () => {
      mockHasInternalDB.mockReturnValue(true);

      await expect(preserveOrgIdOnInstall("T123", "")).rejects.toThrow(
        "orgId must be non-empty",
      );
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("throws when no internal DB is configured", async () => {
      mockHasInternalDB.mockReturnValue(false);

      await expect(preserveOrgIdOnInstall("T123", "org-1")).rejects.toThrow(
        "no internal database configured",
      );
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe("deleteInstallation", () => {
    it("deletes the chat_cache row for the team", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [] });

      await expect(deleteInstallation("T123")).resolves.toBeUndefined();
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain("DELETE FROM chat_cache");
      expect(sql).toContain("WHERE key = $1");
      expect(params).toEqual(["slack:installation:T123"]);
    });

    it("resolves (with warning) when no internal DB", async () => {
      mockHasInternalDB.mockReturnValue(false);
      await expect(deleteInstallation("T123")).resolves.toBeUndefined();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe("deleteInstallationByOrg", () => {
    it("returns true when a row was deleted", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [{ key: "slack:installation:T123" }] });

      const result = await deleteInstallationByOrg("org-1");
      expect(result).toBe(true);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain("DELETE FROM chat_cache");
      expect(sql).toContain("key LIKE 'slack:installation:%'");
      expect(sql).toContain("value->>'orgId' = $1");
      expect(params).toEqual(["org-1"]);
    });

    it("returns false when no matching row", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [] });

      const result = await deleteInstallationByOrg("org-999");
      expect(result).toBe(false);
    });

    it("throws when no internal DB", async () => {
      mockHasInternalDB.mockReturnValue(false);
      await expect(deleteInstallationByOrg("org-1")).rejects.toThrow(
        "no internal database configured",
      );
    });

    it("throws when DB query fails", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockRejectedValue(new Error("connection lost"));

      await expect(deleteInstallationByOrg("org-1")).rejects.toThrow("connection lost");
    });
  });

  describe("getBotToken", () => {
    it("returns the decrypted token", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        {
          value: { botToken: "xoxb-from-cache" },
          installed_at: "2025-01-01T00:00:00.000Z",
        },
      ]);

      const token = await getBotToken("T123");
      expect(token).toBe("xoxb-from-cache");
    });

    it("returns null when no installation exists", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([]);

      const token = await getBotToken("T999");
      expect(token).toBeNull();
    });
  });
});
