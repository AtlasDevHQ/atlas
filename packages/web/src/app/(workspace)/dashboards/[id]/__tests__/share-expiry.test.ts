/**
 * Regression pin for #4536 — editing a live share's visibility silently reset
 * its expiry to 7 days because the "Link expires" control never synced to the
 * share's real `expiresAt` and re-POSTed its `"7d"` mount default.
 *
 * `deriveExpiryKey` is the fix: it maps a share's absolute `expiresAt` back to a
 * dropdown bucket so the control reflects the real lifetime (never disagreeing
 * with the summary) and a visibility-only "Update settings" round-trips the
 * ORIGINAL lifetime instead of collapsing it to 7 days.
 */
import { describe, expect, test } from "bun:test";
import { deriveExpiryKey } from "../share-expiry";

const NOW = new Date("2026-07-17T12:00:00.000Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

const HOUR = 3600_000;
const DAY = 86_400_000;

describe("deriveExpiryKey", () => {
  test("a no-expiry share maps to 'never' (the core #4536 harm: Never must not become 7d)", () => {
    expect(deriveExpiryKey(null, NOW)).toBe("never");
  });

  test("a freshly-minted 30-day share reads as '30d', not the stale '7d' default", () => {
    // Barely-aged 30d link (a few seconds elapsed since mint).
    expect(deriveExpiryKey(iso(30 * DAY - 5000), NOW)).toBe("30d");
  });

  test("an aged 30-day share (28 days left) still recovers '30d'", () => {
    // Smallest bucket that still covers 28 days is 30d — never rounds down to 7d.
    expect(deriveExpiryKey(iso(28 * DAY), NOW)).toBe("30d");
  });

  test("a fresh 7-day share reads as '7d'", () => {
    expect(deriveExpiryKey(iso(7 * DAY - 5000), NOW)).toBe("7d");
  });

  test("a 24-hour share reads as '24h'", () => {
    expect(deriveExpiryKey(iso(24 * HOUR - 5000), NOW)).toBe("24h");
  });

  test("a 1-hour share reads as '1h'", () => {
    expect(deriveExpiryKey(iso(HOUR - 5000), NOW)).toBe("1h");
  });

  test("remaining time between buckets rounds UP to the covering bucket (never down)", () => {
    // 2 days left: too big for 24h, so the smallest covering bucket is 7d.
    expect(deriveExpiryKey(iso(2 * DAY), NOW)).toBe("7d");
  });

  test("an exact-boundary remaining time maps to that bucket (>= is inclusive)", () => {
    // Exactly 1h/24h left — the `>=` comparison must keep it in its own bucket,
    // not spill up to the next one.
    expect(deriveExpiryKey(iso(HOUR), NOW)).toBe("1h");
    expect(deriveExpiryKey(iso(24 * HOUR), NOW)).toBe("24h");
  });

  test("remaining exactly 0 hits the expired fallback, not '1h' via the >= scan", () => {
    expect(deriveExpiryKey(iso(0), NOW)).toBe("1h");
  });

  test("KNOWN-LOSSY: a heavily-aged 30d link (<7d left) derives '7d' by design", () => {
    // Accepted limitation (see share-expiry.ts module doc): once a share has aged
    // past one bucket-step, its original bucket can't be recovered — only the
    // smallest bucket that still covers the remaining time. 5 days left → "7d".
    // This is monotonic (never rounds DOWN into a shorter lifetime) and never
    // reintroduces the null→7d harm; a null/"never" link stays immune.
    expect(deriveExpiryKey(iso(5 * DAY), NOW)).toBe("7d");
  });

  test("an already-expired instant falls back to the smallest concrete bucket", () => {
    expect(deriveExpiryKey(iso(-DAY), NOW)).toBe("1h");
  });

  test("a future-dated instant beyond 30 days caps at the largest bucket", () => {
    expect(deriveExpiryKey(iso(90 * DAY), NOW)).toBe("30d");
  });

  test("an unparseable timestamp does not masquerade as a fresh 7-day link", () => {
    expect(deriveExpiryKey("not-a-date", NOW)).toBe("never");
  });
});
