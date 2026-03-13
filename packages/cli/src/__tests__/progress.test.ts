import { describe, expect, test } from "bun:test";
import { formatDuration, estimateRemaining } from "../progress";

describe("formatDuration", () => {
  test("formats sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(500)).toBe("1s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(42000)).toBe("42s");
    expect(formatDuration(59499)).toBe("59s");
  });

  test("formats minute+ durations with minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(72000)).toBe("1m 12s");
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(125000)).toBe("2m 5s");
    expect(formatDuration(300000)).toBe("5m");
  });

  test("rounds to nearest second", () => {
    expect(formatDuration(1499)).toBe("1s");
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(61400)).toBe("1m 1s");
  });
});

describe("estimateRemaining", () => {
  test("returns 0 when no items completed", () => {
    expect(estimateRemaining(5000, 0, 10)).toBe(0);
  });

  test("returns 0 when all items completed", () => {
    expect(estimateRemaining(10000, 10, 10)).toBe(0);
  });

  test("returns 0 when completed exceeds total", () => {
    expect(estimateRemaining(10000, 15, 10)).toBe(0);
  });

  test("estimates correctly for linear progress", () => {
    // 10s elapsed, 5/10 done → 10s remaining
    expect(estimateRemaining(10000, 5, 10)).toBe(10000);
  });

  test("estimates correctly for partial progress", () => {
    // 18s elapsed, 12/47 done → (18/12) * 35 = 52.5s remaining
    expect(estimateRemaining(18000, 12, 47)).toBe(52500);
  });

  test("handles 1 table completed", () => {
    // 2s elapsed, 1/100 done → 198s remaining
    expect(estimateRemaining(2000, 1, 100)).toBe(198000);
  });

  test("handles near-completion", () => {
    // 45s elapsed, 46/47 done → (45/46) * 1 ≈ 0.978s
    const result = estimateRemaining(45000, 46, 47);
    expect(result).toBeCloseTo(978.26, 0);
  });
});
