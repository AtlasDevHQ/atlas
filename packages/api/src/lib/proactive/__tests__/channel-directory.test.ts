/**
 * Tests for the channel-directory port (#3463) and its short-TTL
 * success cache (#3461).
 *
 * The Slack default provider is mocked at the module boundary — its
 * own mapping behavior is covered by
 * `lib/slack/__tests__/channel-directory-provider.test.ts`.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Default (fallback) provider — stands in for the built-in Slack
// implementation resolved when nothing is registered.
type DirectoryResult =
  | { ok: true; channels: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }> }
  | { ok: false; reason: "no_chat_installation" | "missing_scope" | "platform_error"; detail?: string };

let fallbackResult: DirectoryResult = { ok: false, reason: "no_chat_installation" };
const fallbackListWorkspaceChannels: Mock<(workspaceId: string) => Promise<DirectoryResult>> =
  mock(async () => fallbackResult);

mock.module("@atlas/api/lib/slack/channel-directory-provider", () => ({
  slackChannelDirectoryProvider: {
    listWorkspaceChannels: fallbackListWorkspaceChannels,
  },
}));

const {
  listWorkspaceChannels,
  registerChannelDirectoryProvider,
  clearChannelDirectoryProvider,
  clearChannelDirectoryCache,
  CHANNEL_DIRECTORY_CACHE_TTL_MS,
} = await import("../channel-directory");

const okChannels = [
  { id: "C1", name: "general", isPrivate: false, isMember: true },
];

describe("channel-directory", () => {
  beforeEach(() => {
    clearChannelDirectoryProvider();
    clearChannelDirectoryCache();
    fallbackResult = { ok: false, reason: "no_chat_installation" };
    fallbackListWorkspaceChannels.mockClear();
  });

  describe("provider resolution", () => {
    it("falls back to the built-in Slack provider when nothing is registered", async () => {
      fallbackResult = { ok: true, channels: okChannels };
      const result = await listWorkspaceChannels("org-1");
      expect(result).toEqual({ ok: true, channels: okChannels });
      expect(fallbackListWorkspaceChannels).toHaveBeenCalledWith("org-1");
    });

    it("a registered provider takes precedence over the Slack fallback", async () => {
      const registeredList: Mock<(workspaceId: string) => Promise<DirectoryResult>> = mock(
        async () => ({ ok: true, channels: okChannels }),
      );
      registerChannelDirectoryProvider({ listWorkspaceChannels: registeredList });

      const result = await listWorkspaceChannels("org-1");
      expect(result.ok).toBe(true);
      expect(registeredList).toHaveBeenCalledWith("org-1");
      expect(fallbackListWorkspaceChannels).not.toHaveBeenCalled();
    });

    it("clearChannelDirectoryProvider restores the Slack fallback", async () => {
      registerChannelDirectoryProvider({
        listWorkspaceChannels: async () => ({ ok: true, channels: okChannels }),
      });
      clearChannelDirectoryProvider();

      fallbackResult = { ok: false, reason: "platform_error", detail: "x" };
      const result = await listWorkspaceChannels("org-1");
      expect(result).toEqual({ ok: false, reason: "platform_error", detail: "x" });
      expect(fallbackListWorkspaceChannels).toHaveBeenCalledTimes(1);
    });
  });

  describe("TTL cache (#3461)", () => {
    it("repeated requests within the TTL hit the provider at most once", async () => {
      const providerList: Mock<(workspaceId: string) => Promise<DirectoryResult>> = mock(
        async () => ({ ok: true, channels: okChannels }),
      );
      registerChannelDirectoryProvider({ listWorkspaceChannels: providerList });

      const first = await listWorkspaceChannels("org-1");
      const second = await listWorkspaceChannels("org-1");
      const third = await listWorkspaceChannels("org-1");

      expect(providerList).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ ok: true, channels: okChannels });
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    it("expires after the TTL and re-fetches", async () => {
      let nowMs = 1_000_000;
      const providerList: Mock<(workspaceId: string) => Promise<DirectoryResult>> = mock(
        async () => ({ ok: true, channels: okChannels }),
      );
      registerChannelDirectoryProvider({ listWorkspaceChannels: providerList });

      await listWorkspaceChannels("org-1", { now: () => nowMs });
      nowMs += CHANNEL_DIRECTORY_CACHE_TTL_MS - 1;
      await listWorkspaceChannels("org-1", { now: () => nowMs });
      expect(providerList).toHaveBeenCalledTimes(1);

      nowMs += 2; // past expiry
      await listWorkspaceChannels("org-1", { now: () => nowMs });
      expect(providerList).toHaveBeenCalledTimes(2);
    });

    it("does not cache failures — the next request retries the provider", async () => {
      const results: DirectoryResult[] = [
        { ok: false, reason: "platform_error", detail: "ratelimited" },
        { ok: true, channels: okChannels },
      ];
      const providerList: Mock<(workspaceId: string) => Promise<DirectoryResult>> = mock(
        async () => results.shift() ?? { ok: true, channels: [] },
      );
      registerChannelDirectoryProvider({ listWorkspaceChannels: providerList });

      const first = await listWorkspaceChannels("org-1");
      expect(first.ok).toBe(false);

      const second = await listWorkspaceChannels("org-1");
      expect(second).toEqual({ ok: true, channels: okChannels });
      expect(providerList).toHaveBeenCalledTimes(2);
    });

    it("concurrent cold-cache requests share one in-flight provider call", async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const providerList: Mock<(workspaceId: string) => Promise<DirectoryResult>> = mock(
        async () => {
          await gate;
          return { ok: true, channels: okChannels };
        },
      );
      registerChannelDirectoryProvider({ listWorkspaceChannels: providerList });

      const [first, second, third] = await Promise.all([
        listWorkspaceChannels("org-1"),
        listWorkspaceChannels("org-1"),
        (async () => {
          release?.();
          return listWorkspaceChannels("org-1");
        })(),
      ]);

      expect(providerList).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ ok: true, channels: okChannels });
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    it("a caller mutating the returned array cannot corrupt the cache", async () => {
      registerChannelDirectoryProvider({
        listWorkspaceChannels: async () => ({
          ok: true,
          channels: [
            { id: "C1", name: "alpha", isPrivate: false, isMember: true },
            { id: "C2", name: "beta", isPrivate: false, isMember: true },
          ],
        }),
      });

      const first = await listWorkspaceChannels("org-1");
      if (!first.ok) throw new Error("expected ok result");
      first.channels.reverse();
      first.channels.pop();

      const second = await listWorkspaceChannels("org-1");
      if (!second.ok) throw new Error("expected ok result");
      expect(second.channels.map((ch) => ch.id)).toEqual(["C1", "C2"]);
    });

    it("cache is keyed per workspace — no cross-tenant reuse", async () => {
      const seen: string[] = [];
      registerChannelDirectoryProvider({
        listWorkspaceChannels: async (workspaceId) => {
          seen.push(workspaceId);
          return {
            ok: true,
            channels: [{ id: `C-${workspaceId}`, name: workspaceId, isPrivate: false, isMember: true }],
          };
        },
      });

      const a = await listWorkspaceChannels("org-a");
      const b = await listWorkspaceChannels("org-b");
      expect(seen).toEqual(["org-a", "org-b"]);
      if (!a.ok || !b.ok) throw new Error("expected ok results");
      expect(a.channels[0].id).toBe("C-org-a");
      expect(b.channels[0].id).toBe("C-org-b");

      // Each workspace's repeat hit serves from its own entry.
      await listWorkspaceChannels("org-a");
      await listWorkspaceChannels("org-b");
      expect(seen).toEqual(["org-a", "org-b"]);
    });
  });
});
