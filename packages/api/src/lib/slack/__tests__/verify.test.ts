/**
 * Tests for Slack request signature verification.
 */

import { describe, it, expect } from "bun:test";
import crypto from "crypto";
import { verifySlackSignature } from "../verify";

const SIGNING_SECRET = "test_signing_secret_12345";

function makeSignature(secret: string, timestamp: string, body: string): string {
  const sigBasestring = `v0:${timestamp}:${body}`;
  return (
    "v0=" + crypto.createHmac("sha256", secret).update(sigBasestring).digest("hex")
  );
}

function currentTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifySlackSignature", () => {
  it("accepts a valid signature", () => {
    const timestamp = currentTimestamp();
    const body = "token=xxx&team_id=T123&text=hello";
    const signature = makeSignature(SIGNING_SECRET, timestamp, body);

    const result = verifySlackSignature(SIGNING_SECRET, signature, timestamp, body);
    expect(result.valid).toBe(true);
    expect("error" in result).toBe(false);
  });

  it("rejects an invalid signature", () => {
    const timestamp = currentTimestamp();
    const body = "token=xxx&team_id=T123&text=hello";
    const signature = "v0=deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

    const result = verifySlackSignature(SIGNING_SECRET, signature, timestamp, body);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Invalid signature");
  });

  it("rejects missing signature header", () => {
    const timestamp = currentTimestamp();
    const body = "token=xxx";

    const result = verifySlackSignature(SIGNING_SECRET, null, timestamp, body);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Missing signature or timestamp headers");
  });

  it("rejects missing timestamp header", () => {
    const body = "token=xxx";
    const signature = "v0=something";

    const result = verifySlackSignature(SIGNING_SECRET, signature, null, body);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Missing signature or timestamp headers");
  });

  it("rejects expired timestamp (>5 minutes old)", () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400); // 6+ minutes ago
    const body = "token=xxx";
    const signature = makeSignature(SIGNING_SECRET, oldTimestamp, body);

    const result = verifySlackSignature(SIGNING_SECRET, signature, oldTimestamp, body);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Request timestamp too old");
  });

  it("accepts timestamp within 5-minute window", () => {
    const recentTimestamp = String(Math.floor(Date.now() / 1000) - 200); // ~3 minutes ago
    const body = "token=xxx";
    const signature = makeSignature(SIGNING_SECRET, recentTimestamp, body);

    const result = verifySlackSignature(SIGNING_SECRET, signature, recentTimestamp, body);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid (non-numeric) timestamp", () => {
    const body = "token=xxx";
    const result = verifySlackSignature(SIGNING_SECRET, "v0=abc", "not-a-number", body);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Invalid timestamp");
  });

  it("rejects signature with wrong secret", () => {
    const timestamp = currentTimestamp();
    const body = "token=xxx";
    const signature = makeSignature("wrong_secret", timestamp, body);

    const result = verifySlackSignature(SIGNING_SECRET, signature, timestamp, body);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Invalid signature");
  });

  it("rejects tampered body", () => {
    const timestamp = currentTimestamp();
    const body = "token=xxx&text=original";
    const signature = makeSignature(SIGNING_SECRET, timestamp, body);

    const result = verifySlackSignature(
      SIGNING_SECRET,
      signature,
      timestamp,
      "token=xxx&text=tampered",
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Invalid signature");
  });
});
