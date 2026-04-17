/**
 * Tests for `generateSuggestions` — asserts that the autoApprove option
 * threads through to `upsertSuggestion`. Covers #1482: atlas learn lands
 * rows in the pending moderation queue by default; `--auto-approve`
 * bypasses the queue with explicit operator intent.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

const upsertCalls: Array<{ autoApprove: boolean | undefined; patternSql: string }> = [];

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
    return "created" as const;
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
});

afterEach(() => {
  upsertCalls.length = 0;
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
