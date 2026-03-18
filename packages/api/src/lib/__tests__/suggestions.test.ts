/**
 * Unit tests for suggestions.ts — query suggestion analysis engine.
 *
 * scoreSuggestion is a pure function — tested directly without mocks.
 * _groupAuditRows is tested with real SQL strings that go through
 * normalizeSQL/fingerprintSQL (no mocks needed for pure functions).
 */
import { describe, test, expect } from "bun:test";
import { scoreSuggestion } from "@atlas/api/lib/learn/suggestions";

describe("scoreSuggestion", () => {
  test("high frequency + recent scores higher than low frequency + old", () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentHighFreq = scoreSuggestion(10, now);
    const oldLowFreq = scoreSuggestion(2, thirtyDaysAgo);
    expect(recentHighFreq).toBeGreaterThan(oldLowFreq);
  });

  test("same frequency, more recent scores higher", () => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(scoreSuggestion(5, now)).toBeGreaterThan(scoreSuggestion(5, weekAgo));
  });

  test("30-day half-life: score halves after 30 days", () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recent = scoreSuggestion(10, now);
    const old = scoreSuggestion(10, thirtyDaysAgo);
    expect(recent).toBeCloseTo(10, 0);
    expect(old).toBeCloseTo(5, 0);
  });
});

import { _groupAuditRows } from "@atlas/api/lib/learn/suggestions";

describe("_groupAuditRows", () => {
  test("groups duplicate queries by fingerprint", () => {
    const rows = [
      { sql: "SELECT id, name FROM users WHERE age > 25", tables_accessed: '["users"]', timestamp: "2026-03-18T10:00:00Z" },
      { sql: "SELECT id, name FROM users WHERE age > 30", tables_accessed: '["users"]', timestamp: "2026-03-18T11:00:00Z" },
      { sql: "SELECT * FROM orders WHERE total > 100", tables_accessed: '["orders"]', timestamp: "2026-03-18T09:00:00Z" },
    ];
    const groups = _groupAuditRows(rows);
    expect(groups.size).toBe(2);
  });

  test("tracks max timestamp per group", () => {
    const rows = [
      { sql: "SELECT id FROM users WHERE age > 25", tables_accessed: '["users"]', timestamp: "2026-03-10T10:00:00Z" },
      { sql: "SELECT id FROM users WHERE age > 30", tables_accessed: '["users"]', timestamp: "2026-03-18T11:00:00Z" },
    ];
    const groups = _groupAuditRows(rows);
    for (const group of groups.values()) {
      expect(new Date(group.lastSeen).getTime()).toBe(new Date("2026-03-18T11:00:00Z").getTime());
    }
  });
});
