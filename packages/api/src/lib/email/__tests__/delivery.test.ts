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

const {
  sendEmail,
  isAuthEmailDeliveryConfigured,
  sendTransactionalEmail,
  shouldEnqueueFailedSend,
  enqueueFailedTransactionalEmail,
} = await import("../delivery");
type DeliveryResult = import("../delivery").DeliveryResult;
type EmailMessage = import("../delivery").EmailMessage;

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
// Transient-failure retry (#2942)
// ---------------------------------------------------------------------------

describe("sendEmail — transient retry (#2942)", () => {
  it("retries a transient 503 then succeeds", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const status = calls === 1 ? 503 : 200;
      return new Response(JSON.stringify(status === 200 ? { id: "email-2" } : "Service Unavailable"), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(true);
    expect(result.provider).toBe("resend");
    expect(calls).toBe(2); // first 503 retried, second 200 returned
  });

  it("does not retry a permanent 4xx (401)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify("Unauthorized"), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hello</p>" });
    expect(result.success).toBe(false);
    expect(calls).toBe(1); // 401 is permanent — no retry
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


// ---------------------------------------------------------------------------
// isAuthEmailDeliveryConfigured — UI hint for /login forgot-password link
// ---------------------------------------------------------------------------

describe("isAuthEmailDeliveryConfigured", () => {
  it("returns false when nothing is configured", () => {
    expect(isAuthEmailDeliveryConfigured()).toBe(false);
  });

  it("returns true when RESEND_API_KEY is set", () => {
    process.env.RESEND_API_KEY = "re_test_key";
    expect(isAuthEmailDeliveryConfigured()).toBe(true);
  });

  it("returns true when ATLAS_SMTP_URL is set", () => {
    process.env.ATLAS_SMTP_URL = "http://localhost:2525";
    expect(isAuthEmailDeliveryConfigured()).toBe(true);
  });

  it("returns true when platform settings configure a provider with a key", () => {
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "resend";
    settingsStore["RESEND_API_KEY"] = "re_platform_key";
    expect(isAuthEmailDeliveryConfigured()).toBe(true);
  });

  it("returns false when ATLAS_EMAIL_PROVIDER is set but its API key is missing", () => {
    // Misconfiguration must not surface a forgot-password link that
    // sends email into a black hole.
    settingsStore["ATLAS_EMAIL_PROVIDER"] = "resend";
    expect(isAuthEmailDeliveryConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Durable transactional email — sendTransactionalEmail (#2942)
// ---------------------------------------------------------------------------

const MSG: EmailMessage = { to: "user@example.com", subject: "Reset", html: "<p>x</p>" };

describe("shouldEnqueueFailedSend", () => {
  it("enqueues a real-transport failure", () => {
    expect(
      shouldEnqueueFailedSend({ success: false, provider: "resend", error: "503" } as DeliveryResult),
    ).toBe(true);
  });

  it("does NOT enqueue a success", () => {
    expect(shouldEnqueueFailedSend({ success: true, provider: "resend" } as DeliveryResult)).toBe(false);
  });

  it("does NOT enqueue the log/no-transport fallback (nowhere to deliver)", () => {
    expect(
      shouldEnqueueFailedSend({ success: false, provider: "log", error: "none" } as DeliveryResult),
    ).toBe(false);
  });
});

describe("sendTransactionalEmail", () => {
  it("returns the send result and does NOT enqueue on success", async () => {
    let enqueued = 0;
    const result = await sendTransactionalEmail(
      MSG,
      { emailType: "password-reset" },
      {
        send: async () => ({ success: true, provider: "resend", messageId: "m1" }),
        enqueueFailed: async () => {
          enqueued++;
        },
      },
    );
    expect(result.success).toBe(true);
    expect(enqueued).toBe(0);
  });

  it("enqueues for durable retry when a real transport fails (sustained outage)", async () => {
    const enqueuedWith: Array<{ to: string; emailType: string }> = [];
    const result = await sendTransactionalEmail(
      MSG,
      { emailType: "password-reset", orgId: "org-1" },
      {
        send: async () => ({ success: false, provider: "resend", error: "Resend 503" }),
        enqueueFailed: async (m, o) => {
          enqueuedWith.push({ to: m.to, emailType: o.emailType });
        },
      },
    );
    // Caller still sees the original failed result (it stays 200-safe).
    expect(result.success).toBe(false);
    expect(enqueuedWith).toEqual([{ to: "user@example.com", emailType: "password-reset" }]);
  });

  it("does NOT enqueue when no transport is configured (provider=log)", async () => {
    let enqueued = 0;
    await sendTransactionalEmail(
      MSG,
      { emailType: "password-reset" },
      {
        send: async () => ({ success: false, provider: "log", error: "no backend" }),
        enqueueFailed: async () => {
          enqueued++;
        },
      },
    );
    expect(enqueued).toBe(0);
  });

  it("never throws even if enqueue throws — preserves the enumeration-safe 200 (F-09)", async () => {
    const result = await sendTransactionalEmail(
      MSG,
      { emailType: "password-reset" },
      {
        send: async () => ({ success: false, provider: "resend", error: "503" }),
        enqueueFailed: async () => {
          throw new Error("DB exploded");
        },
      },
    );
    // Resolved (not rejected) with the original result.
    expect(result.success).toBe(false);
    expect(result.provider).toBe("resend");
  });
});

describe("enqueueFailedTransactionalEmail", () => {
  it("does not throw and skips enqueue when no internal DB is configured", async () => {
    // No DATABASE_URL in the unit-test env → hasInternalDB() is false →
    // the function warns and returns rather than throwing. This pins the
    // F-09 no-throw contract on the real (non-injected) path.
    await expect(
      enqueueFailedTransactionalEmail(MSG, { emailType: "password-reset" }),
    ).resolves.toBeUndefined();
  });
});
