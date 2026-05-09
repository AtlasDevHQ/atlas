/**
 * Side-effect-free read of per-OAuth-client bucket state (#2216).
 *
 * Exercised by `/api/v1/me/mcp-usage` and any other surface that wants
 * to surface "this agent has used N/M weighted requests this minute"
 * before the bucket trips a 429. The contract pinned here:
 *
 *   - The peek does NOT mutate the bucket (no entry filtered/dropped)
 *     and does NOT touch the LRU recency on the limits cache (so a
 *     polling Settings page can't artificially keep stale clients
 *     warm in the cache).
 *   - The reported weighted sum is in-window-only (entries whose ts
 *     fell out of the sliding window are excluded from the result).
 *   - `resetAt` is the moment the oldest in-window entry rolls past
 *     the window — the UI uses this to show "resets in N seconds".
 *     With no entries, `resetAt === now`.
 *   - `ceiling` mirrors the limit `checkClientRateLimit` would use:
 *     a cached override if present, otherwise the static default. No
 *     DB roundtrip; the route layer is responsible for warming the
 *     cache via `resolveRateLimitFor` if it wants the override surfaced.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  checkClientRateLimit,
  setClientRateLimit,
  getClientUsage,
  DEFAULT_REQUESTS_PER_MINUTE,
  WINDOW_MS,
  TOOL_WEIGHTS,
  _resetClientRateLimitsForTests,
  _setClockForTests,
  _hasCachedLimitForTests,
  _getRateLimitMapSizesForTests,
} from "../oauth-client";

afterEach(() => {
  _resetClientRateLimitsForTests();
  _setClockForTests(null);
});

const baseCtx = {
  orgId: "org_a",
  userId: "user_1",
  clientId: "client_x",
  toolName: "listEntities",
} as const;

describe("getClientUsage — empty bucket", () => {
  it("reports zero usage and the default ceiling for an unseen client", () => {
    _setClockForTests(1_000_000);
    const view = getClientUsage("org_a", "client_x");
    expect(view.currentMinuteWeightedRequests).toBe(0);
    expect(view.ceiling).toBe(DEFAULT_REQUESTS_PER_MINUTE);
    // No entries → resetAt is "now" so the UI shows "available now".
    expect(view.resetAt).toBe(1_000_000);
  });

  it("reports the cached override when one is set, even before any traffic", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 120 });
    const view = getClientUsage("org_a", "client_x");
    expect(view.ceiling).toBe(120);
    expect(view.currentMinuteWeightedRequests).toBe(0);
  });
});

describe("getClientUsage — in-window weights", () => {
  it("returns the weighted sum after a few admitted dispatches", () => {
    _setClockForTests(2_000_000);
    // 2 × executeSQL (5 each) + 3 × listEntities (1 each) = 13 weighted.
    for (let i = 0; i < 2; i++) {
      checkClientRateLimit({ ...baseCtx, toolName: "executeSQL" });
    }
    for (let i = 0; i < 3; i++) {
      checkClientRateLimit({ ...baseCtx, toolName: "listEntities" });
    }
    const view = getClientUsage("org_a", "client_x");
    expect(view.currentMinuteWeightedRequests).toBe(2 * TOOL_WEIGHTS.executeSQL + 3);
  });

  it("resetAt aligns with the oldest in-window entry rolling past WINDOW_MS", () => {
    _setClockForTests(3_000_000);
    checkClientRateLimit(baseCtx); // first entry at ts = 3_000_000

    // Walk forward; resetAt anchored on the oldest entry.
    _setClockForTests(3_000_000 + 5_000);
    checkClientRateLimit(baseCtx); // ts = 3_005_000

    const view = getClientUsage("org_a", "client_x");
    expect(view.resetAt).toBe(3_000_000 + WINDOW_MS);
  });
});

describe("getClientUsage — sliding window decay", () => {
  it("drops entries whose ts fell out of the window from the reported sum", () => {
    _setClockForTests(4_000_000);
    checkClientRateLimit(baseCtx); // ts = 4_000_000, weight 1

    _setClockForTests(4_000_000 + WINDOW_MS / 2);
    checkClientRateLimit(baseCtx); // ts = 4_030_000, weight 1

    // Now slide past the first entry's window: only the second remains.
    _setClockForTests(4_000_000 + WINDOW_MS + 1);
    const view = getClientUsage("org_a", "client_x");
    expect(view.currentMinuteWeightedRequests).toBe(1);
  });

  it("returns zero usage once every entry is out of window", () => {
    _setClockForTests(5_000_000);
    checkClientRateLimit(baseCtx);

    _setClockForTests(5_000_000 + WINDOW_MS + 1);
    const view = getClientUsage("org_a", "client_x");
    expect(view.currentMinuteWeightedRequests).toBe(0);
    // resetAt collapses to "now" once the bucket is effectively empty.
    expect(view.resetAt).toBe(5_000_000 + WINDOW_MS + 1);
  });
});

describe("getClientUsage — read is side-effect-free", () => {
  it("does not mutate the bucket map for an unseen client", () => {
    expect(_getRateLimitMapSizesForTests().buckets).toBe(0);
    getClientUsage("org_a", "client_x");
    expect(_getRateLimitMapSizesForTests().buckets).toBe(0);
  });

  it("does not promote a cached override's LRU position", () => {
    // Pin the cap small via env so we can prove eviction order.
    process.env.ATLAS_MCP_RATE_LIMIT_MAX_KEYS = "100";
    try {
      for (let i = 0; i < 100; i++) {
        setClientRateLimit("org_x", `client_${i}`, { requestsPerMinute: 60 });
      }
      // Peek client_0 — under a *promoting* read this would survive the
      // next eviction. Under a non-promoting read it must be evicted.
      const view = getClientUsage("org_x", "client_0");
      expect(view.ceiling).toBe(60);

      setClientRateLimit("org_x", "client_overflow", { requestsPerMinute: 60 });

      // client_0 was the LRU before the peek; it must still be the LRU.
      // A regression that promoted on read would keep client_0 cached
      // and evict client_1 instead.
      expect(_hasCachedLimitForTests("org_x", "client_0")).toBe(false);
      expect(_hasCachedLimitForTests("org_x", "client_1")).toBe(true);
    } finally {
      delete process.env.ATLAS_MCP_RATE_LIMIT_MAX_KEYS;
    }
  });

  it("does not insert a phantom buckets entry when peeking a client that has none", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 60 });
    expect(_getRateLimitMapSizesForTests().buckets).toBe(0);
    getClientUsage("org_a", "client_x");
    // Peek must not seed an empty array into `buckets` — that would
    // defeat the bucket map's natural self-cleaning property.
    expect(_getRateLimitMapSizesForTests().buckets).toBe(0);
  });
});

describe("getClientUsage — bucket and limit isolation", () => {
  it("isolates by (orgId, clientId) like the check path", () => {
    _setClockForTests(6_000_000);
    checkClientRateLimit({ ...baseCtx, orgId: "org_a", clientId: "claude-desktop" });
    checkClientRateLimit({ ...baseCtx, orgId: "org_a", clientId: "claude-desktop" });

    const same = getClientUsage("org_a", "claude-desktop");
    expect(same.currentMinuteWeightedRequests).toBe(2);

    const otherOrg = getClientUsage("org_b", "claude-desktop");
    expect(otherOrg.currentMinuteWeightedRequests).toBe(0);

    const otherClient = getClientUsage("org_a", "cursor");
    expect(otherClient.currentMinuteWeightedRequests).toBe(0);
  });
});
