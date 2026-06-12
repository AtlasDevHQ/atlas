/**
 * Tests for the thin Slack Web API client (api.ts).
 *
 * Mocks global fetch to isolate HTTP behavior.
 */

import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { slackAPI, postMessage, updateMessage, listChannels } = await import("../api");

describe("api", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: Mock<typeof globalThis.fetch>;

  beforeEach(() => {
    mockFetch = mock() as unknown as Mock<typeof globalThis.fetch>;
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("slackAPI", () => {
    it("successful call returns parsed response", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, ts: "1234.5678", channel: "C123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await slackAPI("chat.postMessage", "xoxb-token", { channel: "C123", text: "hi" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ts).toBe("1234.5678");
        expect(result.channel).toBe("C123");
      }

      // Verify fetch was called with correct URL and headers
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://slack.com/api/chat.postMessage");
      expect((init as RequestInit).method).toBe("POST");
      expect((init as RequestInit).headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer xoxb-token",
        }),
      );
    });

    it("HTTP error (non-2xx) returns { ok: false, error }", async () => {
      mockFetch.mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );

      const result = await slackAPI("chat.postMessage", "xoxb-token", { channel: "C123" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("HTTP 500");
      }
    });

    it("network error (fetch throws) returns { ok: false, error }", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await slackAPI("chat.postMessage", "xoxb-token", { channel: "C123" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("request_failed");
        expect(result.error).toContain("ECONNREFUSED");
      }
    });

    it("malformed JSON response returns error", async () => {
      mockFetch.mockResolvedValue(
        new Response("not json at all{{{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await slackAPI("chat.postMessage", "xoxb-token", { channel: "C123" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("request_failed");
      }
    });

    it("oauth.v2.access sends form-encoded body and no Bearer header", async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, access_token: "xoxb-x", team: { id: "T1", name: "Acme" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await slackAPI("oauth.v2.access", "", {
        client_id: "cid",
        client_secret: "csec",
        code: "the-code",
      });
      expect(result.ok).toBe(true);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://slack.com/api/oauth.v2.access");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Content-Type"]).toContain("application/x-www-form-urlencoded");
      expect(headers.Authorization).toBeUndefined();

      const body = (init as RequestInit).body as string;
      const parsed = new URLSearchParams(body);
      expect(parsed.get("client_id")).toBe("cid");
      expect(parsed.get("client_secret")).toBe("csec");
      expect(parsed.get("code")).toBe("the-code");
    });

    it("Slack-level error (HTTP 200, ok: false) returns the error", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await slackAPI("chat.postMessage", "xoxb-token", { channel: "CXXX" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("channel_not_found");
      }
    });
  });

  describe("postMessage", () => {
    it("delegates to slackAPI with correct method", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, ts: "1111.2222" }), { status: 200 }),
      );

      const result = await postMessage("xoxb-token", {
        channel: "C123",
        text: "hello",
        thread_ts: "1000.0001",
      });

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://slack.com/api/chat.postMessage");
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.channel).toBe("C123");
      expect(body.text).toBe("hello");
      expect(body.thread_ts).toBe("1000.0001");
    });
  });

  describe("listChannels", () => {
    function channelPage(channels: unknown[], nextCursor?: string): Response {
      return new Response(
        JSON.stringify({
          ok: true,
          channels,
          response_metadata: { next_cursor: nextCursor ?? "" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    it("GETs conversations.list with Bearer auth and projects channel fields", async () => {
      mockFetch.mockResolvedValue(
        channelPage([
          { id: "C1", name: "general", is_private: false, is_member: true },
          { id: "C2", name: "secrets", is_private: true, is_member: false },
        ]),
      );

      const result = await listChannels("xoxb-token");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.channels).toEqual([
          { id: "C1", name: "general", isPrivate: false, isMember: true },
          { id: "C2", name: "secrets", isPrivate: true, isMember: false },
        ]);
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toStartWith("https://slack.com/api/conversations.list?");
      const params = new URL(String(url)).searchParams;
      expect(params.get("types")).toBe("public_channel,private_channel");
      expect(params.get("exclude_archived")).toBe("true");
      expect((init as RequestInit).method).toBe("GET");
      expect((init as RequestInit).headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer xoxb-token" }),
      );
    });

    it("follows the pagination cursor across pages", async () => {
      mockFetch
        .mockResolvedValueOnce(
          channelPage([{ id: "C1", name: "a", is_private: false, is_member: true }], "cur-2"),
        )
        .mockResolvedValueOnce(
          channelPage([{ id: "C2", name: "b", is_private: false, is_member: true }]),
        );

      const result = await listChannels("xoxb-token");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.channels.map((ch) => ch.id)).toEqual(["C1", "C2"]);
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondUrl = String(mockFetch.mock.calls[1][0]);
      expect(new URL(secondUrl).searchParams.get("cursor")).toBe("cur-2");
    });

    it("skips structurally invalid channel entries", async () => {
      mockFetch.mockResolvedValue(
        channelPage([
          { id: "C1", name: "ok", is_private: false, is_member: true },
          { id: 42, name: "bad-id" },
          "not-an-object",
          null,
        ]),
      );

      const result = await listChannels("xoxb-token");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.channels.map((ch) => ch.id)).toEqual(["C1"]);
      }
    });

    it("returns the Slack error on ok: false", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await listChannels("xoxb-token");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("missing_scope");
      }
    });

    it("returns request_failed when fetch throws", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNRESET"));

      const result = await listChannels("xoxb-token");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("request_failed");
      }
    });
  });

  describe("updateMessage", () => {
    it("delegates to slackAPI with correct method", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const result = await updateMessage("xoxb-token", {
        channel: "C123",
        ts: "1111.2222",
        text: "updated text",
      });

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://slack.com/api/chat.update");
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.channel).toBe("C123");
      expect(body.ts).toBe("1111.2222");
      expect(body.text).toBe("updated text");
    });
  });
});
