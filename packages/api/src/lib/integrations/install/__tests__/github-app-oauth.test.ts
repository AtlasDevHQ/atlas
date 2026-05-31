/**
 * Tests for the shared GitHub App OAuth credential-acquisition primitives
 * (`github-app-oauth.ts`, extracted in v0.0.2 slice 6c #3030). These exercise the
 * extracted `exchangeUserCodeForToken` + `findUserInstallation` directly with an
 * injected `fetch` (no network), covering the error-shape attribution and the
 * paginated ownership walk — the threat-model-adjacent paths the action handler's
 * tests only touched at the happy/multi-page level. Both pillars (the `github`
 * action handler and the `github-data` datasource handler) consume this code, so
 * a regression here breaks installation-ownership verification for both.
 */

import { describe, expect, it } from "bun:test";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import { exchangeUserCodeForToken, findUserInstallation } from "../github-app-oauth";

const PLATFORM = "github-data";

/** An AbortError-shaped throw, simulating the fetch timeout path without waiting. */
function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

// ---------------------------------------------------------------------------
// exchangeUserCodeForToken
// ---------------------------------------------------------------------------

describe("exchangeUserCodeForToken", () => {
  const baseArgs = {
    clientId: "Iv1.test",
    clientSecret: "secret",
    code: "user-code",
    redirectUri: "https://atlas.test/callback",
    platform: PLATFORM,
  };

  it("returns the access token on a 200 JSON success", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "user-token", token_type: "bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const token = await exchangeUserCodeForToken({ ...baseArgs, fetchImpl });
    expect(token).toBe("user-token");
  });

  it("throws (attributed to platform) when GitHub returns an OAuth error body", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "bad_verification_code" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await expect(exchangeUserCodeForToken({ ...baseArgs, fetchImpl })).rejects.toMatchObject({
      platform: PLATFORM,
      upstreamError: "bad_verification_code",
    });
  });

  it("throws on a non-2xx with no usable access_token", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await expect(exchangeUserCodeForToken({ ...baseArgs, fetchImpl })).rejects.toBeInstanceOf(
      PlatformOAuthExchangeError,
    );
  });

  it("throws on an unparseable (non-JSON) token response", async () => {
    const fetchImpl = (async () =>
      new Response("<html>nope</html>", { status: 200 })) as unknown as typeof globalThis.fetch;

    await expect(exchangeUserCodeForToken({ ...baseArgs, fetchImpl })).rejects.toMatchObject({
      upstreamError: expect.stringContaining("non-json"),
    });
  });

  it("maps an aborted fetch to a timeout error", async () => {
    const fetchImpl = (async () => {
      throw abortError();
    }) as unknown as typeof globalThis.fetch;

    await expect(exchangeUserCodeForToken({ ...baseArgs, fetchImpl })).rejects.toMatchObject({
      upstreamError: "timeout",
    });
  });

  it("maps a transport failure to a network error (not timeout)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    await expect(exchangeUserCodeForToken({ ...baseArgs, fetchImpl })).rejects.toMatchObject({
      upstreamError: "ECONNREFUSED",
    });
  });
});

// ---------------------------------------------------------------------------
// findUserInstallation — the cross-tenant binding guard
// ---------------------------------------------------------------------------

interface InstallationPage {
  /** Installation ids on this page. */
  readonly ids: number[];
  /** Whether to emit a `Link: …; rel="next"` header pointing at the next page. */
  readonly hasNext: boolean;
}

/**
 * Build a `/user/installations` fetch stub that serves pages keyed by the `page`
 * query param (defaulting to 1). Records how many pages were fetched.
 */
function pagedInstallationsFetch(pages: Record<number, InstallationPage>): {
  fetchImpl: typeof globalThis.fetch;
  pageCalls: () => number;
} {
  const state = { calls: 0 };
  const fetchImpl = (async (input: string | URL) => {
    state.calls++;
    const url = typeof input === "string" ? input : input.toString();
    const pageParam = new URL(url).searchParams.get("page");
    const page = pageParam ? Number(pageParam) : 1;
    const def = pages[page] ?? { ids: [], hasNext: false };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (def.hasNext) {
      headers.link = `<https://api.github.com/user/installations?per_page=100&page=${page + 1}>; rel="next"`;
    }
    return new Response(
      JSON.stringify({
        installations: def.ids.map((id) => ({ id, account: { login: `acct-${id}`, type: "Organization" } })),
      }),
      { status: 200, headers },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, pageCalls: () => state.calls };
}

describe("findUserInstallation", () => {
  it("returns the owning account when the target is on the first page", async () => {
    const { fetchImpl, pageCalls } = pagedInstallationsFetch({ 1: { ids: [42, 7], hasNext: false } });
    const ownership = await findUserInstallation("user-token", "42", { platform: PLATFORM, fetchImpl });
    expect(ownership).toEqual({ login: "acct-42", type: "Organization" });
    expect(pageCalls()).toBe(1);
  });

  it("follows the Link header and finds the target on a later page", async () => {
    const { fetchImpl, pageCalls } = pagedInstallationsFetch({
      1: { ids: [1, 2], hasNext: true },
      2: { ids: [3, 99], hasNext: false },
    });
    const ownership = await findUserInstallation("user-token", "99", { platform: PLATFORM, fetchImpl });
    expect(ownership).toEqual({ login: "acct-99", type: "Organization" });
    expect(pageCalls()).toBe(2);
  });

  it("returns null when the user does not own the target (cross-tenant attempt)", async () => {
    const { fetchImpl } = pagedInstallationsFetch({ 1: { ids: [1, 2, 3], hasNext: false } });
    const ownership = await findUserInstallation("user-token", "404", { platform: PLATFORM, fetchImpl });
    expect(ownership).toBeNull();
  });

  it("fails closed (null) at the page cap when the target sits past it — bounded walk", async () => {
    // Every page advertises a next page but never contains the target → the walk
    // stops at MAX_INSTALLATIONS_PAGES (10) and returns null rather than looping.
    const alwaysMore: Record<number, InstallationPage> = {};
    for (let p = 1; p <= 50; p++) alwaysMore[p] = { ids: [p * 1000], hasNext: true };
    const { fetchImpl, pageCalls } = pagedInstallationsFetch(alwaysMore);

    const ownership = await findUserInstallation("user-token", "987654321", { platform: PLATFORM, fetchImpl });
    expect(ownership).toBeNull();
    expect(pageCalls()).toBe(10); // capped, not unbounded
  });

  it("throws (attributed to platform) on a non-ok installations response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(
      findUserInstallation("user-token", "42", { platform: PLATFORM, fetchImpl }),
    ).rejects.toMatchObject({ platform: PLATFORM, upstreamError: "user_installations_http_403" });
  });

  it("maps an aborted installations fetch to a timeout error", async () => {
    const fetchImpl = (async () => {
      throw abortError();
    }) as unknown as typeof globalThis.fetch;
    await expect(
      findUserInstallation("user-token", "42", { platform: PLATFORM, fetchImpl }),
    ).rejects.toMatchObject({ upstreamError: "timeout" });
  });
});
