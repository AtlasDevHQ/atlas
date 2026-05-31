/**
 * Tests for the GitHub App installation-token minter (v0.0.2 slice 6c, #3030).
 *
 * The minter signs a short-lived App JWT (RS256) and exchanges it for an
 * installation access token at `/app/installations/<id>/access_tokens`, caching
 * the result until shortly before its ~1hr expiry. These tests use an injected
 * `fetch` (never the network) + an injected clock so cache + re-mint behavior is
 * deterministic, and an ephemeral RSA keypair so the JWT actually signs.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { decodeJwt } from "jose";
import {
  getGitHubInstallationToken,
  GitHubInstallationTokenError,
  __resetInstallationTokenCacheForTests,
} from "../installation-token";

// An ephemeral PKCS8 PEM private key so the App JWT actually signs in-test.
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_ID = "123456";
const INSTALLATION_ID = "987654321";

/** A clock fixed at a known epoch so expiry math is deterministic. */
const T0_MS = 1_900_000_000_000; // some fixed ms epoch

/** Build a fetch stub that records calls and returns a fresh access-token mint. */
function mintFetch(opts: {
  token: string;
  expiresInMs: number;
  status?: number;
  nowMs?: number;
}): { fetchImpl: typeof globalThis.fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const expiresAtIso = new Date((opts.nowMs ?? T0_MS) + opts.expiresInMs).toISOString();
    return new Response(
      JSON.stringify({ token: opts.token, expires_at: expiresAtIso }),
      { status: opts.status ?? 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  __resetInstallationTokenCacheForTests();
});

afterEach(() => {
  __resetInstallationTokenCacheForTests();
});

describe("getGitHubInstallationToken — minting", () => {
  it("signs an App JWT and exchanges it for an installation token", async () => {
    const { fetchImpl, calls } = mintFetch({ token: "ghs_minted", expiresInMs: 3_600_000 });
    const token = await getGitHubInstallationToken(INSTALLATION_ID, {
      appId: APP_ID,
      privateKey: APP_PRIVATE_KEY,
      fetchImpl,
      now: () => T0_MS,
    });

    expect(token).toBe("ghs_minted");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    );

    // The Authorization header carries a signed App JWT (3 dot-segments) issued
    // by the app id, with a near-future exp.
    const authHeader = new Headers(calls[0]!.init?.headers).get("authorization");
    expect(authHeader).toMatch(/^Bearer \S+\.\S+\.\S+$/);
    const jwt = authHeader!.slice("Bearer ".length);
    const payload = decodeJwt(jwt);
    expect(payload.iss).toBe(APP_ID);
    expect(typeof payload.exp).toBe("number");
    // iat is back-dated for clock-skew tolerance (≤ now).
    expect((payload.iat as number) * 1000).toBeLessThanOrEqual(T0_MS);

    // Sends the canonical GitHub API headers.
    const accept = new Headers(calls[0]!.init?.headers).get("accept");
    expect(accept).toContain("application/vnd.github");
    expect(calls[0]!.init?.method).toBe("POST");
  });
});

describe("getGitHubInstallationToken — caching", () => {
  it("returns the cached token within the validity window without re-minting", async () => {
    const { fetchImpl, calls } = mintFetch({ token: "ghs_cached", expiresInMs: 3_600_000 });

    const first = await getGitHubInstallationToken(INSTALLATION_ID, {
      appId: APP_ID,
      privateKey: APP_PRIVATE_KEY,
      fetchImpl,
      now: () => T0_MS,
    });
    // 10 minutes later — still well within the 1hr token, outside the refresh margin.
    const second = await getGitHubInstallationToken(INSTALLATION_ID, {
      appId: APP_ID,
      privateKey: APP_PRIVATE_KEY,
      fetchImpl,
      now: () => T0_MS + 10 * 60_000,
    });

    expect(first).toBe("ghs_cached");
    expect(second).toBe("ghs_cached");
    expect(calls).toHaveLength(1); // minted once, served from cache the second time
  });

  it("re-mints transparently once the cached token nears expiry", async () => {
    // First mint: token valid for 1hr from T0.
    const firstMint = mintFetch({ token: "ghs_first", expiresInMs: 3_600_000, nowMs: T0_MS });
    const first = await getGitHubInstallationToken(INSTALLATION_ID, {
      appId: APP_ID,
      privateKey: APP_PRIVATE_KEY,
      fetchImpl: firstMint.fetchImpl,
      now: () => T0_MS,
    });
    expect(first).toBe("ghs_first");

    // 58 minutes later the cached token is within the 5-min refresh margin → re-mint.
    const lateMs = T0_MS + 58 * 60_000;
    const secondMint = mintFetch({ token: "ghs_second", expiresInMs: 3_600_000, nowMs: lateMs });
    const second = await getGitHubInstallationToken(INSTALLATION_ID, {
      appId: APP_ID,
      privateKey: APP_PRIVATE_KEY,
      fetchImpl: secondMint.fetchImpl,
      now: () => lateMs,
    });

    expect(second).toBe("ghs_second");
    expect(secondMint.calls).toHaveLength(1); // a fresh mint happened
  });

  it("caches distinct installations independently", async () => {
    const a = mintFetch({ token: "ghs_a", expiresInMs: 3_600_000 });
    const tokenA = await getGitHubInstallationToken("111", {
      appId: APP_ID, privateKey: APP_PRIVATE_KEY, fetchImpl: a.fetchImpl, now: () => T0_MS,
    });
    const b = mintFetch({ token: "ghs_b", expiresInMs: 3_600_000 });
    const tokenB = await getGitHubInstallationToken("222", {
      appId: APP_ID, privateKey: APP_PRIVATE_KEY, fetchImpl: b.fetchImpl, now: () => T0_MS,
    });

    expect(tokenA).toBe("ghs_a");
    expect(tokenB).toBe("ghs_b");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
});

describe("getGitHubInstallationToken — failure modes", () => {
  it("throws when the App id or private key is unavailable", async () => {
    await expect(
      getGitHubInstallationToken(INSTALLATION_ID, {
        appId: undefined,
        privateKey: undefined,
        now: () => T0_MS,
      }),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("throws when GitHub rejects the App JWT (non-2xx)", async () => {
    const { fetchImpl } = mintFetch({ token: "", expiresInMs: 0, status: 401 });
    await expect(
      getGitHubInstallationToken(INSTALLATION_ID, {
        appId: APP_ID,
        privateKey: APP_PRIVATE_KEY,
        fetchImpl,
        now: () => T0_MS,
      }),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("rejects a malformed installation id rather than building a path-injecting URL", async () => {
    const { fetchImpl, calls } = mintFetch({ token: "x", expiresInMs: 1000 });
    await expect(
      getGitHubInstallationToken("../../evil", {
        appId: APP_ID,
        privateKey: APP_PRIVATE_KEY,
        fetchImpl,
        now: () => T0_MS,
      }),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
    expect(calls).toHaveLength(0); // never reached the network
  });

  it("does not cache a failed mint (next call retries)", async () => {
    const failing = mintFetch({ token: "", expiresInMs: 0, status: 500 });
    await expect(
      getGitHubInstallationToken(INSTALLATION_ID, {
        appId: APP_ID, privateKey: APP_PRIVATE_KEY, fetchImpl: failing.fetchImpl, now: () => T0_MS,
      }),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);

    const ok = mintFetch({ token: "ghs_recovered", expiresInMs: 3_600_000 });
    const token = await getGitHubInstallationToken(INSTALLATION_ID, {
      appId: APP_ID, privateKey: APP_PRIVATE_KEY, fetchImpl: ok.fetchImpl, now: () => T0_MS,
    });
    expect(token).toBe("ghs_recovered");
    expect(ok.calls).toHaveLength(1);
  });
});
