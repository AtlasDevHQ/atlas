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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  _getRateLimitMapSizesForTests,
  _hasCachedLimitForTests,
} from "../oauth-client";

afterEach(() => {
  _resetClientRateLimitsForTests();
  _setClockForTests(null);
  delete process.env.ATLAS_MCP_RATE_LIMIT_MAX_KEYS;
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
    expect(verdict.limit).toBe(DEFAULT_REQUESTS_PER_MINUTE);
  });

  it("the discriminated union narrows retryAfterSec onto the denied branch only", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    const allowed = checkClientRateLimit(baseCtx);
    // The allowed branch must NOT carry retryAfterSec — its presence in
    // the legacy flat shape with value 0 was the original ambiguity that
    // motivated the union refactor. A regression that
    // re-introduces the field on the allowed branch would let callers
    // treat `verdict.retryAfterSec === 0` as a sentinel again.
    expect(allowed.allowed).toBe(true);
    expect("retryAfterSec" in allowed).toBe(false);

    if (allowed.allowed) {
      // Compile-time check: accessing `retryAfterSec` on the narrowed
      // `allowed: true` branch must be a TS error. `@ts-expect-error`
      // forces the build to fail if a future refactor widens the type
      // — which is the correctness contract the runtime check above
      // can only approximate.
      // @ts-expect-error retryAfterSec must not exist on the allowed branch
      void allowed.retryAfterSec;
    }

    const denied = checkClientRateLimit(baseCtx);
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("type-narrow checkpoint");
    expect(typeof denied.retryAfterSec).toBe("number");
  });

  it("denies once the bucket is full", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 3 });
    // listEntities = weight 1 → 3 requests fit
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);

    const denied = checkClientRateLimit(baseCtx);
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("expected denied verdict");
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("emits an integer retry_after value (>=1, <=60) suitable for Retry-After", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    checkClientRateLimit(baseCtx);
    const denied = checkClientRateLimit(baseCtx);
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("expected denied verdict");
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
    if (denied.allowed) throw new Error("expected denied verdict");
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

// ── Map-level eviction ────────────────────────────────────────────────

describe("eviction — buckets self-clean", () => {
  it("drops the bucket key once all in-window entries expire", () => {
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    _setClockForTests(1_000_000);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    expect(_getRateLimitMapSizesForTests().buckets).toBe(1);

    // Slide past the window — the next read filters every entry out.
    _setClockForTests(1_000_000 + WINDOW_MS + 1);
    expect(checkClientRateLimit(baseCtx).allowed).toBe(true);
    // The bucket has one fresh entry now (the request we just admitted).
    expect(_getRateLimitMapSizesForTests().buckets).toBe(1);
  });

  it("drops the bucket key on a single-weight-exceeds-limit denial of a fresh client", () => {
    // weight=5 (executeSQL) against limit=1 — we never push, and there
    // were no prior entries, so the key should not stick around in the
    // map. A regression that always re-set an empty array would leak a
    // bucket entry per fresh hostile client.
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    _resetClientRateLimitsForTests();
    setClientRateLimit("org_a", "client_x", { requestsPerMinute: 1 });
    expect(_getRateLimitMapSizesForTests().buckets).toBe(0);
    const denied = checkClientRateLimit({ ...baseCtx, toolName: "executeSQL" });
    expect(denied.allowed).toBe(false);
    expect(_getRateLimitMapSizesForTests().buckets).toBe(0);
  });
});

describe("eviction — limits LRU bound", () => {
  it("evicts the least-recently-used cached override when the cap is exceeded", async () => {
    process.env.ATLAS_MCP_RATE_LIMIT_MAX_KEYS = "100"; // clamped floor
    // Force a small effective bound by using setClientRateLimit, which
    // honors the cap on insert.
    for (let i = 0; i < 100; i++) {
      setClientRateLimit("org_x", `client_${i}`, { requestsPerMinute: 60 });
    }
    expect(_getRateLimitMapSizesForTests().limits).toBe(100);
    // Adding one more triggers eviction of the first (LRU).
    setClientRateLimit("org_x", "client_overflow", { requestsPerMinute: 60 });
    expect(_getRateLimitMapSizesForTests().limits).toBe(100);
    expect(_hasCachedLimitForTests("org_x", "client_0")).toBe(false);
    expect(_hasCachedLimitForTests("org_x", "client_overflow")).toBe(true);
  });

  it("read activity refreshes LRU position so an active client survives newer churn", async () => {
    process.env.ATLAS_MCP_RATE_LIMIT_MAX_KEYS = "100";
    for (let i = 0; i < 100; i++) {
      setClientRateLimit("org_x", `client_${i}`, { requestsPerMinute: 60 });
    }
    // Touch BOTH ends of the LRU queue — a regression that lookup-only
    // reads (without re-insert) would keep client_0 as the LRU and the
    // assertion below would still pass for client_50. Touching both
    // means the recency refresh has to actually move two entries to the
    // most-recent end for the test to remain green.
    for (const id of ["client_0", "client_50"]) {
      checkClientRateLimit({
        orgId: "org_x",
        clientId: id,
        userId: "user_1",
        toolName: "listEntities",
      });
    }
    // Two new inserts evict the two LRU entries — which now should be
    // client_1 and client_2 (not client_0 / client_50, which we just
    // promoted).
    setClientRateLimit("org_x", "client_overflow_a", { requestsPerMinute: 60 });
    setClientRateLimit("org_x", "client_overflow_b", { requestsPerMinute: 60 });
    expect(_hasCachedLimitForTests("org_x", "client_0")).toBe(true);
    expect(_hasCachedLimitForTests("org_x", "client_50")).toBe(true);
    expect(_hasCachedLimitForTests("org_x", "client_1")).toBe(false);
    expect(_hasCachedLimitForTests("org_x", "client_2")).toBe(false);
  });

  it("clamps a sub-100 ATLAS_MCP_RATE_LIMIT_MAX_KEYS to a 100 floor", () => {
    process.env.ATLAS_MCP_RATE_LIMIT_MAX_KEYS = "5"; // typo; clamped to 100
    for (let i = 0; i < 100; i++) {
      setClientRateLimit("org_x", `client_${i}`, { requestsPerMinute: 60 });
    }
    // Below the floor we'd see a map size of 5; with the floor we see 100.
    expect(_getRateLimitMapSizesForTests().limits).toBe(100);
  });

  it("ignores a malformed ATLAS_MCP_RATE_LIMIT_MAX_KEYS and falls back to the default", () => {
    process.env.ATLAS_MCP_RATE_LIMIT_MAX_KEYS = "not-a-number";
    // Just verify a basic insert works — exercising the full default
    // (10_000) would burn time without buying coverage. The contract is
    // that the cache stays usable.
    setClientRateLimit("org_x", "client_0", { requestsPerMinute: 60 });
    expect(_getRateLimitMapSizesForTests().limits).toBe(1);
  });

  it("resolveRateLimitFor caches into the LRU and respects the bound", async () => {
    process.env.ATLAS_MCP_RATE_LIMIT_MAX_KEYS = "100";
    const loader = async () => 90;
    for (let i = 0; i < 105; i++) {
      await resolveRateLimitFor("org_x", `client_${i}`, loader);
    }
    expect(_getRateLimitMapSizesForTests().limits).toBe(100);
    // The 5 oldest must have been evicted.
    expect(_hasCachedLimitForTests("org_x", "client_0")).toBe(false);
    expect(_hasCachedLimitForTests("org_x", "client_4")).toBe(false);
    expect(_hasCachedLimitForTests("org_x", "client_5")).toBe(true);
    expect(_hasCachedLimitForTests("org_x", "client_104")).toBe(true);
  });
});

// ── Docs table lockstep ──────────────────────────────────────────────

describe("TOOL_WEIGHTS docs sync", () => {
  it("apps/docs/content/docs/guides/mcp.mdx weights table matches TOOL_WEIGHTS exactly", () => {
    // The hosted-MCP guide hardcodes a parallel table to keep operator
    // copy readable. This test pins the lockstep so a single-side edit
    // (rename a tool, change a weight, add a tool) trips CI before the
    // docs and the runtime drift. A regression where the docs say
    // `executeSQL: 3` while the limiter charges 5 would mislead every
    // operator setting a quota off the docs.
    const docsPath = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "apps",
      "docs",
      "content",
      "docs",
      "guides",
      "mcp.mdx",
    );
    const mdx = readFileSync(docsPath, "utf-8");
    const docsWeights = parseToolWeightsTable(mdx);

    // Both directions: every tool in the source constant appears in the
    // docs at the documented weight, and every tool the docs claims is
    // actually in the source constant. Ordering is irrelevant — the
    // tables are unordered key/value sets.
    for (const [tool, weight] of Object.entries(TOOL_WEIGHTS)) {
      expect(docsWeights.get(tool)).toBe(weight);
    }
    for (const [tool, weight] of docsWeights) {
      expect((TOOL_WEIGHTS as Record<string, number>)[tool]).toBe(weight);
    }
  });
});

/**
 * Parse the "Per-tool weights" table out of the hosted-MCP guide. The
 * markdown shape is:
 *
 *     #### Per-tool weights
 *     ...
 *     | Tool                                  | Weight |
 *     | ------------------------------------- | ------ |
 *     | `executeSQL`, `explore`               | 5      |
 *     | `runMetric`                           | 3      |
 *     | `listEntities`, `describeEntity`, ... | 1      |
 *
 * Each row may list multiple comma-separated tools sharing a weight.
 * Tools are wrapped in backticks; the parser strips them. Returns a
 * map for direction-agnostic comparison.
 *
 * The parser anchors on the `#### Per-tool weights` heading rather than
 * the first `| Tool` it finds — anchoring on the table header alone
 * would silently bind to an unrelated table (e.g. an "OAuth Client
 * Tool Permissions" table) if one is added earlier in the guide. The
 * cell-count check throws on shape drift (e.g. a future doc edit
 * adding a "Notes" column) instead of silently skipping rows, which
 * would yield a misleading mismatch error far from the real cause.
 */
function parseToolWeightsTable(mdx: string): Map<string, number> {
  const SECTION_HEADING = "#### Per-tool weights";
  const sectionIdx = mdx.indexOf(SECTION_HEADING);
  if (sectionIdx < 0) {
    throw new Error(
      `weights table section not found in mcp.mdx — expected "${SECTION_HEADING}" anchor`,
    );
  }
  const fromSection = mdx.slice(sectionIdx);
  const headerIdx = fromSection.indexOf("| Tool");
  if (headerIdx < 0) {
    throw new Error(
      `weights table not found after "${SECTION_HEADING}" — did the heading move?`,
    );
  }
  // Skip the header row and the separator row (`| --- | --- |`).
  const fromHeader = fromSection.slice(headerIdx);
  const lines = fromHeader.split("\n");
  const out = new Map<string, number>();
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length !== 2) {
      throw new Error(
        `weights table shape drifted at line "${line}" — expected exactly 2 cells (Tool, Weight), got ${cells.length}. Refresh the parser if a column was added.`,
      );
    }
    const [toolsCell, weightCell] = cells;
    const weight = Number.parseInt(weightCell, 10);
    if (!Number.isFinite(weight)) {
      throw new Error(
        `weights table contains non-numeric weight "${weightCell}" at line "${line}"`,
      );
    }
    for (const raw of toolsCell.split(",")) {
      const tool = raw.trim().replace(/^`|`$/g, "");
      if (tool.length > 0) out.set(tool, weight);
    }
  }
  return out;
}
