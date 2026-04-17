/**
 * Tests for `generateSuggestions` — asserts that the autoApprove option
 * threads through to `upsertSuggestion`. Covers #1482: atlas learn lands
 * rows in the pending moderation queue by default; `--auto-approve`
 * bypasses the queue with explicit operator intent.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

const upsertCalls: Array<{ autoApprove: boolean | undefined; patternSql: string }> = [];
let upsertReturnValue: "created" | "updated" | "skipped" = "created";

// Mock the DB module so we can assert the upsert inputs directly.
// Partial mocks of module exports are forbidden (per CLAUDE.md), so we
// mirror every export the generator imports.
mock.module("@atlas/api/lib/db/internal", () => ({
  getAuditLogQueries: async () => [
    {
      sql: "SELECT status, COUNT(*) FROM orders GROUP BY status",
      tables_accessed: JSON.stringify(["orders"]),
      timestamp: "2026-04-10T00:00:00Z",
    },
    {
      sql: "SELECT status, COUNT(*) FROM orders GROUP BY status",
      tables_accessed: JSON.stringify(["orders"]),
      timestamp: "2026-04-10T01:00:00Z",
    },
  ],
  upsertSuggestion: async (input: { autoApprove?: boolean; patternSql: string }) => {
    upsertCalls.push({ autoApprove: input.autoApprove, patternSql: input.patternSql });
    return upsertReturnValue;
  },
}));

mock.module("@atlas/api/lib/learn/pattern-analyzer", () => ({
  normalizeSQL: (sql: string) => sql.trim(),
  fingerprintSQL: (sql: string) => `fp:${sql.length}`,
  extractPatternInfo: () => ({ primaryTable: "orders", tables: ["orders"], description: "Count orders by status" }),
  // Return null so the YAML-pattern filter is skipped in tests (matches SaaS mode).
  getYamlPatterns: () => {
    throw new Error("yaml unavailable in test");
  },
}));

// Import AFTER mocks are installed.
const { generateSuggestions } = await import("../suggestions");

beforeEach(() => {
  upsertCalls.length = 0;
  upsertReturnValue = "created";
});

afterEach(() => {
  upsertCalls.length = 0;
  upsertReturnValue = "created";
});

describe("generateSuggestions — autoApprove propagation", () => {
  it("defaults to autoApprove=false (pending/draft queue)", async () => {
    const result = await generateSuggestions(null);
    expect(result.created).toBeGreaterThan(0);
    expect(upsertCalls.length).toBeGreaterThan(0);
    for (const call of upsertCalls) {
      expect(call.autoApprove).toBe(false);
    }
  });

  it("forwards autoApprove=true when passed explicitly", async () => {
    const result = await generateSuggestions(null, { autoApprove: true });
    expect(result.created).toBeGreaterThan(0);
    expect(upsertCalls.length).toBeGreaterThan(0);
    for (const call of upsertCalls) {
      expect(call.autoApprove).toBe(true);
    }
  });

  it("coerces an undefined autoApprove option to false", async () => {
    await generateSuggestions(null, {});
    for (const call of upsertCalls) {
      expect(call.autoApprove).toBe(false);
    }
  });
});

describe("generateSuggestions — skipped counter", () => {
  it("counts skipped upserts in the result so the CLI can surface swallowed DB errors", async () => {
    // upsertSuggestion catches DB errors and returns "skipped" — without
    // counting those, an --auto-approve run could silently fail to
    // publish while the CLI prints a happy success message.
    upsertReturnValue = "skipped";
    const result = await generateSuggestions(null, { autoApprove: true });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.skipped).toBe(upsertCalls.length);
  });

  it("returns skipped=0 when all upserts succeed", async () => {
    const result = await generateSuggestions(null);
    expect(result.skipped).toBe(0);
  });
});
