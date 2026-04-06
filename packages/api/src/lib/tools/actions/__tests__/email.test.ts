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

// Mock the delivery module — sendEmail is now the core of executeEmailSend
let mockSendEmailResult = { success: true, provider: "resend", error: undefined as string | undefined };

mock.module("@atlas/api/lib/email/delivery", () => ({
  sendEmail: async (message: { to: string; subject: string; html: string }) => {
    lastSendEmailCall = message;
    return mockSendEmailResult;
  },
}));

let lastSendEmailCall: { to: string; subject: string; html: string } | null = null;

const { executeEmailSend, sendEmailReport } = await import(
  "@atlas/api/lib/tools/actions/email"
);

// ---------------------------------------------------------------------------
// Env snapshot
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "RESEND_API_KEY",
  "ATLAS_EMAIL_FROM",
  "ATLAS_EMAIL_ALLOWED_DOMAINS",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  lastHandleActionCall = null;
  lastSendEmailCall = null;
  mockSendEmailResult = { success: true, provider: "resend", error: undefined };
});

afterEach(() => {
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

  it("has empty requiredCredentials (credentials resolved via platform settings)", () => {
    expect(sendEmailReport.requiredCredentials).toEqual([]);
  });

  it("has a name", () => {
    expect(sendEmailReport.name).toBe("sendEmailReport");
  });

  it("has a description", () => {
    expect(sendEmailReport.description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// executeEmailSend — delegates to sendEmail()
// ---------------------------------------------------------------------------

describe("executeEmailSend", () => {
  it("delegates to sendEmail for each recipient", async () => {
    const result = await executeEmailSend({
      to: ["alice@example.com", "bob@example.com"],
      subject: "Weekly Report",
      body: "<h1>Report</h1><p>Data here</p>",
    });

    // sendEmail is called for each recipient — lastSendEmailCall is the last one
    expect(lastSendEmailCall).not.toBeNull();
    expect(lastSendEmailCall!.subject).toBe("Weekly Report");
    expect(lastSendEmailCall!.html).toBe("<h1>Report</h1><p>Data here</p>");
    expect(result.id).toBe("sent");
  });

  it("normalizes string recipient to individual calls", async () => {
    await executeEmailSend({
      to: "single@example.com",
      subject: "Test",
      body: "<p>Hello</p>",
    });

    expect(lastSendEmailCall).not.toBeNull();
    expect(lastSendEmailCall!.to).toBe("single@example.com");
  });

  it("throws when sendEmail returns failure", async () => {
    mockSendEmailResult = { success: false, provider: "log", error: "No email provider configured" };

    await expect(
      executeEmailSend({
        to: "user@example.com",
        subject: "Test",
        body: "<p>Hello</p>",
      }),
    ).rejects.toThrow("Email delivery failed");
  });

  it("includes recipient in error message on failure", async () => {
    mockSendEmailResult = { success: false, provider: "resend", error: "Resend API returned 422" };

    await expect(
      executeEmailSend({
        to: "user@example.com",
        subject: "Test",
        body: "<p>Hello</p>",
      }),
    ).rejects.toThrow("user@example.com");
  });

  it("includes delivery error detail in thrown message", async () => {
    mockSendEmailResult = { success: false, provider: "resend", error: "HTTP 500" };

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

    expect(result.status).toBe("failed");
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

    expect(result.status).toBe("failed");
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

    expect(result.status).toBe("failed");
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
