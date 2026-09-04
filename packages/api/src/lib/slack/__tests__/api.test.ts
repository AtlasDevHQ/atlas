/**
 * Tests for the thin Slack Web API client (api.ts) — write/post methods and
 * the paginated read methods, merged into one suite (formerly
 * api-read-methods.test.ts).
 *
 * Mocks global fetch to isolate HTTP behavior.
 */

import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const {
  slackAPI,
  postMessage,
  updateMessage,
  listChannels,
  getConversationInfo,
  fetchConversationHistoryPage,
  fetchConversationMembersPage,
  fetchConversationsListPage,
  fetchUserConversationsPage,
  fetchUsersListPage,
} = await import("../api");

// Narrow the fetch first-arg union (string | URL | Request) to its URL string
// without base-stringifying a Request (which would yield "[object Request]").
const urlOf = (u: string | URL | Request): string =>
  typeof u === "string" ? u : u instanceof URL ? u.toString() : u.url;

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
      expect(urlOf(url)).toStartWith("https://slack.com/api/conversations.list?");
      const params = new URL(urlOf(url)).searchParams;
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
      const secondUrl = urlOf(mockFetch.mock.calls[1][0]);
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

    it("returns the Slack error on ok: false without retrying non-scope errors", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await listChannels("xoxb-token");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("ratelimited");
      }
      // Only missing_scope triggers the public-only retry (#3462).
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries public-only when the combined listing fails missing_scope (#3462)", async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          channelPage([{ id: "C1", name: "general", is_private: false, is_member: true }]),
        );

      const result = await listChannels("xoxb-token");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.channels).toEqual([
          { id: "C1", name: "general", isPrivate: false, isMember: true },
        ]);
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const firstParams = new URL(urlOf(mockFetch.mock.calls[0][0])).searchParams;
      expect(firstParams.get("types")).toBe("public_channel,private_channel");
      const retryParams = new URL(urlOf(mockFetch.mock.calls[1][0])).searchParams;
      expect(retryParams.get("types")).toBe("public_channel");
    });

    it("retries at most once — persistent missing_scope surfaces as the error", async () => {
      // Fresh Response per call — a body can only be consumed once.
      const scopeError = () =>
        new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      mockFetch.mockResolvedValueOnce(scopeError()).mockResolvedValueOnce(scopeError());

      const result = await listChannels("xoxb-token");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("missing_scope");
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
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

// ==========================================================================
// Read methods — formerly api-read-methods.test.ts.
// ==========================================================================
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

// ---------------------------------------------------------------------------
// Audience-membership reads (#4801)
// ---------------------------------------------------------------------------
//
// These two parsers sit upstream of a DELETE. `lib/brain/audience/sync.ts`
// reconciles `fact_audience_member` against what they return, so a parser that
// under-reports does not merely lose data — it REVOKES the people it dropped.
// Everything below is therefore about refusing to under-report, driven by raw
// Slack JSON rather than by a hand-built page.

describe("fetchConversationMembersPage", () => {
  it("returns the roster and the cursor", async () => {
    respondWith({
      ok: true,
      members: ["U1", "U2"],
      response_metadata: { next_cursor: "c2" },
    });
    const result = await fetchConversationMembersPage("t", { channel: "C1", limit: 200 });
    expect(result.ok && result.memberIds).toEqual(["U1", "U2"]);
    expect(result.ok && result.nextCursor).toBe("c2");
  });

  it("normalises an empty next_cursor to null", async () => {
    respondWith({ ok: true, members: [], response_metadata: { next_cursor: "" } });
    const result = await fetchConversationMembersPage("t", { channel: "C1", limit: 200 });
    expect(result.ok && result.nextCursor).toBeNull();
  });

  it("REFUSES a non-array `members` rather than reading it as an empty roster", async () => {
    // An empty roster is a legal instruction to revoke the whole audience, so a
    // protocol violation must never wear that costume.
    respondWith({ ok: true, members: null });
    const result = await fetchConversationMembersPage("t", { channel: "C1", limit: 200 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("malformed_members_page");
  });

  it("REFUSES a page containing any unusable member id", async () => {
    // Dropping the bad entry and keeping the rest would silently understate the
    // roster by one person — and understating the roster is revoking someone.
    respondWith({ ok: true, members: ["U1", 42, ""] });
    const result = await fetchConversationMembersPage("t", { channel: "C1", limit: 200 });
    expect(result.ok === false && result.error).toBe("malformed_members_page");
  });

  it("surfaces missing_scope rather than an empty roster", async () => {
    respondWith({ ok: false, error: "missing_scope" });
    const result = await fetchConversationMembersPage("t", { channel: "C1", limit: 200 });
    expect(result.ok === false && result.error).toBe("missing_scope");
  });

  it("sends the cursor only when given", async () => {
    let seen = "";
    globalThis.fetch = (async (url: string | URL) => {
      seen = String(url);
      return new Response(JSON.stringify({ ok: true, members: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    await fetchConversationMembersPage("t", { channel: "C1", limit: 200 });
    expect(seen).toContain("channel=C1");
    expect(seen).not.toContain("cursor=");
    await fetchConversationMembersPage("t", { channel: "C1", limit: 200, cursor: "c9" });
    expect(seen).toContain("cursor=c9");
  });
});

describe("fetchUsersListPage", () => {
  it("reads the email from profile.email, not from the top level", async () => {
    // The field path is the whole join key. Reading `u.email` (which Slack does
    // not send) would yield a directory of nulls — indistinguishable from a
    // token missing `users:read.email`, and it would disable every workspace
    // permanently with a "reconnect Slack" warning that could never fix it.
    respondWith({
      ok: true,
      members: [{ id: "U1", profile: { email: "ada@corp.test" }, email: "wrong@corp.test" }],
    });
    const result = await fetchUsersListPage("t", { limit: 200 });
    expect(result.ok && result.users[0]?.email).toBe("ada@corp.test");
  });

  it("maps deleted and is_bot from Slack's own field names", async () => {
    // A mis-keyed `deleted` would let deactivated Slack accounts KEEP audience
    // access — the acceptance criterion inverted. The downstream filter test
    // uses hand-built fixtures, so this is the only place the mapping is pinned.
    respondWith({
      ok: true,
      members: [
        { id: "U_GONE", deleted: true, profile: { email: "gone@corp.test" } },
        { id: "U_BOT", is_bot: true, profile: {} },
        { id: "U_OK", profile: { email: "ok@corp.test" } },
      ],
    });
    const result = await fetchUsersListPage("t", { limit: 200 });
    expect(result.ok && result.users).toEqual([
      { id: "U_GONE", email: "gone@corp.test", displayName: null, realName: null, deleted: true, isBot: false },
      { id: "U_BOT", email: null, displayName: null, realName: null, deleted: false, isBot: true },
      { id: "U_OK", email: "ok@corp.test", displayName: null, realName: null, deleted: false, isBot: false },
    ]);
  });

  it("treats a missing, empty, or non-string email as null", async () => {
    respondWith({
      ok: true,
      members: [
        { id: "U1", profile: {} },
        { id: "U2", profile: { email: "" } },
        { id: "U3", profile: { email: 7 } },
        { id: "U4" },
      ],
    });
    const result = await fetchUsersListPage("t", { limit: 200 });
    expect(result.ok && result.users.every((u) => u.email === null)).toBe(true);
  });

  it("COUNTS unidentifiable entries in `dropped` rather than hiding the loss", async () => {
    // The caller treats `dropped > 0` as a read fault, because a directory entry
    // Atlas could not identify is a roster member it cannot resolve — and an
    // unresolved member is revoked. Without the count the loss is invisible.
    respondWith({ ok: true, members: [{ id: "U1", profile: {} }, null, { profile: {} }, "nope"] });
    const result = await fetchUsersListPage("t", { limit: 200 });
    expect(result.ok && result.users).toHaveLength(1);
    expect(result.ok && result.dropped).toBe(3);
  });

  it("REFUSES a non-array `members`", async () => {
    respondWith({ ok: true, members: { U1: {} } });
    const result = await fetchUsersListPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("malformed_users_page");
  });

  it("surfaces missing_scope rather than a directory of nulls", async () => {
    respondWith({ ok: false, error: "missing_scope" });
    const result = await fetchUsersListPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("missing_scope");
  });

  it("sends the cursor only when given", async () => {
    let seen = "";
    globalThis.fetch = (async (url: string | URL) => {
      seen = String(url);
      return new Response(JSON.stringify({ ok: true, members: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    await fetchUsersListPage("t", { limit: 200 });
    expect(seen).not.toContain("cursor=");
    await fetchUsersListPage("t", { limit: 200, cursor: "c9" });
    expect(seen).toContain("cursor=c9");
  });
});

describe("fetchUserConversationsPage (#5203)", () => {
  // Since #5203 this method's result IS the brain's ingest scope, and the
  // caller RETIRES stored channels absent from a complete walk — so every
  // refusal branch here is a channel-retirement guard, not politeness.

  it("returns the bot's memberships with isMember pinned true and archived kept", async () => {
    respondWith({
      ok: true,
      channels: [
        { id: "C1", name: "general", is_private: false },
        { id: "G2", name: "exec", is_private: true, is_archived: true },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = await fetchUserConversationsPage("t", { limit: 200 });
    expect(result).toEqual({
      ok: true,
      channels: [
        { id: "C1", name: "general", isPrivate: false, isMember: true, isArchived: false },
        { id: "G2", name: "exec", isPrivate: true, isMember: true, isArchived: true },
      ],
      nextCursor: null,
    });
  });

  it("requests both channel types, keeps archived channels, and forwards the cursor", async () => {
    let seen = "";
    globalThis.fetch = (async (url: string | URL) => {
      seen = String(url);
      return new Response(JSON.stringify({ ok: true, channels: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    await fetchUserConversationsPage("t", { limit: 200 });
    expect(seen).toContain("types=public_channel%2Cprivate_channel");
    // Archived channels stay in scope — their history is still evidence.
    expect(seen).toContain("exclude_archived=false");
    expect(seen).not.toContain("cursor=");
    await fetchUserConversationsPage("t", { limit: 200, cursor: "c7" });
    expect(seen).toContain("cursor=c7");
  });

  it("refuses a page whose entry lacks is_private — the org-wide-publish guard", async () => {
    respondWith({
      ok: true,
      channels: [
        { id: "C1", name: "general", is_private: false },
        { id: "G2", name: "exec" }, // no is_private — defaulting it false would publish it
      ],
    });
    const result = await fetchUserConversationsPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("malformed_conversations_page");
  });

  it("refuses a page whose entry has no usable id — an understated page RETIRES channels", async () => {
    respondWith({
      ok: true,
      channels: [{ id: "", name: "ghost", is_private: false }],
    });
    const result = await fetchUserConversationsPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("malformed_conversations_page");
  });

  it("refuses ok:true with a non-array channels rather than reading an empty membership", async () => {
    respondWith({ ok: true, channels: "surprise" });
    const result = await fetchUserConversationsPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("malformed_conversations_page");
  });

  it("surfaces missing_scope instead of retrying public-only — partial scope is silent narrowing", async () => {
    respondWith({ ok: false, error: "missing_scope" });
    const result = await fetchUserConversationsPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("missing_scope");
  });

  it("carries a non-empty next_cursor through", async () => {
    respondWith({
      ok: true,
      channels: [{ id: "C1", name: "a", is_private: false }],
      response_metadata: { next_cursor: "page-2" },
    });
    const result = await fetchUserConversationsPage("t", { limit: 200 });
    expect(result.ok === true && result.nextCursor).toBe("page-2");
  });
});

describe("fetchConversationsListPage (#5213)", () => {
  // This one backs the Coverage Surface's chat DENOMINATOR, and the caller
  // sweeps its roster against what comes back — so, exactly like
  // `fetchUserConversationsPage` above, every refusal branch here is a
  // unit-retirement guard rather than politeness. Its two request parameters are
  // load-bearing in opposite directions: `types` decides what may be NAMED,
  // `exclude_archived` decides the size of the denominator.

  it("asks for PUBLIC channels only, keeps archived ones, and forwards the cursor", async () => {
    let seen = "";
    globalThis.fetch = (async (url: string | URL) => {
      seen = String(url);
      return new Response(JSON.stringify({ ok: true, channels: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    await fetchConversationsListPage("t", { limit: 200 });
    // PUBLIC ONLY. `types` is what the vendor-public clause leans on: a widened
    // request hands the caller rows Slack calls private, which `readPublicRoster`
    // then drops with a warn — a denominator that silently disagrees with the
    // request that produced it. (Private perimeter channels ARE labelled, under
    // the deliberate-act clause; that is a different clause and a different
    // path.)
    expect(seen).toContain("types=public_channel");
    expect(seen).not.toContain("private_channel");
    // Archived channels stay IN the denominator: their history is still
    // evidence, and dropping them would shrink the denominator whenever someone
    // archived a channel — which RAISES the ratio, the flattering direction.
    expect(seen).toContain("exclude_archived=false");
    expect(seen).not.toContain("cursor=");

    await fetchConversationsListPage("t", { limit: 200, cursor: "c7" });
    expect(seen).toContain("cursor=c7");
  });

  it("reads membership off the PAYLOAD, unlike users.conversations", async () => {
    respondWith({
      ok: true,
      channels: [
        { id: "C1", name: "general", is_private: false, is_member: true },
        { id: "C2", name: "random", is_private: false, is_member: false, is_archived: true },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = await fetchConversationsListPage("t", { limit: 200 });
    // This method enumerates the WORKSPACE, so membership is a property of the
    // row. `fetchUserConversationsPage` pins it `true` because the endpoint
    // means membership; pinning it here would contradict half the roster.
    expect(result).toEqual({
      ok: true,
      channels: [
        { id: "C1", name: "general", isPrivate: false, isMember: true, isArchived: false },
        { id: "C2", name: "random", isPrivate: false, isMember: false, isArchived: true },
      ],
      nextCursor: null,
    });
  });

  it("returns a NULL name rather than the id — an id in a label column is not a name", async () => {
    respondWith({ ok: true, channels: [{ id: "C1", is_private: false }] });
    const result = await fetchConversationsListPage("t", { limit: 200 });
    expect(result.ok === true && result.channels[0]?.name).toBeNull();
  });

  it("refuses a page whose entry lacks is_private — the clause is decided on what Slack SAID", async () => {
    // Not on what we asked for. Inferring `false` from `types=public_channel`
    // would name a channel on the strength of our own query parameter.
    respondWith({
      ok: true,
      channels: [
        { id: "C1", name: "general", is_private: false },
        { id: "C2", name: "mystery" },
      ],
    });
    const result = await fetchConversationsListPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("malformed_conversations_page");
  });

  it("refuses a page whose entry has no usable id — an understated page RETIRES units", async () => {
    respondWith({ ok: true, channels: [{ id: "", name: "ghost", is_private: false }] });
    const result = await fetchConversationsListPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("malformed_conversations_page");
  });

  it("refuses ok:true with a non-array channels rather than reading an empty roster", async () => {
    respondWith({ ok: true, channels: "surprise" });
    const result = await fetchConversationsListPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("malformed_conversations_page");
  });

  it("surfaces missing_scope rather than absorbing it like listChannels does", async () => {
    // `listChannels` silently retries public-only and returns the narrower
    // listing as a SUCCESS. Fine for a picker; for a denominator it is an
    // understatement the caller can never see, so this one reports it and lets
    // the caller raise the map edge.
    respondWith({ ok: false, error: "missing_scope" });
    const result = await fetchConversationsListPage("t", { limit: 200 });
    expect(result.ok === false && result.error).toBe("missing_scope");
  });

  it("carries a non-empty next_cursor through", async () => {
    respondWith({
      ok: true,
      channels: [{ id: "C1", name: "a", is_private: false }],
      response_metadata: { next_cursor: "page-2" },
    });
    const result = await fetchConversationsListPage("t", { limit: 200 });
    expect(result.ok === true && result.nextCursor).toBe("page-2");
  });
});
