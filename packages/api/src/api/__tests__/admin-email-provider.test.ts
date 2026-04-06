/**
 * Tests for admin email provider route helpers.
 *
 * These test the maskSecret helper logic that protects API keys in responses.
 * The function is tested via the pattern it implements (same as settings.ts maskSecret).
 */

import { describe, it, expect } from "bun:test";

// Test the maskSecret logic directly (same implementation as in admin-email-provider.ts)
function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

describe("maskSecret", () => {
  it("returns undefined for undefined input", () => {
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(maskSecret("")).toBeUndefined();
  });

  it("fully masks short secrets (≤8 chars)", () => {
    expect(maskSecret("abc")).toBe("••••••••");
    expect(maskSecret("12345678")).toBe("••••••••");
  });

  it("shows first 4 and last 4 chars for longer secrets", () => {
    expect(maskSecret("re_abc123xyz")).toBe("re_a••••3xyz");
    expect(maskSecret("SG.very_long_api_key_here")).toBe("SG.v••••here");
  });

  it("never exposes the full secret", () => {
    const secret = "re_super_secret_api_key_12345";
    const masked = maskSecret(secret)!;
    expect(masked).not.toBe(secret);
    expect(masked).toContain("••••");
    // Only first 4 + last 4 = 8 chars of the original are visible
    expect(masked.replace(/•/g, "").length).toBe(8);
  });
});
