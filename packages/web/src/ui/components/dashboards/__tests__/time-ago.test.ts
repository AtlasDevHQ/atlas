import { describe, expect, test } from "bun:test";
import { timeAgo } from "../time-ago";

const NOW = new Date("2026-07-17T12:00:00Z").getTime();

describe("timeAgo", () => {
  test("null → 'never'", () => {
    expect(timeAgo(null, NOW)).toBe("never");
  });

  test("a malformed timestamp → 'never', never 'Invalid Date'", () => {
    expect(timeAgo("not-a-date", NOW)).toBe("never");
  });

  test("under a minute in the past → 'just now'", () => {
    expect(timeAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now");
  });

  test("minute / hour / day buckets", () => {
    expect(timeAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
    expect(timeAgo(new Date(NOW - 3 * 60 * 60_000).toISOString(), NOW)).toBe("3h ago");
    expect(timeAgo(new Date(NOW - 4 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("4d ago");
  });

  test("#4567 — a clock-skewed FUTURE timestamp never reads 'just now'", () => {
    const future = new Date(NOW + 45_000).toISOString();
    expect(timeAgo(future, NOW)).not.toBe("just now");
    expect(timeAgo(future, NOW)).toBe("moments ago");
  });

  test("#4567 — a far-future timestamp is still not 'just now' (skew never masks)", () => {
    const farFuture = new Date(NOW + 2 * 60 * 60_000).toISOString();
    expect(timeAgo(farFuture, NOW)).toBe("moments ago");
  });

  test("#4567 — the injected `now` drives the label (live-tick friendly)", () => {
    const iso = new Date(NOW).toISOString();
    // Same timestamp, a later `now` → an older caption. This is what makes the
    // caption tick without the underlying data changing.
    expect(timeAgo(iso, NOW)).toBe("just now");
    expect(timeAgo(iso, NOW + 90_000)).toBe("1m ago");
  });
});
