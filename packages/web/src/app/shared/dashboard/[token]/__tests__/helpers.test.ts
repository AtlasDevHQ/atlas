import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mostRecentCachedAt, tileSpanClass, isoOrUndefined, timeAgo } from "../helpers";
import type { SharedCard } from "../types";

function card(over: Partial<SharedCard> = {}): SharedCard {
  return {
    id: "c1",
    title: "T",
    sql: "SELECT 1",
    chartConfig: null,
    cachedColumns: null,
    cachedRows: null,
    cachedAt: null,
    position: 0,
    layout: null,
    ...over,
  };
}

describe("tileSpanClass", () => {
  test("nullable layout falls back to half-width", () => {
    expect(tileSpanClass(null)).toBe("md:col-span-1");
  });

  test("w=12 (half) → col-span-1", () => {
    expect(tileSpanClass({ x: 0, y: 0, w: 12, h: 3 })).toBe("md:col-span-1");
  });

  test("w=13 (boundary) → col-span-2", () => {
    expect(tileSpanClass({ x: 0, y: 0, w: 13, h: 3 })).toBe("md:col-span-2");
  });

  test("w=24 (full editor row) → col-span-2", () => {
    expect(tileSpanClass({ x: 0, y: 0, w: 24, h: 3 })).toBe("md:col-span-2");
  });

  test("w=1 (narrow editor tile) → col-span-1", () => {
    expect(tileSpanClass({ x: 0, y: 0, w: 1, h: 3 })).toBe("md:col-span-1");
  });
});

describe("mostRecentCachedAt", () => {
  test("empty array → null", () => {
    expect(mostRecentCachedAt([])).toBe(null);
  });

  test("all-null cachedAt → null", () => {
    expect(mostRecentCachedAt([card(), card()])).toBe(null);
  });

  test("single card returns its timestamp", () => {
    const ts = "2026-04-26T10:00:00.000Z";
    expect(mostRecentCachedAt([card({ cachedAt: ts })])).toBe(ts);
  });

  test("returns the most recent across mixed cards", () => {
    const older = "2026-04-25T10:00:00.000Z";
    const newer = "2026-04-26T18:30:00.000Z";
    expect(
      mostRecentCachedAt([
        card({ id: "a", cachedAt: older }),
        card({ id: "b", cachedAt: null }),
        card({ id: "c", cachedAt: newer }),
      ]),
    ).toBe(newer);
  });

  test("skips invalid timestamps without taking them as max", () => {
    const consoleSpy = mock(() => undefined);
    const orig = console.warn;
    console.warn = consoleSpy;
    try {
      const valid = "2026-04-26T10:00:00.000Z";
      expect(
        mostRecentCachedAt([
          card({ id: "a", cachedAt: "not a date" }),
          card({ id: "b", cachedAt: valid }),
        ]),
      ).toBe(valid);
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      console.warn = orig;
    }
  });
});

describe("isoOrUndefined", () => {
  test("null → undefined", () => {
    expect(isoOrUndefined(null)).toBeUndefined();
  });

  test("valid ISO round-trips", () => {
    const ts = "2026-04-26T10:00:00.000Z";
    expect(isoOrUndefined(ts)).toBe(ts);
  });

  test("Date.toString() form coerces to ISO", () => {
    const ts = "Sun Apr 26 2026 12:04:19 GMT-0400 (Eastern Daylight Time)";
    const out = isoOrUndefined(ts);
    expect(out).toMatch(/^2026-04-26T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("malformed value → undefined + warns", () => {
    const consoleSpy = mock(() => undefined);
    const orig = console.warn;
    console.warn = consoleSpy;
    try {
      expect(isoOrUndefined("nope")).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      console.warn = orig;
    }
  });
});

describe("timeAgo", () => {
  const NOW = new Date("2026-04-26T12:00:00.000Z").getTime();
  let realDateNow: () => number;
  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = () => NOW;
  });
  afterEach(() => {
    Date.now = realDateNow;
  });

  test("null → null", () => {
    expect(timeAgo(null)).toBe(null);
  });

  test("under a minute → 'just now'", () => {
    expect(timeAgo(new Date(NOW - 30_000).toISOString())).toBe("just now");
  });

  test("minutes branch", () => {
    expect(timeAgo(new Date(NOW - 5 * 60_000).toISOString())).toBe("5m ago");
  });

  test("hours branch", () => {
    expect(timeAgo(new Date(NOW - 3 * 60 * 60_000).toISOString())).toBe("3h ago");
  });

  test("days branch", () => {
    expect(timeAgo(new Date(NOW - 4 * 24 * 60 * 60_000).toISOString())).toBe("4d ago");
  });
});
