/**
 * Tests for the per-OAuth-client rate limiter (#2071).
 *
 * Acceptance criteria:
 *   - One greedy OAuth client cannot starve siblings in the same workspace.
 *   - 429 path returns the structured AtlasMcpToolError envelope with
 *     `code: "rate_limited"`, integer `retry_after` seconds, and a hint.
 *   - Recovery after the sliding window expires.
 *   - Per-tool weighting: `executeSQL` (heavy) drains the bucket faster
 *     than `listEntities` (light).
 *   - Admin override per (orgId, clientId) is honored.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  checkClientRateLimit,
  setClientRateLimit,
  toolWeight,
  resolveRateLimitFor,
  DEFAULT_REQUESTS_PER_MINUTE,
  TOOL_WEIGHTS,
  WINDOW_MS,
  _resetClientRateLimitsForTests,
  _setClockForTests,
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
};

// ── Defaults ──────────────────────────────────────────────────────────

describe("default quota", () => {
  it("exposes 60 req/min as the documented default", () => {
    expect(DEFAULT_REQUESTS_PER_MINUTE).toBe(60);
  });

  it("exposes a 60 second window", () => {
    expect(WINDOW_MS).toBe(60_000);
  });
});

// ── Per-tool weights ──────────────────────────────────────────────────

describe("toolWeight", () => {
  it("treats executeSQL as heavy", () => {
    expect(toolWeight("executeSQL")).toBeGreaterThan(toolWeight("listEntities"));
  });

  it("treats explore as heavy", () => {
    expect(toolWeight("explore")).toBeGreaterThan(toolWeight("listEntities"));
  });

  it("falls back to weight=1 for unknown tools", () => {
    expect(toolWeight("totally_unknown_tool")).toBe(1);
  });

  it("exposes the weight table for the shipped tools", () => {
    expect(TOOL_WEIGHTS.executeSQL).toBeDefined();
    expect(TOOL_WEIGHTS.explore).toBeDefined();
    expect(TOOL_WEIGHTS.listEntities).toBeDefined();
    expect(TOOL_WEIGHTS.runMetric).toBeDefined();
  });
});

// ── Sliding window enforcement ────────────────────────────────────────

describe("checkClientRateLimit", () => {
  it("allows the first request", () => {
    const verdict = checkClientRateLimit(baseCtx);
    expect(verdict.allowed).toBe(true);
    expect(verdict.retryAfterSec).toBe(0);
    expect(verdict.limit).toBe(DEFAULT_REQUESTS_PER_MINUTE);
  });

  it("denies once the bucket is full", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 3 });
    // listEntities = weight 1 → 3 requests fit
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);

    const denied = checkClientRateLimit(baseCtx);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("emits an integer retry_after value (>=1, <=60) suitable for Retry-After", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    checkClientRateLimit(baseCtx);
    const denied = checkClientRateLimit(baseCtx);
    expect(denied.allowed).toBe(false);
    expect(Number.isInteger(denied.retryAfterSec)).toBe(true);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("recovers after the window slides past", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    _setClockForTests(1_000_000);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(false);

    // Advance past the window.
    _setClockForTests(1_000_000 + WINDOW_MS + 1);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
  });

  it("isolates buckets across distinct clients in the same workspace", () => {
    setClientRateLimit("org_a", "greedy_client", { requestsPerMinute: 2 });
    setClientRateLimit("org_a", "polite_client", { requestsPerMinute: 2 });

    const greedy = { ...baseCtx, clientId: "greedy_client" };
    const polite = { ...baseCtx, clientId: "polite_client" };

    expect(checkClientRateLimit(greedy).allowed).toBe(true);
    expect(checkClientRateLimit(greedy).allowed).toBe(true);
    expect(checkClientRateLimit(greedy).allowed).toBe(false);

    // Polite still has its full quota; greedy starving polite would be
    // the bug this whole feature exists to prevent.
    expect(checkClientRateLimit(polite).allowed).toBe(true);
    expect(checkClientRateLimit(polite).allowed).toBe(true);
    expect(checkClientRateLimit(polite).allowed).toBe(false);
  });

  it("isolates buckets across distinct workspaces sharing a clientId", () => {
    // Same registered client name in two workspaces (DCR-issued names
    // can be canonical: `claude-desktop`). Must not share a bucket.
    setClientRateLimit("org_a", "claude-desktop", { requestsPerMinute: 1 });
    setClientRateLimit("org_b", "claude-desktop", { requestsPerMinute: 1 });

    const fromA = { ...baseCtx, orgId: "org_a", clientId: "claude-desktop" };
    const fromB = { ...baseCtx, orgId: "org_b", clientId: "claude-desktop" };

    expect(checkClientRateLimit(fromA).allowed).toBe(true);
    expect(checkClientRateLimit(fromA).allowed).toBe(false);
    expect(checkClientRateLimit(fromB).allowed).toBe(true);
  });

  it("weights heavy tools so executeSQL drains the bucket faster", () => {
    // Set a budget that admits one heavy call but blocks the next.
    setClientRateLimit("org_a", "client_x", {
      requestsPerMinute: TOOL_WEIGHTS.executeSQL,
    });
    const heavy = { ...baseCtx, toolName: "executeSQL" };
    expect(checkClientRateLimit(heavy).allowed).toBe(true);
    // Second heavy call would exceed the budget.
    const second = checkClientRateLimit(heavy);
    expect(second.allowed).toBe(false);
  });

  it("admits many light calls under the same budget", () => {
    setClientRateLimit("org_a", "client_x", {
      requestsPerMinute: TOOL_WEIGHTS.executeSQL,
    });
    // Light calls (weight=1) — should fit equal to the budget.
    const light = { ...baseCtx, toolName: "listEntities" };
    for (let i = 0; i < TOOL_WEIGHTS.executeSQL; i++) {
      expect(checkClientRateLimit(light).allowed).toBe(true);
    }
    expect(checkClientRateLimit(light).allowed).toBe(false);
  });

  it("clamps retryAfterSec to 60 when a single weight exceeds the limit", () => {
    // weight 5 > limit 1 — there is no "oldest entry" yet, the fallback
    // path computes recovery as `now + WINDOW_MS - now` clamped to 60s.
    // A regression that returned `retry_after: 0` would tell the agent
    // to retry immediately and never recover.
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    const heavy = { ...baseCtx, toolName: "executeSQL" };
    const denied = checkClientRateLimit(heavy);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(60);
  });

  it("denied requests do not extend the recovery window", () => {
    // Behavioral contract from `checkClientRateLimit`'s docstring: a
    // denial must NOT push the recovery time forward. Without this,
    // a polling client that retries every second would never recover.
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    _setClockForTests(1_000_000);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    for (let i = 1; i <= 5; i++) {
      _setClockForTests(1_000_000 + i * 100);
      expect(checkClientRateLimit(baseCtx).allowed).toBe(false);
    }
    // Window slides past the original ALLOWED entry (1_000_000), not
    // any of the later denials.
    _setClockForTests(1_000_000 + WINDOW_MS + 1);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
  });

  it("sums weights correctly across mixed-tool traffic", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 10 });
    // 5 × listEntities (weight 1 each) + 1 × executeSQL (weight 5) = 10
    for (let i = 0; i < 5; i++) {
      expect(
        checkClientRateLimit({ ...baseCtx, toolName: "listEntities" }).allowed,
      ).toBe(true);
    }
    expect(
      checkClientRateLimit({ ...baseCtx, toolName: "executeSQL" }).allowed,
    ).toBe(true);
    // Bucket exhausted — even a light call denied.
    expect(
      checkClientRateLimit({ ...baseCtx, toolName: "listEntities" }).allowed,
    ).toBe(false);
  });
});

// ── Admin override ────────────────────────────────────────────────────

describe("resolveRateLimitFor", () => {
  it("returns the default when no override is set", async () => {
    const rpm = await resolveRateLimitFor("org_a", "client_x", async () => null);
    expect(rpm).toBe(DEFAULT_REQUESTS_PER_MINUTE);
  });

  it("returns the override and caches it", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return 120;
    };
    const first = await resolveRateLimitFor("org_a", "client_x", loader);
    expect(first).toBe(120);
    const second = await resolveRateLimitFor("org_a", "client_x", loader);
    expect(second).toBe(120);
    expect(calls).toBe(1);
  });

  it("propagates an explicit override even after a cached default", async () => {
    // First resolve sets the default in cache.
    await resolveRateLimitFor("org_a", "client_x", async () => null);
    // Then admin updates the limit directly via setClientRateLimit (the
    // PATCH route's responsibility) — subsequent checks must see it.
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 10 });
    // Drain
    for (let i = 0; i < 10; i++) {
      expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    }
    expect(checkClientRateLimit(baseCtx).allowed).toBe(false);
  });

  it("invalidating the cache forces the next resolve to re-load from DB", async () => {
    // Production flow that this case pins:
    //   1. Limiter caches DB-loaded override (e.g. 120).
    //   2. Admin PATCH clears the override row in DB.
    //   3. Admin PATCH calls setClientRateLimit(orgId, clientId, null).
    //   4. Next dispatch's resolveRateLimitFor must hit the loader
    //      again and observe the new (null) DB state, falling through
    //      to DEFAULT_REQUESTS_PER_MINUTE.
    // A regression that drops step 3 (or makes setClientRateLimit's
    // null branch a no-op) would silently keep the stale 120 value
    // until process restart — exactly the failure mode the cache
    // invalidation exists to prevent.
    let dbValue: number | null = 120;
    const loader = async () => dbValue;

    const first = await resolveRateLimitFor("org_a", "client_x", loader);
    expect(first).toBe(120);

    // Admin clears the override.
    dbValue = null;
    setClientRateLimit("org_a", "client_x", null);

    const reloaded = await resolveRateLimitFor("org_a", "client_x", loader);
    expect(reloaded).toBe(DEFAULT_REQUESTS_PER_MINUTE);

    // Subsequent dispatches are sized against the default, not the stale 120.
    const light = { ...baseCtx, toolName: "listEntities" };
    for (let i = 0; i < DEFAULT_REQUESTS_PER_MINUTE; i++) {
      expect(checkClientRateLimit(light).allowed).toBe(true);
    }
    expect(checkClientRateLimit(light).allowed).toBe(false);
  });
});
