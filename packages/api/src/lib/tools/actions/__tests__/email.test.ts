import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock handler module so we don't hit real DB / auth
// ---------------------------------------------------------------------------

let lastHandleActionCall: { request: unknown; executeFn: unknown } | null = null;

mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  buildActionRequest: (params: Record<string, unknown>) => ({
    id: "test-action-id",
    ...params,
  }),
  handleAction: async (request: unknown, executeFn: unknown) => {
    lastHandleActionCall = { request, executeFn };
    return { status: "pending_approval", actionId: "test-action-id", summary: "test" };
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { executeEmailSend, sendEmailReport } = await import(
  "@atlas/api/lib/tools/actions/email"
);

// ---------------------------------------------------------------------------
// Env snapshot + fetch mock
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "RESEND_API_KEY",
  "ATLAS_EMAIL_FROM",
  "ATLAS_EMAIL_ALLOWED_DOMAINS",
] as const;

const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

let capturedFetchUrl = "";
let capturedFetchInit: RequestInit | undefined;

function installFetchMock(
  response: { status: number; body: unknown },
) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedFetchUrl = typeof input === "string" ? input : (input as Request).url;
    capturedFetchInit = init;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  lastHandleActionCall = null;
  capturedFetchUrl = "";
  capturedFetchInit = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
});

// ---------------------------------------------------------------------------
// AtlasAction metadata
// ---------------------------------------------------------------------------

describe("sendEmailReport — metadata", () => {
  it("has the correct actionType", () => {
    expect(sendEmailReport.actionType).toBe("email:send");
  });

  it("is not reversible", () => {
    expect(sendEmailReport.reversible).toBe(false);
  });

  it("defaults to admin-only approval", () => {
    expect(sendEmailReport.defaultApproval).toBe("admin-only");
  });

  it("requires RESEND_API_KEY", () => {
    expect(sendEmailReport.requiredCredentials).toEqual(["RESEND_API_KEY"]);
  });

  it("has a name", () => {
    expect(sendEmailReport.name).toBe("sendEmailReport");
  });

  it("has a description", () => {
    expect(sendEmailReport.description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// executeEmailSend — raw API call
// ---------------------------------------------------------------------------

describe("executeEmailSend", () => {
  it("throws when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;

    await expect(
      executeEmailSend({
        to: "user@example.com",
        subject: "Test",
        body: "<p>Hello</p>",
      }),
    ).rejects.toThrow("Missing RESEND_API_KEY");
  });

  it("calls Resend API with correct params", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    process.env.ATLAS_EMAIL_FROM = "Reports <reports@company.com>";

    installFetchMock({ status: 200, body: { id: "email-id-123" } });

    const result = await executeEmailSend({
      to: ["alice@example.com", "bob@example.com"],
      subject: "Weekly Report",
      body: "<h1>Report</h1><p>Data here</p>",
    });

    expect(capturedFetchUrl).toBe("https://api.resend.com/emails");
    expect(capturedFetchInit?.method).toBe("POST");

    // Check auth header
    expect(
      (capturedFetchInit?.headers as Record<string, string>)?.Authorization,
    ).toBe("Bearer re_test_123");

    // Check body
    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.from).toBe("Reports <reports@company.com>");
    expect(body.to).toEqual(["alice@example.com", "bob@example.com"]);
    expect(body.subject).toBe("Weekly Report");
    expect(body.html).toBe("<h1>Report</h1><p>Data here</p>");

    expect(result.id).toBe("email-id-123");
  });

  it("uses default from address when ATLAS_EMAIL_FROM is not set", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    delete process.env.ATLAS_EMAIL_FROM;

    installFetchMock({ status: 200, body: { id: "email-id-456" } });

    await executeEmailSend({
      to: "user@example.com",
      subject: "Test",
      body: "<p>Hello</p>",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.from).toContain("Atlas");
  });

  it("normalizes string recipient to array", async () => {
    process.env.RESEND_API_KEY = "re_test_123";

    installFetchMock({ status: 200, body: { id: "email-id-789" } });

    await executeEmailSend({
      to: "single@example.com",
      subject: "Test",
      body: "<p>Hello</p>",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.to).toEqual(["single@example.com"]);
  });

  it("throws on API error without exposing API key", async () => {
    process.env.RESEND_API_KEY = "re_secret_key_123";

    installFetchMock({
      status: 422,
      body: { message: "Invalid recipient address" },
    });

    try {
      await executeEmailSend({
        to: "user@example.com",
        subject: "Test",
        body: "<p>Hello</p>",
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("Resend API error");
      expect(message).toContain("Invalid recipient");
      // Must not contain secrets
      expect(message).not.toContain("re_secret_key_123");
    }
  });

  it("handles non-JSON error responses", async () => {
    process.env.RESEND_API_KEY = "re_test_123";

    globalThis.fetch = (async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      executeEmailSend({ to: "user@example.com", subject: "Test", body: "<p>Hi</p>" }),
    ).rejects.toThrow("HTTP 500");
  });
});

// ---------------------------------------------------------------------------
// Domain allowlist
// ---------------------------------------------------------------------------

describe("sendEmailReport — domain allowlist", () => {
  it("blocks email to disallowed domain", async () => {
    process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = "company.com,partner.com";

    const aiTool = sendEmailReport.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    const result = (await aiTool.execute(
      { to: "user@blocked.com", subject: "Test", body: "<p>Hi</p>" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as { status: string; error?: string };

    expect(result.status).toBe("error");
    expect(result.error).toContain("not allowed");
    expect(result.error).toContain("blocked.com");
  });

  it("allows email to permitted domain", async () => {
    process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = "company.com,partner.com";

    const aiTool = sendEmailReport.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    const result = (await aiTool.execute(
      { to: "alice@company.com", subject: "Test", body: "<p>Hi</p>" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as { status: string };

    expect(result.status).toBe("pending_approval");
  });

  it("allows any domain when ATLAS_EMAIL_ALLOWED_DOMAINS is not set", async () => {
    delete process.env.ATLAS_EMAIL_ALLOWED_DOMAINS;

    const aiTool = sendEmailReport.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    const result = (await aiTool.execute(
      { to: "anyone@anywhere.com", subject: "Test", body: "<p>Hi</p>" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as { status: string };

    expect(result.status).toBe("pending_approval");
  });

  it("blocks malformed email addresses without @ sign", async () => {
    process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = "company.com";

    const aiTool = sendEmailReport.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    const result = (await aiTool.execute(
      { to: "notanemail", subject: "Test", body: "<p>Hi</p>" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as { status: string; error?: string };

    expect(result.status).toBe("error");
    expect(result.error).toContain("not allowed");
  });

  it("extracts domain from display-name format addresses", async () => {
    process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = "company.com";

    const aiTool = sendEmailReport.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    const result = (await aiTool.execute(
      { to: "User <user@company.com>", subject: "Test", body: "<p>Hi</p>" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as { status: string };

    expect(result.status).toBe("pending_approval");
  });

  it("blocks mixed recipients where some are disallowed", async () => {
    process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = "company.com";

    const aiTool = sendEmailReport.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    const result = (await aiTool.execute(
      {
        to: ["good@company.com", "bad@external.com"],
        subject: "Test",
        body: "<p>Hi</p>",
      },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as { status: string; error?: string };

    expect(result.status).toBe("error");
    expect(result.error).toContain("bad@external.com");
    expect(result.error).not.toContain("good@company.com");
  });
});

// ---------------------------------------------------------------------------
// Tool execute — integration with handleAction
// ---------------------------------------------------------------------------

describe("sendEmailReport — tool execute", () => {
  it("calls handleAction with correct actionType and payload", async () => {
    delete process.env.ATLAS_EMAIL_ALLOWED_DOMAINS;

    const aiTool = sendEmailReport.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      {
        to: "user@example.com",
        subject: "Report",
        body: "<p>Data</p>",
      },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    expect(lastHandleActionCall).not.toBeNull();
    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.actionType).toBe("email:send");
    expect(request.target).toBe("user@example.com");
    expect(request.reversible).toBe(false);
    expect((request.payload as Record<string, unknown>).subject).toBe("Report");
  });
});

// ---------------------------------------------------------------------------
// Zod schema — empty recipient array
// ---------------------------------------------------------------------------

describe("sendEmailReport — schema validation", () => {
  it("rejects empty recipient array via Zod min(1)", async () => {
    delete process.env.ATLAS_EMAIL_ALLOWED_DOMAINS;

    const aiTool = sendEmailReport.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
      parameters: { parse: (input: unknown) => unknown };
    };

    expect(() => {
      aiTool.parameters.parse({
        to: [],
        subject: "Test",
        body: "<p>Hi</p>",
      });
    }).toThrow();
  });
});
