/**
 * Edge route: POST /api/login/resolve-region (ADR-0024 §3, #3973).
 *
 * Exercises the real handler (fetch mocked) to pin the adapter logic the pure
 * `resolveRegion` tests can't reach: the per-client-IP front-door rate limiter
 * (the PRIMARY oracle control), the probeRegion HTTP-status→throw mapping (an
 * in-map 404 is INCONCLUSIVE → `error`, never a false `none`), the
 * cookie→`cookieRegion` wiring (a stale cookie never overrides the email
 * lookup — #4090), and input validation.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { NextRequest } from "next/server";
import { REGION_COOKIE } from "@/lib/api-url";

const { POST } = await import("./route");

const MAP = {
  configured: true,
  defaultRegion: "us",
  regions: [
    { id: "us", label: "United States", apiUrl: "https://api.useatlas.dev", isDefault: true },
    { id: "eu", label: "Europe", apiUrl: "https://api-eu.useatlas.dev", isDefault: false },
  ],
};

/**
 * Mock fetch: region-map returns MAP (override per test); each region-probe
 * returns exists per `probeExists[apiBase]`, or a status from `probeStatus`.
 */
let mapResponse: { body: unknown; status: number } = { body: MAP, status: 200 };
let probeExists: Record<string, boolean> = {};
let probeStatus: Record<string, number> = {};
const fetchCalls: string[] = [];

const fetchMock = mock(async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input.toString();
  fetchCalls.push(url);
  if (url.endsWith("/api/v1/auth/region-map")) {
    return new Response(JSON.stringify(mapResponse.body), {
      status: mapResponse.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.endsWith("/api/v1/auth/region-probe")) {
    const base = url.replace("/api/v1/auth/region-probe", "");
    const status = probeStatus[base];
    if (status && status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify({ exists: probeExists[base] === true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
});
const originalFetch = globalThis.fetch;

function post(email: unknown, opts: { ip?: string; cookie?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  const req = new NextRequest("http://app.useatlas.dev/api/login/resolve-region", {
    method: "POST",
    headers,
    body: JSON.stringify({ email }),
  });
  // `Cookie` is a forbidden request header on Request, so set it via the
  // NextRequest cookies API (mirrors how the browser's atlas_region cookie
  // arrives on the same-origin POST).
  if (opts.cookie) req.cookies.set(REGION_COOKIE, opts.cookie);
  return POST(req);
}

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  fetchMock.mockClear();
  fetchCalls.length = 0;
  mapResponse = { body: MAP, status: 200 };
  probeExists = {};
  probeStatus = {};
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("POST /api/login/resolve-region", () => {
  it("rejects an invalid email with 400 and no network", async () => {
    const res = await post("not-an-email", { ip: "203.0.113.20" });
    expect(res.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  it("routes a single hit (probe exists in exactly one region)", async () => {
    probeExists = { "https://api-eu.useatlas.dev": true };
    const res = await post("alice@corp.com", { ip: "203.0.113.21" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "single", region: "eu", apiUrl: "https://api-eu.useatlas.dev" });
  });

  it("returns error (NOT a false none) when a region answers 404 and none confirm a hit", async () => {
    // eu lags the rollout (probe 404 = inconclusive); us cleanly misses.
    probeStatus = { "https://api-eu.useatlas.dev": 404 };
    probeExists = { "https://api.useatlas.dev": false };
    const res = await post("alice@corp.com", { ip: "203.0.113.22" });
    expect(res.status).toBe(502);
    expect((await res.json()).outcome).toBe("error");
  });

  it("#4090: a stale atlas_region cookie never overrides the email lookup", async () => {
    // Cookie pins eu (from a signed-out EU session), but the email exists only
    // in us. The route must fan out (not short-circuit on the cookie) and route
    // to the email's TRUE region.
    const cookie = encodeURIComponent(JSON.stringify({ region: "eu", apiUrl: "https://evil.example" }));
    probeExists = { "https://api.useatlas.dev": true };
    const res = await post("matt+us@useatlas.dev", { ip: "203.0.113.23", cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "single", region: "us", apiUrl: "https://api.useatlas.dev" });
    // The fan-out ran — the cookie did NOT skip the oracle.
    expect(fetchCalls.some((u) => u.endsWith("/api/v1/auth/region-probe"))).toBe(true);
  });

  it("#4090: returns none for a non-existent email even with an atlas_region cookie", async () => {
    // No region confirms a hit; the cookie must not conjure a `single`.
    const cookie = encodeURIComponent(JSON.stringify({ region: "eu", apiUrl: "https://api-eu.useatlas.dev" }));
    probeExists = { "https://api.useatlas.dev": false, "https://api-eu.useatlas.dev": false };
    const res = await post("ghost@nowhere.com", { ip: "203.0.113.27", cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "none" });
  });

  it("returns error when the region map cannot be fetched", async () => {
    mapResponse = { body: { error: "boom" }, status: 500 };
    const res = await post("alice@corp.com", { ip: "203.0.113.24" });
    expect(res.status).toBe(502);
    expect((await res.json()).outcome).toBe("error");
  });

  it("rate-limits a single client IP after the per-IP ceiling (429)", async () => {
    const ip = "198.51.100.30";
    probeExists = { "https://api-eu.useatlas.dev": true };
    let sawLimit = false;
    for (let i = 0; i < 30; i++) {
      const res = await post("alice@corp.com", { ip });
      if (res.status === 429) {
        sawLimit = true;
        expect((await res.json()).outcome).toBe("error");
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it("buckets rate limits per IP — a fresh IP is not throttled by another IP's burst", async () => {
    const noisy = "198.51.100.31";
    probeExists = { "https://api-eu.useatlas.dev": true };
    for (let i = 0; i < 30; i++) await post("alice@corp.com", { ip: noisy });
    const res = await post("alice@corp.com", { ip: "198.51.100.32" });
    expect(res.status).toBe(200);
  });
});
