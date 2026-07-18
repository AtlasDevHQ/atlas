import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

// next/headers is request-scoped; drive it from module-level mutables so each
// test can set the viewer's cookie / forwarded IP.
let mockCookie = "";
let mockHeaders: Record<string, string> = {};

void mock.module("next/headers", () => ({
  cookies: async () => ({ toString: () => mockCookie }),
  headers: async () => ({ get: (k: string) => mockHeaders[k.toLowerCase()] ?? null }),
}));

import { fetchSharedConversationRaw, hashShareToken } from "../fetch";

const TOKEN = "abc123def456ghi789jkl";

const okConversation = {
  title: "Revenue Analysis",
  surface: "web",
  createdAt: "2026-03-12T00:00:00Z",
  shareMode: "org",
  messages: [
    { role: "user", content: "What were our top customers?", createdAt: "2026-03-12T00:00:00Z" },
    { role: "assistant", content: "Here are the results.", createdAt: "2026-03-12T00:00:01Z" },
  ],
};

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return calls;
}

// #4719 — the shared CONVERSATION surface adopts the hardened dashboard share
// pattern: no-store (revoked links die immediately), viewer header forwarding
// (org-share auth + per-viewer rate limiting), token-hash-only logging, and
// the #4690 login/membership split via the shared response mapper.
describe("fetchSharedConversationRaw (#4719)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    mockCookie = "";
    mockHeaders = {};
  });

  test("fetches with cache: no-store — a revoked share must die immediately, no 60s window", async () => {
    const calls = stubFetch(200, okConversation);
    const result = await fetchSharedConversationRaw(TOKEN);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.cache).toBe("no-store");
    // The old revalidate window is gone entirely.
    expect((calls[0]!.init as { next?: unknown }).next).toBeUndefined();
  });

  test("forwards the viewer cookie + IP so org shares authenticate & rate-limit per viewer", async () => {
    mockCookie = "atlas.session=xyz";
    mockHeaders = { "x-forwarded-for": "9.9.9.9" };
    const calls = stubFetch(200, okConversation);

    const result = await fetchSharedConversationRaw(TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.title).toBe("Revenue Analysis");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("atlas.session=xyz");
    expect(headers["x-forwarded-for"]).toBe("9.9.9.9");
  });

  test("falls back to x-real-ip for the rate-limit attribution when no x-forwarded-for", async () => {
    mockHeaders = { "x-real-ip": "2.2.2.2" };
    const calls = stubFetch(200, okConversation);
    await fetchSharedConversationRaw(TOKEN);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["x-forwarded-for"]).toBe("2.2.2.2");
  });

  test("encodes the token in the fetch URL", async () => {
    const calls = stubFetch(404, {});
    await fetchSharedConversationRaw("tok/en+special");
    expect(calls[0]!.url).toContain("tok%2Fen%2Bspecial");
  });

  // #4690 split, via the shared mapper: the API (`conversations.ts`) returns
  // 403 for BOTH the no-session and the wrong-org viewer, distinguished only by
  // the body's `error` code.
  test("maps a 403 with error:auth_required (no session) to login-required", async () => {
    stubFetch(403, { error: "auth_required" });
    expect(await fetchSharedConversationRaw(TOKEN)).toEqual({
      ok: false,
      reason: "login-required",
    });
  });

  test("maps a 403 with error:forbidden (authenticated, wrong org) to membership-required", async () => {
    stubFetch(403, { error: "forbidden" });
    expect(await fetchSharedConversationRaw(TOKEN)).toEqual({
      ok: false,
      reason: "membership-required",
    });
  });

  test("maps a bare 401 to login-required regardless of body", async () => {
    stubFetch(401, { error: "forbidden" });
    expect(await fetchSharedConversationRaw(TOKEN)).toEqual({
      ok: false,
      reason: "login-required",
    });
  });

  test("maps a 404 to not-found and a 410 to expired (revoked/expired links)", async () => {
    stubFetch(404, {});
    expect(await fetchSharedConversationRaw(TOKEN)).toEqual({ ok: false, reason: "not-found" });
    stubFetch(410, {});
    expect(await fetchSharedConversationRaw(TOKEN)).toEqual({ ok: false, reason: "expired" });
  });

  test("maps a malformed body shape (no messages array) to server-error", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { error: "bad" });
    expect(await fetchSharedConversationRaw(TOKEN)).toEqual({
      ok: false,
      reason: "server-error",
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("a 200 whose body isn't JSON resolves to server-error — never a rejection", async () => {
    globalThis.fetch = mock(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    await expect(fetchSharedConversationRaw(TOKEN)).resolves.toEqual({
      ok: false,
      reason: "server-error",
    });
    errSpy.mockRestore();
  });

  test("does not log for 404 responses", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    stubFetch(404, {});
    await fetchSharedConversationRaw(TOKEN);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("never logs the raw token — logs only its hash — on a server error (#4317)", async () => {
    stubFetch(500, {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    await fetchSharedConversationRaw(TOKEN);

    for (const call of errSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain(hashShareToken(TOKEN));
    errSpy.mockRestore();
  });

  test("never logs the raw token on a network error (fetch throws) (#4317)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchSharedConversationRaw(TOKEN);
    expect(result).toEqual({ ok: false, reason: "network-error" });

    for (const call of errSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain(hashShareToken(TOKEN));
    errSpy.mockRestore();
  });

  test("never logs the raw token on a malformed-shape error (#4317)", async () => {
    stubFetch(200, { error: "bad" });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    await fetchSharedConversationRaw(TOKEN);

    for (const call of errSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain(hashShareToken(TOKEN));
    errSpy.mockRestore();
  });
});
