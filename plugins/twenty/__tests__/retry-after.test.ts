/**
 * `parseRetryAfterMs` — RFC 9110 §10.2.3 covers two valid forms:
 * delta-seconds and HTTP-date. Both must round-trip cleanly through
 * the parser, and any garbage / negative value must collapse to
 * undefined (so a misbehaving upstream can't ask us to retry in the
 * past — which would either be a no-op or, worse, produce a negative
 * interval the outbox would store as a Postgres-rejected timestamp).
 */

import { describe, expect, test } from "bun:test";
import { parseRetryAfterMs, TwentyClientError } from "../src/client";

describe("parseRetryAfterMs — delta-seconds form", () => {
  test("plain integer", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
  });

  test("leading zeros are accepted", () => {
    expect(parseRetryAfterMs("0030")).toBe(30_000);
  });

  test("zero is a valid delay", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  test("trims surrounding whitespace", () => {
    expect(parseRetryAfterMs("  90  ")).toBe(90_000);
  });
});

describe("parseRetryAfterMs — HTTP-date form", () => {
  test("future date returns positive delta", () => {
    const futureMs = Date.now() + 60_000;
    const headerValue = new Date(futureMs).toUTCString();
    const parsed = parseRetryAfterMs(headerValue);
    expect(parsed).not.toBeUndefined();
    // Allow a wide tolerance for slow CI between Date.now() calls.
    if (parsed !== undefined) {
      expect(parsed).toBeGreaterThanOrEqual(58_000);
      expect(parsed).toBeLessThanOrEqual(60_000);
    }
  });

  test("past date clamps to 0 rather than producing a negative interval", () => {
    const pastDate = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfterMs(pastDate)).toBe(0);
  });
});

describe("parseRetryAfterMs — bad input", () => {
  test("null / undefined / empty → undefined", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("   ")).toBeUndefined();
  });

  test("garbage strings → undefined", () => {
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs("not-a-date-and-not-an-integer")).toBeUndefined();
  });

  test("negative integers → 0 (clamped — never produces a negative interval)", () => {
    // The regex /^\d+$/ rejects the leading `-` so we fall through to
    // Date.parse. Some JS engines parse "-60" as year -60 which is
    // far in the past; the clamp guarantees a safe ≥0 result.
    expect(parseRetryAfterMs("-60")).toBe(0);
  });
});

describe("TwentyClientError carries retryAfterMs", () => {
  test("retryAfterMs is preserved on construction", () => {
    const err = new TwentyClientError({
      message: "rate limited",
      status: 429,
      operation: "createPerson" as const,
      retryAfterMs: 45_000,
    });
    expect(err.retryAfterMs).toBe(45_000);
  });

  test("retryAfterMs is optional", () => {
    const err = new TwentyClientError({
      message: "internal",
      status: 503,
      operation: "createPerson" as const,
    });
    expect(err.retryAfterMs).toBeUndefined();
  });
});
