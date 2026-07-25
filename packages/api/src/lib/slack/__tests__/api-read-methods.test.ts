/**
 * The Slack read methods the brain chat-history source drives (#4770).
 *
 * Three of these branches are load-bearing in ways their size hides:
 *
 *   - **`missing_visibility` is a SECURITY branch.** Defaulting a missing
 *     `is_private` to `false` would publish an invite-only channel's contents
 *     org-wide, and no review gate downstream can catch it — the reviewer sees
 *     the grant Atlas derived, not the one Slack had.
 *   - **`malformed_history_page` is an EVIDENCE branch.** Reading a non-array
 *     `messages` as "empty channel" lets the caller mark a window covered and
 *     advance past everything in it, permanently, in a store where nothing
 *     later notices.
 *   - **`Retry-After` parsing drives the shared engine's backoff.** Losing it
 *     makes every throttled cycle sleep the default instead of what Slack
 *     asked for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  fetchConversationHistoryPage,
  getConversationInfo,
} from "@atlas/api/lib/slack/api";

const realFetch = globalThis.fetch;

/** Script one response. `headers` are merged into the Response's own. */
function respondWith(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    })) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("getConversationInfo", () => {
  it("returns the channel's visibility and membership", async () => {
    respondWith({
      ok: true,
      channel: { id: "C1", name: "general", is_private: false, is_member: true },
    });
    const result = await getConversationInfo("t", "C1");
    expect(result).toEqual({
      ok: true,
      channel: { id: "C1", name: "general", isPrivate: false, isMember: true, isArchived: false },
    });
  });

  it("REFUSES a channel payload with no is_private rather than assuming public", async () => {
    respondWith({ ok: true, channel: { id: "C1", name: "general" } });
    const result = await getConversationInfo("t", "C1");
    expect(result).toEqual({ ok: false, error: "missing_visibility", retryAfterSeconds: null });
  });

  it("refuses a response with no channel object", async () => {
    respondWith({ ok: true });
    const result = await getConversationInfo("t", "C1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("malformed_channel");
  });

  it("passes Slack's own error code through", async () => {
    respondWith({ ok: false, error: "channel_not_found" });
    const result = await getConversationInfo("t", "C1");
    expect(result).toEqual({ ok: false, error: "channel_not_found", retryAfterSeconds: null });
  });
});

describe("rate-limit signalling", () => {
  it("parses Retry-After from a 429", async () => {
    respondWith({}, { status: 429, headers: { "retry-after": "42" } });
    const result = await getConversationInfo("t", "C1");
    expect(result).toEqual({ ok: false, error: "ratelimited", retryAfterSeconds: 42 });
  });

  it("reports a 429 with no usable Retry-After as null, not zero", async () => {
    // Null means "the engine picks its default wait"; zero would mean "retry
    // immediately", which is the opposite instruction.
    const headerSets: Record<string, string>[] = [{}, { "retry-after": "soon" }, { "retry-after": "-5" }];
    for (const headers of headerSets) {
      respondWith({}, { status: 429, headers });
      const result = await getConversationInfo("t", "C1");
      expect(result).toEqual({ ok: false, error: "ratelimited", retryAfterSeconds: null });
    }
  });

  it("treats an in-body `ratelimited` as throttling too", async () => {
    // Some Slack tiers signal in-body on a 200. Counting it as a hard failure
    // would skip the engine's backoff entirely.
    respondWith({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "7" } });
    const result = await getConversationInfo("t", "C1");
    expect(result).toEqual({ ok: false, error: "ratelimited", retryAfterSeconds: 7 });
  });
});

describe("fetchConversationHistoryPage", () => {
  it("narrows a page and reports the pagination cursor", async () => {
    respondWith({
      ok: true,
      messages: [
        { ts: "1.000001", text: "hi", user: "U1" },
        { ts: "1.000002", text: "there", user: "U2", subtype: "thread_broadcast", bot_id: "B1" },
      ],
      response_metadata: { next_cursor: "abc" },
    });
    const result = await fetchConversationHistoryPage("t", { channel: "C1", limit: 200 });
    expect(result).toEqual({
      ok: true,
      messages: [
        { ts: "1.000001", text: "hi", user: "U1", subtype: null, botId: null },
        { ts: "1.000002", text: "there", user: "U2", subtype: "thread_broadcast", botId: "B1" },
      ],
      nextCursor: "abc",
      dropped: 0,
    });
  });

  it("REFUSES an ok:true response whose messages is not an array", async () => {
    // Reading this as an empty page would let the caller mark the whole window
    // covered and advance past it — silent, permanent evidence loss.
    respondWith({ ok: true, messages: { "0": { ts: "1.0" } } });
    const result = await fetchConversationHistoryPage("t", { channel: "C1", limit: 200 });
    expect(result).toEqual({ ok: false, error: "malformed_history_page", retryAfterSeconds: null });
  });

  it("counts messages with no usable identity instead of dropping them silently", async () => {
    respondWith({
      ok: true,
      messages: [{ ts: "1.000001", text: "kept" }, { text: "no ts" }, null, { ts: "", text: "blank ts" }],
    });
    const result = await fetchConversationHistoryPage("t", { channel: "C1", limit: 200 });
    expect(result.ok && result.messages).toHaveLength(1);
    expect(result.ok && result.dropped).toBe(3);
  });

  it("treats an empty next_cursor as the last page", async () => {
    // An empty-string cursor read as a page would loop forever.
    respondWith({ ok: true, messages: [], response_metadata: { next_cursor: "" } });
    const result = await fetchConversationHistoryPage("t", { channel: "C1", limit: 200 });
    expect(result.ok && result.nextCursor).toBeNull();
  });

  it("sends oldest / latest / cursor only when given", async () => {
    let seen = "";
    globalThis.fetch = (async (url: string | URL) => {
      seen = String(url);
      return new Response(JSON.stringify({ ok: true, messages: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    await fetchConversationHistoryPage("t", { channel: "C1", limit: 200, oldest: "1.0" });
    expect(seen).toContain("oldest=1.0");
    expect(seen).not.toContain("latest=");
    expect(seen).not.toContain("cursor=");
  });

  it("reports a transport failure rather than an empty page", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;
    const result = await fetchConversationHistoryPage("t", { channel: "C1", limit: 200 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("request_failed");
  });

  it("reports a non-2xx as an HTTP error", async () => {
    respondWith("nope", { status: 503 });
    const result = await fetchConversationHistoryPage("t", { channel: "C1", limit: 200 });
    expect(result.ok === false && result.error).toBe("HTTP 503");
  });
});
