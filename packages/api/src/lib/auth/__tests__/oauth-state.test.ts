import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import {
  saveOAuthState,
  consumeOAuthState,
  cleanExpiredOAuthState,
  _resetMemoryFallback,
} from "@atlas/api/lib/auth/oauth-state";

// Mock internal DB as unavailable — tests exercise the in-memory fallback
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  internalQuery: () => Promise.reject(new Error("should not be called")),
}));

// Mock logger to suppress output
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

describe("oauth-state (in-memory fallback)", () => {
  beforeEach(() => {
    _resetMemoryFallback();
  });

  afterEach(() => {
    _resetMemoryFallback();
  });

  it("round-trip: save then consume returns correct data", async () => {
    const nonce = crypto.randomUUID();
    await saveOAuthState(nonce, { orgId: "org-1", provider: "discord" });

    const result = await consumeOAuthState(nonce);
    expect(result).toEqual({ orgId: "org-1", provider: "discord" });
  });

  it("single-use: second consume returns null", async () => {
    const nonce = crypto.randomUUID();
    await saveOAuthState(nonce, { orgId: "org-1", provider: "teams" });

    const first = await consumeOAuthState(nonce);
    expect(first).not.toBeNull();

    const second = await consumeOAuthState(nonce);
    expect(second).toBeNull();
  });

  it("expired state returns null", async () => {
    const nonce = crypto.randomUUID();
    // TTL of 0ms → already expired by the time we consume
    await saveOAuthState(nonce, { orgId: "org-1", provider: "discord", ttlMs: 0 });

    // Small delay to ensure Date.now() advances past expiry
    await new Promise((r) => setTimeout(r, 5));

    const result = await consumeOAuthState(nonce);
    expect(result).toBeNull();
  });

  it("unknown nonce returns null", async () => {
    const result = await consumeOAuthState("nonexistent-nonce");
    expect(result).toBeNull();
  });

  it("preserves orgId: undefined when no orgId provided", async () => {
    const nonce = crypto.randomUUID();
    await saveOAuthState(nonce, { provider: "teams" });

    const result = await consumeOAuthState(nonce);
    expect(result).toEqual({ orgId: undefined, provider: "teams" });
  });

  it("returns correct provider for each integration", async () => {
    const discordNonce = crypto.randomUUID();
    const teamsNonce = crypto.randomUUID();

    await saveOAuthState(discordNonce, { orgId: "org-1", provider: "discord" });
    await saveOAuthState(teamsNonce, { orgId: "org-1", provider: "teams" });

    const discordResult = await consumeOAuthState(discordNonce);
    expect(discordResult?.provider).toBe("discord");

    const teamsResult = await consumeOAuthState(teamsNonce);
    expect(teamsResult?.provider).toBe("teams");
  });

  describe("cleanExpiredOAuthState", () => {
    it("removes only expired entries", async () => {
      const expiredNonce = crypto.randomUUID();
      const freshNonce = crypto.randomUUID();

      await saveOAuthState(expiredNonce, { provider: "discord", ttlMs: 0 });
      await saveOAuthState(freshNonce, { provider: "teams", ttlMs: 600_000 });

      await new Promise((r) => setTimeout(r, 5));
      await cleanExpiredOAuthState();

      const expiredResult = await consumeOAuthState(expiredNonce);
      expect(expiredResult).toBeNull();

      const freshResult = await consumeOAuthState(freshNonce);
      expect(freshResult).not.toBeNull();
      expect(freshResult?.provider).toBe("teams");
    });
  });
});
