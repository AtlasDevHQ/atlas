/**
 * Tests for the profiling failure threshold logic.
 *
 * Verifies that checkFailureThreshold correctly determines when to abort
 * based on the ratio of failed tables, and respects the --force override.
 */
import { describe, it, expect } from "bun:test";
import type { TableProfile, ProfilingResult } from "../atlas";
import { checkFailureThreshold, logProfilingErrors } from "../atlas";

function makeResult(successCount: number, errorCount: number): ProfilingResult {
  const profiles: TableProfile[] = Array.from({ length: successCount }, (_, i) => ({
    table_name: `table_${i}`,
    object_type: "table" as const,
    row_count: 100,
    columns: [],
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
  }));
  const errors = Array.from({ length: errorCount }, (_, i) => ({
    table: `failed_table_${i}`,
    error: `permission denied for table failed_table_${i}`,
  }));
  return { profiles, errors };
}

describe("checkFailureThreshold", () => {
  it("returns shouldAbort=false when there are no errors", () => {
    const result = makeResult(10, 0);
    const { shouldAbort, failureRate } = checkFailureThreshold(result, false);
    expect(shouldAbort).toBe(false);
    expect(failureRate).toBe(0);
  });

  it("returns shouldAbort=false when failure rate is below 20%", () => {
    // 1/10 = 10%
    const result = makeResult(9, 1);
    const { shouldAbort, failureRate } = checkFailureThreshold(result, false);
    expect(shouldAbort).toBe(false);
    expect(failureRate).toBeCloseTo(0.1);
  });

  it("returns shouldAbort=false when failure rate is exactly 20%", () => {
    // 2/10 = 20% — threshold is strictly >20%, so this should not abort
    const result = makeResult(8, 2);
    const { shouldAbort, failureRate } = checkFailureThreshold(result, false);
    expect(shouldAbort).toBe(false);
    expect(failureRate).toBeCloseTo(0.2);
  });

  it("returns shouldAbort=true when failure rate exceeds 20%", () => {
    // 3/10 = 30%
    const result = makeResult(7, 3);
    const { shouldAbort, failureRate } = checkFailureThreshold(result, false);
    expect(shouldAbort).toBe(true);
    expect(failureRate).toBeCloseTo(0.3);
  });

  it("returns shouldAbort=true when all tables fail (0 profiles)", () => {
    // 5/5 = 100% — note: in practice, the "profiles.length === 0" check
    // fires before this, but the threshold logic should still be correct
    const result = makeResult(0, 5);
    const { shouldAbort, failureRate } = checkFailureThreshold(result, false);
    expect(shouldAbort).toBe(true);
    expect(failureRate).toBe(1);
  });

  it("returns shouldAbort=false when --force is set, even above threshold", () => {
    // 8/10 = 80% but force=true
    const result = makeResult(2, 8);
    const { shouldAbort, failureRate } = checkFailureThreshold(result, true);
    expect(shouldAbort).toBe(false);
    expect(failureRate).toBeCloseTo(0.8);
  });

  it("returns shouldAbort=false when --force is set with 100% failure", () => {
    const result = makeResult(0, 10);
    const { shouldAbort } = checkFailureThreshold(result, true);
    expect(shouldAbort).toBe(false);
  });

  it("handles single table success", () => {
    const result = makeResult(1, 0);
    const { shouldAbort, failureRate } = checkFailureThreshold(result, false);
    expect(shouldAbort).toBe(false);
    expect(failureRate).toBe(0);
  });

  it("handles single table failure", () => {
    // 1/1 = 100%
    const result = makeResult(0, 1);
    const { shouldAbort } = checkFailureThreshold(result, false);
    expect(shouldAbort).toBe(true);
  });

  it("boundary: 21% failure rate triggers abort", () => {
    // ~21.4% = 3/14
    const result = makeResult(11, 3);
    const { shouldAbort, failureRate } = checkFailureThreshold(result, false);
    expect(shouldAbort).toBe(true);
    expect(failureRate).toBeGreaterThan(0.2);
  });
});

describe("logProfilingErrors", () => {
  it("caps preview at 5 errors", () => {
    const errors = Array.from({ length: 8 }, (_, i) => ({
      table: `t${i}`,
      error: `err${i}`,
    }));
    // Should not throw — just verifying it handles overflow
    const origWarn = console.warn;
    const logged: string[] = [];
    console.warn = (msg: string) => logged.push(msg);
    try {
      logProfilingErrors(errors, 20);
      // Should log header + 5 previews + overflow line = 7 calls
      expect(logged.length).toBe(7);
      expect(logged[0]).toContain("8/20");
      expect(logged[0]).toContain("40%");
      expect(logged[6]).toContain("... and 3 more");
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not show overflow for <= 5 errors", () => {
    const errors = Array.from({ length: 3 }, (_, i) => ({
      table: `t${i}`,
      error: `err${i}`,
    }));
    const origWarn = console.warn;
    const logged: string[] = [];
    console.warn = (msg: string) => logged.push(msg);
    try {
      logProfilingErrors(errors, 10);
      // header + 3 previews = 4 calls, no overflow
      expect(logged.length).toBe(4);
      expect(logged[0]).toContain("3/10");
      expect(logged[0]).toContain("30%");
    } finally {
      console.warn = origWarn;
    }
  });
});
