/**
 * Tests for email delivery abstraction.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

describe("sendEmail", () => {
  beforeEach(() => {
    // Reset env to defaults
    delete process.env.ATLAS_SMTP_URL;
    delete process.env.RESEND_API_KEY;
    delete process.env.ATLAS_EMAIL_FROM;
  });

  it("falls back to log provider when no delivery backend configured", async () => {
    const { sendEmail } = await import("../delivery");

    const result = await sendEmail({
      to: "test@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
    });

    expect(result.success).toBe(false);
    expect(result.provider).toBe("log");
    expect(result.error).toContain("No email delivery backend configured");
  });

  it("uses Resend when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ id: "email-1" }), { status: 200 })),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const { sendEmail } = await import("../delivery");
      const result = await sendEmail({
        to: "test@example.com",
        subject: "Test",
        html: "<p>Hello</p>",
      });

      expect(result.success).toBe(true);
      expect(result.provider).toBe("resend");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.RESEND_API_KEY;
    }
  });

  it("handles Resend API errors gracefully", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    const mockFetch = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const { sendEmail } = await import("../delivery");
      const result = await sendEmail({
        to: "test@example.com",
        subject: "Test",
        html: "<p>Hello</p>",
      });

      expect(result.success).toBe(false);
      expect(result.provider).toBe("resend");
      expect(result.error).toContain("401");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.RESEND_API_KEY;
    }
  });
});
