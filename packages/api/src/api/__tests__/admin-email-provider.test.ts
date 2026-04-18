/**
 * Tests for the admin email provider route's secret-masking helper.
 *
 * Imports the real implementation from the route so a regression in the
 * function (short-key fallthrough, leaked secrets) fails this test instead
 * of silently passing against a stale duplicate.
 */

import { describe, it, expect } from "bun:test";
import { maskSecret } from "@atlas/api/api/routes/admin-email-provider";

describe("maskSecret", () => {
  it("fully masks short secrets (≤8 chars)", () => {
    expect(maskSecret("abc")).toBe("••••••••");
    expect(maskSecret("12345678")).toBe("••••••••");
  });

  it("shows first 4 and last 4 chars for longer secrets", () => {
    expect(maskSecret("re_abc123xyz")).toBe("re_a••••3xyz");
    expect(maskSecret("re_very_long_api_key_here")).toBe("re_v••••here");
  });

  it("never exposes the full secret", () => {
    const secret = "re_super_secret_api_key_12345";
    const masked = maskSecret(secret);
    expect(masked).not.toBe(secret);
    expect(masked).toContain("••••");
    // Only first 4 + last 4 = 8 chars of the original are visible
    expect(masked.replace(/•/g, "").length).toBe(8);
  });
});
