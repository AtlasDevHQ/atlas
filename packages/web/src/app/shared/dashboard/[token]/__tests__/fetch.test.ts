import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

// next/headers is request-scoped; drive it from module-level mutables so each
// test can set the viewer's cookie / forwarded IP.
let mockCookie = "";
let mockHeaders: Record<string, string> = {};

void mock.module("next/headers", () => ({
  cookies: async () => ({ toString: () => mockCookie }),
  headers: async () => ({ get: (k: string) => mockHeaders[k.toLowerCase()] ?? null }),
}));

import {
  buildForwardHeaders,
  fetchSharedDashboardRaw,
  hashShareToken,
} from "../fetch";

// A fully-valid SharedDashboardView — the fetch layer now validates the API
// response against the strict `sharedDashboardViewSchema` SSOT.
const okDashboard = {
  title: "Revenue",
  description: null,
  shareMode: "public",
  cards: [],
  parameterSummary: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-02T00:00:00.000Z",
  lastRefreshAt: null,
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

describe("buildForwardHeaders (#4317)", () => {
  test("forwards the viewer cookie + IP so org shares authenticate & rate-limit per viewer", () => {
    expect(
      buildForwardHeaders({ cookie: "session=abc", forwardedFor: "1.2.3.4", realIp: null }),
    ).toEqual({ cookie: "session=abc", "x-forwarded-for": "1.2.3.4" });
  });

  test("prefers x-forwarded-for over x-real-ip", () => {
    expect(
      buildForwardHeaders({ cookie: null, forwardedFor: "1.1.1.1", realIp: "2.2.2.2" }),
    ).toEqual({ "x-forwarded-for": "1.1.1.1" });
  });

  test("falls back to x-real-ip when no forwarded-for", () => {
    expect(
      buildForwardHeaders({ cookie: null, forwardedFor: null, realIp: "2.2.2.2" }),
    ).toEqual({ "x-forwarded-for": "2.2.2.2" });
  });

  test("omits absent headers (anonymous, direct)", () => {
    expect(buildForwardHeaders({ cookie: null, forwardedFor: null, realIp: null })).toEqual({});
  });
});

describe("hashShareToken (#4317)", () => {
  test("returns a 16-hex fingerprint, never the raw token", () => {
    const h = hashShareToken("super-secret-token");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toContain("super-secret-token");
  });

  test("is deterministic", () => {
    expect(hashShareToken("t")).toBe(hashShareToken("t"));
  });
});

describe("fetchSharedDashboardRaw (#4317)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    mockCookie = "";
    mockHeaders = {};
  });

  test("forwards the viewer cookie + IP and returns the dashboard (org-share success)", async () => {
    mockCookie = "atlas.session=xyz";
    mockHeaders = { "x-forwarded-for": "9.9.9.9" };
    const calls = stubFetch(200, okDashboard);

    const result = await fetchSharedDashboardRaw("abc123def456ghi789jkl");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("atlas.session=xyz");
    expect(headers["x-forwarded-for"]).toBe("9.9.9.9");
  });

  // #4690: the no-session viewer and the wrong-org viewer are DISTINCT reasons —
  // not one `auth-required` — so the page offers a login redirect only when
  // there's genuinely no session. The API (`dashboards.ts`) returns 403 for BOTH,
  // distinguished by the body `error` code, so the fetch layer reads the body.
  test("maps a 403 with error:auth_required (no session) to login-required", async () => {
    stubFetch(403, { error: "auth_required" });
    const result = await fetchSharedDashboardRaw("abc123def456ghi789jkl");
    expect(result).toEqual({ ok: false, reason: "login-required" });
  });

  test("maps a 403 with error:forbidden (authenticated, wrong org) to membership-required", async () => {
    stubFetch(403, { error: "forbidden" });
    const result = await fetchSharedDashboardRaw("abc123def456ghi789jkl");
    expect(result).toEqual({ ok: false, reason: "membership-required" });
  });

  test("maps a bare 401 (no session, stricter HTTP semantics) to login-required", async () => {
    stubFetch(401, { error: "auth_required" });
    const result = await fetchSharedDashboardRaw("abc123def456ghi789jkl");
    expect(result).toEqual({ ok: false, reason: "login-required" });
  });

  test("defaults an unrecognized/malformed 403 body to login-required (never dead-ends a no-session viewer)", async () => {
    // A 403 whose body carries no `forbidden` code must not be misclassified as
    // wrong-org — the safe default keeps a login path open (#4690).
    stubFetch(403, { unexpected: true });
    expect(await fetchSharedDashboardRaw("abc123def456ghi789jkl")).toEqual({
      ok: false,
      reason: "login-required",
    });
    // Body that isn't even JSON (res.json() throws) → same safe default.
    const throwingBody = mock(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: false,
        status: 403,
        json: async () => {
          throw new Error("not json");
        },
      } as Response;
    });
    globalThis.fetch = throwingBody as unknown as typeof fetch;
    expect(await fetchSharedDashboardRaw("abc123def456ghi789jkl")).toEqual({
      ok: false,
      reason: "login-required",
    });
  });

  test("maps a 410 to expired and a 404 to not-found", async () => {
    stubFetch(410, {});
    expect(await fetchSharedDashboardRaw("abc123def456ghi789jkl")).toEqual({ ok: false, reason: "expired" });
    stubFetch(404, {});
    expect(await fetchSharedDashboardRaw("abc123def456ghi789jkl")).toEqual({ ok: false, reason: "not-found" });
  });

  test("never logs the raw token — logs only its hash — on a server error (#4317)", async () => {
    const token = "abc123def456ghi789jkl";
    stubFetch(500, {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    await fetchSharedDashboardRaw(token);

    for (const call of errSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
    }
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain(hashShareToken(token));
    errSpy.mockRestore();
  });

  test("never logs the raw token on a network error (fetch throws) (#4317)", async () => {
    const token = "abc123def456ghi789jkl";
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchSharedDashboardRaw(token);
    expect(result).toEqual({ ok: false, reason: "network-error" });

    for (const call of errSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
    }
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain(hashShareToken(token));
    errSpy.mockRestore();
  });
});
