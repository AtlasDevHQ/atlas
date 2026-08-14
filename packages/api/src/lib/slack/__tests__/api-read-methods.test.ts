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
  fetchConversationMembersPage,
  fetchUserConversationsPage,
  fetchUsersListPage,
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
      { id: "U_GONE", email: "gone@corp.test", deleted: true, isBot: false },
      { id: "U_BOT", email: null, deleted: false, isBot: true },
      { id: "U_OK", email: "ok@corp.test", deleted: false, isBot: false },
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
