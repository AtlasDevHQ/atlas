/**
 * Signature-vector tests for both signing strategies.
 *
 * These lock the on-the-wire format byte-for-byte: the golden hex values are
 * the contract the inbound `@useatlas/webhook` verifier and customer
 * verify-helpers depend on. Changing them is a breaking wire change.
 */

import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";

import { timestamped, rawBody } from "../sign";

const SECRET = "whsec_test_secret";
const TS = 1700000000;
const BODY = JSON.stringify({ event: "added", entry: { name: "Vercel" } });

// Golden vectors — computed offline. If these change, the wire format changed.
const GOLDEN_TIMESTAMPED =
  "sha256=570168a480b54416f6e6303aaa219e27d72a38ea7a3ec4f19b4f0c37baec274b";
const GOLDEN_RAW_BODY =
  "03a4e22d80049faa40e00c334e07b5571a505c37d7d44a526008e76cdea8c9b7";

describe("timestamped", () => {
  it("matches the golden `sha256=<hmac(`${ts}:${body}`)>` vector", () => {
    const signed = timestamped({ secret: SECRET, timestampSeconds: TS })(BODY);
    expect(signed.signature).toBe(GOLDEN_TIMESTAMPED);
  });

  it("sets X-Webhook-Signature, X-Webhook-Timestamp, and Content-Type", () => {
    const signed = timestamped({ secret: SECRET, timestampSeconds: TS })(BODY);
    expect(signed.headers["X-Webhook-Signature"]).toBe(GOLDEN_TIMESTAMPED);
    expect(signed.headers["X-Webhook-Timestamp"]).toBe(String(TS));
    expect(signed.headers["Content-Type"]).toBe("application/json");
  });

  it("is verifiable by the inbound `${ts}:${body}` algorithm (tolerating the sha256= prefix)", () => {
    const signed = timestamped({ secret: SECRET, timestampSeconds: TS })(BODY);
    const ts = Number.parseInt(signed.headers["X-Webhook-Timestamp"], 10);
    // Mirror plugins/webhook/src/replay.ts verifyHmacWithTimestamp, which
    // strips the prefix before constant-time comparing.
    const expectedHex = crypto
      .createHmac("sha256", SECRET)
      .update(`${ts}:${BODY}`)
      .digest("hex");
    expect(signed.signature.replace(/^sha256=/, "")).toBe(expectedHex);
  });

  it("defaults the timestamp to now when not injected", () => {
    const before = Math.floor(Date.now() / 1000);
    const signed = timestamped({ secret: SECRET })(BODY);
    const after = Math.floor(Date.now() / 1000);
    const ts = Number.parseInt(signed.headers["X-Webhook-Timestamp"], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("is key-sensitive", () => {
    const a = timestamped({ secret: "k1", timestampSeconds: TS })(BODY).signature;
    const b = timestamped({ secret: "k2", timestampSeconds: TS })(BODY).signature;
    expect(a).not.toBe(b);
  });
});

describe("rawBody", () => {
  it("matches the golden bare-hex `hmac(rawBody)` vector", () => {
    const signed = rawBody({ secret: SECRET })(BODY);
    expect(signed.signature).toBe(GOLDEN_RAW_BODY);
  });

  it("sets X-Atlas-Signature and Content-Type, and emits no timestamp", () => {
    const signed = rawBody({ secret: SECRET })(BODY);
    expect(signed.headers["X-Atlas-Signature"]).toBe(GOLDEN_RAW_BODY);
    expect(signed.headers["Content-Type"]).toBe("application/json");
    expect(signed.headers["X-Webhook-Timestamp"]).toBeUndefined();
  });

  it("returns 64 hex chars with no prefix (sha256 → 32 bytes)", () => {
    const signed = rawBody({ secret: SECRET })(BODY);
    expect(signed.signature).toHaveLength(64);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is verifiable by recomputing the MAC over the raw body", () => {
    const signed = rawBody({ secret: SECRET })(BODY);
    const expected = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(signed.signature).toBe(expected);
  });

  it("is key-sensitive", () => {
    expect(rawBody({ secret: "k1" })(BODY).signature).not.toBe(
      rawBody({ secret: "k2" })(BODY).signature,
    );
  });
});
