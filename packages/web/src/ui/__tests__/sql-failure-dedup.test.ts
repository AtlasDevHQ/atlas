import { describe, expect, test } from "bun:test";
import { computeSqlFailureDedup } from "../lib/sql-failure-dedup";

function executeSqlPart(sql: string, output: { success: boolean; error?: unknown }) {
  return {
    type: "tool-executeSQL" as const,
    toolCallId: `${sql}-${JSON.stringify(output)}`,
    state: "output-available" as const,
    input: { sql },
    output,
  };
}

function explorePart(command: string) {
  return {
    type: "tool-explore" as const,
    toolCallId: command,
    state: "output-available" as const,
    input: { command },
    output: "ok",
  };
}

function textPart(text: string) {
  return { type: "text" as const, text };
}

describe("computeSqlFailureDedup", () => {
  test("empty input returns empty maps", () => {
    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(undefined);
    expect(failureRuns.size).toBe(0);
    expect(skipFailureIndex.size).toBe(0);
  });

  test("a single failure does not enter failureRuns or skipFailureIndex", () => {
    const parts = [executeSqlPart("SELECT 1", { success: false, error: "bad" })];
    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(parts);
    expect(failureRuns.size).toBe(0);
    expect(skipFailureIndex.size).toBe(0);
  });

  test("two identical consecutive failures: first index gets count=2, second is skipped", () => {
    const fail = { success: false, error: "table missing" };
    const parts = [executeSqlPart("SELECT * FROM x", fail), executeSqlPart("SELECT * FROM x", fail)];
    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(parts);
    expect(failureRuns.get(0)).toBe(2);
    expect(failureRuns.size).toBe(1);
    expect(skipFailureIndex.has(1)).toBe(true);
    expect(skipFailureIndex.has(0)).toBe(false);
  });

  test("identical failures separated by explore + text still collapse", () => {
    const fail = { success: false, error: "table missing" };
    const parts = [
      executeSqlPart("SELECT * FROM x", fail),
      textPart("Let me check..."),
      explorePart("ls"),
      executeSqlPart("SELECT * FROM x", fail),
      explorePart("cat catalog.yml"),
      executeSqlPart("SELECT * FROM x", fail),
    ];
    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(parts);
    expect(failureRuns.get(0)).toBe(3);
    expect(skipFailureIndex.has(3)).toBe(true);
    expect(skipFailureIndex.has(5)).toBe(true);
  });

  test("same SQL with different error does NOT collapse", () => {
    const parts = [
      executeSqlPart("SELECT * FROM x", { success: false, error: "permission denied" }),
      executeSqlPart("SELECT * FROM x", { success: false, error: "connection lost" }),
    ];
    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(parts);
    expect(failureRuns.size).toBe(0);
    expect(skipFailureIndex.size).toBe(0);
  });

  test("non-string error is ignored for dedup keying (no false collapse)", () => {
    const parts = [
      executeSqlPart("SELECT 1", { success: false, error: { code: 42, msg: "boom" } }),
      executeSqlPart("SELECT 1", { success: false, error: { code: 99, msg: "different" } }),
    ];
    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(parts);
    expect(failureRuns.size).toBe(0);
    expect(skipFailureIndex.size).toBe(0);
  });

  test("successful executeSQL parts are ignored", () => {
    const parts = [
      executeSqlPart("SELECT 1", { success: true }),
      executeSqlPart("SELECT 1", { success: true }),
    ];
    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(parts);
    expect(failureRuns.size).toBe(0);
    expect(skipFailureIndex.size).toBe(0);
  });

  test("multiple distinct failure groups produce independent counts", () => {
    const failA = { success: false, error: "missing-a" };
    const failB = { success: false, error: "missing-b" };
    const parts = [
      executeSqlPart("SELECT a", failA),
      executeSqlPart("SELECT b", failB),
      executeSqlPart("SELECT a", failA),
      executeSqlPart("SELECT b", failB),
      executeSqlPart("SELECT a", failA),
    ];
    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(parts);
    expect(failureRuns.get(0)).toBe(3); // SELECT a appears at 0, 2, 4
    expect(failureRuns.get(1)).toBe(2); // SELECT b appears at 1, 3
    expect([...skipFailureIndex].sort()).toEqual([2, 3, 4]);
  });
});
