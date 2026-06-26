/**
 * Region-routing front-door endpoints (ADR-0024 §3, #3973):
 *   - projectRegionMap (pure projection)
 *   - POST /region-probe (the hashed-email existence oracle)
 *   - GET  /region-map  (the not-configured branch)
 *
 * The probe is the security-critical surface: hash-only input, boolean-only
 * output, per-IP rate-limiting, managed-mode gated. These tests pin all four.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// --- Controllable auth-mode mock (all value exports preserved) ---
import * as realDetect from "@atlas/api/lib/auth/detect";
let authMode: string = "managed";
mock.module("@atlas/api/lib/auth/detect", () => ({
  ...realDetect,
  detectAuthMode: () => authMode,
}));

// --- Controllable internal-DB mock (spread real, override the two we use) ---
import * as realInternal from "@atlas/api/lib/db/internal";
let internalDbAvailable = true;
let existsResult = false;
let queryThrows = false;
let internalQueryCalls: Array<{ sql: string; params?: unknown[] }> = [];
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => internalDbAvailable,
  internalQuery: async (sql: string, params?: unknown[]) => {
    internalQueryCalls.push({ sql, params });
    if (queryThrows) throw new Error("simulated DB failure");
    return [{ exists: existsResult }];
  },
}));

// Import AFTER the mocks so the route binds to the mocked modules.
const { regionRouting, projectRegionMap, _resetRegionProbeRateLimit } = await import(
  "../region-routing"
);

const HASH = "a".repeat(64); // a valid 64-char lowercase hex sha256

function probe(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    regionRouting.request("/region-probe", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("projectRegionMap", () => {
  const regions = {
    us: { label: "United States", databaseUrl: "postgres://us", apiUrl: "https://api.useatlas.dev" },
    eu: { label: "Europe", databaseUrl: "postgres://eu", apiUrl: "https://api-eu.useatlas.dev" },
    apac: { label: "Asia Pacific", databaseUrl: "postgres://apac", apiUrl: "https://api-apac.useatlas.dev" },
    staging: {
      label: "Staging",
      databaseUrl: "postgres://staging",
      apiUrl: "https://api.staging.useatlas.dev",
      selectable: false as const,
    },
  };

  it("projects selectable regions with apiUrl and marks the default", () => {
    const map = projectRegionMap(regions, "us");
    expect(map).toHaveLength(3); // staging excluded
    const us = map.find((r) => r.id === "us");
    expect(us).toEqual({ id: "us", label: "United States", apiUrl: "https://api.useatlas.dev", isDefault: true });
    expect(map.find((r) => r.id === "eu")?.isDefault).toBe(false);
  });

  it("excludes the non-selectable staging arm (#3948)", () => {
    const map = projectRegionMap(regions, "us");
    expect(map.some((r) => r.id === "staging")).toBe(false);
  });

  it("excludes a selectable region that has no configured apiUrl (cannot be probed)", () => {
    const map = projectRegionMap(
      { ...regions, ghost: { label: "Ghost", databaseUrl: "postgres://ghost" } },
      "us",
    );
    expect(map.some((r) => r.id === "ghost")).toBe(false);
  });
});

describe("POST /region-probe", () => {
  beforeEach(() => {
    authMode = "managed";
    internalDbAvailable = true;
    existsResult = false;
    queryThrows = false;
    internalQueryCalls = [];
    _resetRegionProbeRateLimit();
    process.env.ATLAS_TRUST_PROXY = "true";
  });
  afterEach(() => {
    delete process.env.ATLAS_TRUST_PROXY;
  });

  it("returns { exists: true } when the region holds the hashed email", async () => {
    existsResult = true;
    const res = await probe({ emailHash: HASH }, { "x-forwarded-for": "203.0.113.1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: true });
  });

  it("returns { exists: false } when no account matches", async () => {
    existsResult = false;
    const res = await probe({ emailHash: HASH }, { "x-forwarded-for": "203.0.113.2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false });
  });

  it("queries by the hash only, never a raw email, against the pgcrypto index expression", async () => {
    await probe({ emailHash: HASH }, { "x-forwarded-for": "203.0.113.3" });
    expect(internalQueryCalls).toHaveLength(1);
    const call = internalQueryCalls[0];
    expect(call.params).toEqual([HASH]);
    expect(call.sql).toContain("encode(digest(lower(email), 'sha256'), 'hex')");
  });

  it("rejects a non-hex / wrong-length emailHash with 422 before any DB work", async () => {
    for (const bad of ["not-a-hash", "A".repeat(64), "a".repeat(63), "a".repeat(65), HASH + "z"]) {
      const res = await probe({ emailHash: bad }, { "x-forwarded-for": "203.0.113.4" });
      expect(res.status).toBe(422);
    }
    expect(internalQueryCalls).toHaveLength(0);
  });

  it("rejects a missing body / raw email field with 422", async () => {
    const res = await probe({ email: "alice@corp.com" }, { "x-forwarded-for": "203.0.113.5" });
    expect(res.status).toBe(422);
    expect(internalQueryCalls).toHaveLength(0);
  });

  it("404s in non-managed auth mode (no Better Auth user table to probe)", async () => {
    authMode = "none";
    const res = await probe({ emailHash: HASH }, { "x-forwarded-for": "203.0.113.6" });
    expect(res.status).toBe(404);
    expect(internalQueryCalls).toHaveLength(0);
  });

  it("404s when there is no internal DB", async () => {
    internalDbAvailable = false;
    const res = await probe({ emailHash: HASH }, { "x-forwarded-for": "203.0.113.7" });
    expect(res.status).toBe(404);
    expect(internalQueryCalls).toHaveLength(0);
  });

  it("returns 500 (never a misleading exists:false) when the existence query throws", async () => {
    queryThrows = true;
    const res = await probe({ emailHash: HASH }, { "x-forwarded-for": "203.0.113.8" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.exists).toBeUndefined();
    expect(body.requestId).toBeDefined();
  });

  it("rate-limits a single IP after the per-IP ceiling and returns 429", async () => {
    const ip = "198.51.100.9";
    let sawLimit = false;
    // The ceiling is 60/min; the 61st request from one IP must 429.
    for (let i = 0; i < 65; i++) {
      const res = await probe({ emailHash: HASH }, { "x-forwarded-for": ip });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it("buckets rate limits per IP — a fresh IP is not throttled by another IP's burst", async () => {
    const noisy = "198.51.100.10";
    for (let i = 0; i < 65; i++) await probe({ emailHash: HASH }, { "x-forwarded-for": noisy });
    const res = await probe({ emailHash: HASH }, { "x-forwarded-for": "198.51.100.11" });
    expect(res.status).toBe(200);
  });
});

describe("GET /region-map", () => {
  beforeEach(() => {
    authMode = "managed";
  });

  it("returns configured:false in non-managed auth mode", async () => {
    authMode = "none";
    const res = await regionRouting.request("/region-map");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, defaultRegion: "none", regions: [] });
  });

  it("returns configured:false when residency is not available (no EE / self-hosted default)", async () => {
    const res = await regionRouting.request("/region-map");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; regions: unknown[] };
    expect(body.configured).toBe(false);
    expect(body.regions).toEqual([]);
  });
});
