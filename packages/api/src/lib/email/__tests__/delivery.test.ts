/**
 * Tests for email delivery abstraction.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock settings to control getPlatformEmailConfig() behavior
// ---------------------------------------------------------------------------

let settingsStore: Record<string, string> = {};

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string) => settingsStore[key],
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { sendEmail } = await import("../delivery");

// ---------------------------------------------------------------------------
// Env snapshot + fetch mock
// ---------------------------------------------------------------------------

const ENV_KEYS = ["ATLAS_SMTP_URL", "RESEND_API_KEY", "ATLAS_EMAIL_FROM"] as const;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

function installFetchMock(response: { status: number; body: unknown }) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  delete process.env.ATLAS_SMTP_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.ATLAS_EMAIL_FROM;
  settingsStore = {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
});

// ---------------------------------------------------------------------------
// Fallback chain
// ---------------------------------------------------------------------------

describe("sendEmail — fallback chain", () => {
  it("falls back to log provider when no delivery backend configured", async () => {
    const result = await sendEmail({
      to: "test@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
    });
    expect(result.success).toBe(false);
    expect(result.provider).toBe("log");
    expect(result.error).toContain("No email delivery backend configured");
  });

  it("uses Resend env var when no platform config", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    installFetchMock({ status: 200, body: { id: "email-1" } });

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(true);
    expect(result.provider).toBe("resend");
  });

  it("handles Resend API errors gracefully", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    installFetchMock({ status: 401, body: "Unauthorized" });

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(false);
    expect(result.provider).toBe("resend");
    expect(result.error).toContain("401");
  });
});

// ---------------------------------------------------------------------------
// Platform email config (getPlatformEmailConfig via sendEmail)
// ---------------------------------------------------------------------------

describe("sendEmail — platform email provider", () => {
  it("uses platform Resend config when ATLAS_EMAIL_PROVIDER=resend and key is set", async () => {
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "resend";
    settingsStore["RESEND_API_KEY"] = "re_platform_key";
    settingsStore["ATLAS_EMAIL_FROM"] = "Platform <platform@example.com>";
    installFetchMock({ status: 200, body: { id: "platform-email-1" } });

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(true);
    expect(result.provider).toBe("resend");
    expect(result.messageId).toBe("platform-email-1");
  });

  it("uses platform SendGrid config when ATLAS_EMAIL_PROVIDER=sendgrid", async () => {
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "sendgrid";
    settingsStore["SENDGRID_API_KEY"] = "SG.platform_key";
    installFetchMock({ status: 202, body: {} });

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(true);
    expect(result.provider).toBe("sendgrid");
  });

  it("uses platform Postmark config when ATLAS_EMAIL_PROVIDER=postmark", async () => {
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "postmark";
    settingsStore["POSTMARK_SERVER_TOKEN"] = "pm_token_123";
    installFetchMock({ status: 200, body: {} });

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(true);
    expect(result.provider).toBe("postmark");
  });

  it("falls through when platform provider is set but API key is missing", async () => {
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "resend";
    // No RESEND_API_KEY in settings or env

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(false);
    expect(result.provider).toBe("log");
  });

  it("falls through when platform provider is unrecognized", async () => {
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "mailgun";

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(false);
    expect(result.provider).toBe("log");
  });

  it("platform config takes priority over env-var RESEND_API_KEY", async () => {
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "sendgrid";
    settingsStore["SENDGRID_API_KEY"] = "SG.platform_key";
    process.env.RESEND_API_KEY = "re_env_key"; // should NOT be used
    installFetchMock({ status: 202, body: {} });

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(true);
    expect(result.provider).toBe("sendgrid"); // NOT resend
  });

  it("smtp/ses platform config falls through without ATLAS_SMTP_URL", async () => {
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "smtp";

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(false);
    expect(result.provider).toBe("log");
  });
});
