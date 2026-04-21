/**
 * Tests for unsubscribe-token HMAC helper.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  getUnsubscribeTokenTtlMs,
} = await import("../unsubscribe-token");

const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;
const ORIGINAL_TTL = process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS;

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_TTL === undefined) delete process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS;
  else process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS = ORIGINAL_TTL;
});

describe("signUnsubscribeToken", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-with-enough-entropy-1234567890";
  });

  it("returns a dot-joined `${exp}.${sig}` string", () => {
    const token = signUnsubscribeToken("user-1", Date.now() + 60_000);
    expect(token).not.toBeNull();
    const parts = token!.split(".");
    expect(parts.length).toBe(2);
    expect(Number.isFinite(Number(parts[0]))).toBe(true);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("returns null when BETTER_AUTH_SECRET is missing", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(signUnsubscribeToken("user-1", Date.now() + 60_000)).toBeNull();
  });

  it("produces different signatures for different users at the same expiry", () => {
    const exp = Date.now() + 60_000;
    const a = signUnsubscribeToken("user-1", exp);
    const b = signUnsubscribeToken("user-2", exp);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe("verifyUnsubscribeToken", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-with-enough-entropy-1234567890";
  });

  it("accepts a freshly-signed token for the same user", () => {
    const exp = Date.now() + 60_000;
    const token = signUnsubscribeToken("user-1", exp)!;
    expect(verifyUnsubscribeToken("user-1", token)).toEqual({ valid: true });
  });

  it("rejects a token signed for a different user (bad_sig)", () => {
    const exp = Date.now() + 60_000;
    const token = signUnsubscribeToken("user-1", exp)!;
    expect(verifyUnsubscribeToken("user-2", token)).toEqual({ valid: false, reason: "bad_sig" });
  });

  it("rejects a token signed with a different secret (bad_sig)", () => {
    const exp = Date.now() + 60_000;
    const token = signUnsubscribeToken("user-1", exp)!;
    process.env.BETTER_AUTH_SECRET = "different-secret-with-enough-entropy-abcdefg";
    expect(verifyUnsubscribeToken("user-1", token)).toEqual({ valid: false, reason: "bad_sig" });
  });

  it("rejects an expired token with reason=expired", () => {
    const exp = Date.now() - 1_000;
    const token = signUnsubscribeToken("user-1", exp)!;
    const res = verifyUnsubscribeToken("user-1", token);
    expect(res).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a malformed token (no dot)", () => {
    expect(verifyUnsubscribeToken("user-1", "notatoken")).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a malformed token (non-numeric expiry)", () => {
    expect(verifyUnsubscribeToken("user-1", "abc.xyz")).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a token with a tampered signature (bad_sig)", () => {
    const exp = Date.now() + 60_000;
    const token = signUnsubscribeToken("user-1", exp)!;
    const tampered = `${token.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(verifyUnsubscribeToken("user-1", tampered)).toEqual({ valid: false, reason: "bad_sig" });
  });

  it("rejects a token with a tampered expiry (bad_sig — sig no longer matches)", () => {
    const exp = Date.now() + 60_000;
    const token = signUnsubscribeToken("user-1", exp)!;
    const sig = token.split(".")[1];
    const tampered = `${Date.now() + 99_999_999}.${sig}`;
    expect(verifyUnsubscribeToken("user-1", tampered)).toEqual({ valid: false, reason: "bad_sig" });
  });

  it("rejects when BETTER_AUTH_SECRET is missing (no_secret)", () => {
    const exp = Date.now() + 60_000;
    const token = signUnsubscribeToken("user-1", exp)!;
    delete process.env.BETTER_AUTH_SECRET;
    expect(verifyUnsubscribeToken("user-1", token)).toEqual({ valid: false, reason: "no_secret" });
  });

  it("honors the `now` override for deterministic expiry tests", () => {
    const exp = 1_000_000;
    const token = signUnsubscribeToken("user-1", exp)!;
    expect(verifyUnsubscribeToken("user-1", token, 500_000)).toEqual({ valid: true });
    expect(verifyUnsubscribeToken("user-1", token, 1_000_001)).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a token signed with the raw secret (pins ':unsubscribe' key namespacing)", async () => {
    const crypto = await import("crypto");
    const exp = Date.now() + 60_000;
    const rawKey = process.env.BETTER_AUTH_SECRET!;
    // HMAC with the *raw* secret instead of the derived ":unsubscribe" key.
    // If someone refactors the namespacing away, this test breaks.
    const sig = crypto.createHmac("sha256", rawKey).update(`user-1:${exp}`).digest();
    const forged = `${exp}.${sig.toString("base64url")}`;
    expect(verifyUnsubscribeToken("user-1", forged)).toEqual({ valid: false, reason: "bad_sig" });
  });

  it("rejects a short signature via the length-mismatch guard", () => {
    const exp = Date.now() + 60_000;
    expect(verifyUnsubscribeToken("user-1", `${exp}.AA`)).toEqual({ valid: false, reason: "bad_sig" });
  });

  it("rejects a negative expiry (malformed, fails expiresAtMs > 0 guard)", () => {
    expect(verifyUnsubscribeToken("user-1", "-5.somesig")).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a zero expiry (malformed, fails expiresAtMs > 0 guard)", () => {
    expect(verifyUnsubscribeToken("user-1", "0.somesig")).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a NaN expiry (malformed, fails Number.isFinite guard)", () => {
    expect(verifyUnsubscribeToken("user-1", "notanumber.somesig")).toEqual({ valid: false, reason: "malformed" });
  });
});

describe("getUnsubscribeTokenTtlMs", () => {
  beforeEach(() => {
    delete process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS;
  });

  it("defaults to 30 days when env var not set", () => {
    expect(getUnsubscribeTokenTtlMs()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("uses a valid env override", () => {
    process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS = String(7 * 24 * 60 * 60 * 1000);
    expect(getUnsubscribeTokenTtlMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("falls back to default on nonsense values", () => {
    process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS = "not-a-number";
    expect(getUnsubscribeTokenTtlMs()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("falls back to default on values below the floor", () => {
    process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS = "100"; // 100ms, below 60s floor
    expect(getUnsubscribeTokenTtlMs()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("falls back to default on values above the ceiling", () => {
    process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS = String(10 * 365 * 24 * 60 * 60 * 1000);
    expect(getUnsubscribeTokenTtlMs()).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
