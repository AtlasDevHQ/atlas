import { describe, expect, test } from "bun:test";
import { shortUA } from "../columns";

describe("shortUA", () => {
  test("null input returns em-dash placeholder", () => {
    expect(shortUA(null)).toBe("—");
  });

  test("empty string also returns the em-dash placeholder", () => {
    // The helper uses `if (!ua)` — not a typeof/null check — so the
    // falsy-coalesce path handles both `null` and `""`. Pinned so a
    // refactor to a strict null check (which would render "" verbatim)
    // would be caught.
    expect(shortUA("")).toBe("—");
  });

  test("browser match returns the Chrome/version segment only", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.6099.129 Safari/537.36";
    // When multiple browser tokens appear in the UA, the leftmost match
    // in the input string wins — JS regex scans left-to-right and returns
    // the first position where any alternative matches. Chrome appears
    // before Safari in real Chromium UAs, which is what this fixture
    // pins. A refactor that swapped the order of tokens in the input
    // (not a reordering of the regex alternation) would change the
    // match target, which is the actual contract worth guarding.
    expect(shortUA(ua)).toBe("Chrome/120.0.6099.129");
  });

  test("long unrecognized UA is truncated to 50 chars + ellipsis", () => {
    const ua = "MegaCorpCrawler/1.0 (+https://example.com/bot/policy/v2/details)";
    expect(ua.length).toBeGreaterThan(50);
    const out = shortUA(ua);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe(ua.slice(0, 50) + "…");
  });

  test("short unrecognized UA is returned verbatim", () => {
    const ua = "curl/8.0.1";
    expect(ua.length).toBeLessThanOrEqual(50);
    expect(shortUA(ua)).toBe(ua);
  });

  test("bot/CLI with no browser match falls through to full UA", () => {
    // No "Chrome|Firefox|Safari|Edge|Opera|Brave" → regex miss. Length is
    // under 50 → passthrough. Guards the fallthrough branch from silently
    // becoming a forced truncation.
    const ua = "Googlebot/2.1 (+http://www.google.com/bot.html)";
    expect(shortUA(ua)).toBe(ua);
  });
});
