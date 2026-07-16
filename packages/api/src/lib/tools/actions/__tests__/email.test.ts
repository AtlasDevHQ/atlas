import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock handler module so we don't hit real DB / auth
// ---------------------------------------------------------------------------

let lastHandleActionCall: { request: unknown; executeFn: unknown } | null = null;

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  buildActionRequest: (params: Record<string, unknown>) => ({
    id: "test-action-id",
    ...params,
  }),
  handleAction: async (request: unknown, executeFn: unknown) => {
    lastHandleActionCall = { request, executeFn };
    return { status: "pending", actionId: "test-action-id", summary: "test" };
  },
}));

// All value exports of the real logger module — a partial mock breaks with
// "Export named X not found" the moment another import in this file's graph
// reads a missing name.
const loggerStub = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"],
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => mockRequestContext,
  redactPaths: [],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (value: unknown) => value,
  getLogger: () => loggerStub,
  createLogger: () => loggerStub,
  hashShareToken: (token: string) => token,
  setLogLevel: () => true,
}));

let mockRequestContext:
  | { user?: { activeOrganizationId?: string } }
  | undefined;

// ---------------------------------------------------------------------------
// Mock the shared recipient gate (#4479) — the gate's own behavior
// (member/domain boundary, legacy-knob fallback, fail-closed) is unit-tested
// in lib/email/__tests__/recipient-gate.test.ts; here we verify the action
// wires recipients through it and honors its verdict.
// ---------------------------------------------------------------------------

type GateResult =
  | { allowed: true }
  | { allowed: false; blocked: string[]; message: string };

let mockGateResult: GateResult = { allowed: true };
let lastGateCall: { workspaceId: string | undefined; to: readonly string[] } | null = null;

void mock.module("@atlas/api/lib/email/recipient-gate", () => ({
  EMAIL_RECIPIENT_DOMAINS_SETTING: "ATLAS_EMAIL_ALLOWED_RECIPIENT_DOMAINS",
  LEGACY_EMAIL_DOMAINS_ENV: "ATLAS_EMAIL_ALLOWED_DOMAINS",
  checkRecipientsAllowed: async (workspaceId: string | undefined, to: readonly string[]) => {
    lastGateCall = { workspaceId, to };
    return mockGateResult;
  },
  normalizeEmailAddress: (addr: string) => addr,
  resetRecipientGateWarnsForTests: () => {},
}));

// Mock the delivery module — sendEmail is now the core of executeEmailSend
let mockSendEmailResult = { success: true, provider: "resend", error: undefined as string | undefined };

void mock.module("@atlas/api/lib/email/delivery", () => ({
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
// Per-test state reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastHandleActionCall = null;
  lastSendEmailCall = null;
  mockSendEmailResult = { success: true, provider: "resend", error: undefined };
  mockGateResult = { allowed: true };
  lastGateCall = null;
  mockRequestContext = undefined;
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
// Recipient gate wiring (#4479) — the action routes recipients through the
// shared checkRecipientsAllowed gate from lib/email/recipient-gate.ts
// ---------------------------------------------------------------------------

describe("sendEmailReport — recipient gate wiring", () => {
  const aiTool = sendEmailReport.tool as unknown as {
    execute: (args: unknown, options: unknown) => Promise<unknown>;
  };
  const opts = {
    toolCallId: "test-call",
    messages: [],
    abortSignal: undefined as unknown as AbortSignal,
  };

  it("returns failed with the gate's message when the gate blocks", async () => {
    mockGateResult = {
      allowed: false,
      blocked: ["user@blocked.com"],
      message: "Recipient(s) not allowed: user@blocked.com. …",
    };

    const result = (await aiTool.execute(
      { to: "user@blocked.com", subject: "Test", body: "<p>Hi</p>" },
      opts,
    )) as { status: string; error?: string };

    expect(result.status).toBe("failed");
    expect(result.error).toContain("not allowed");
    expect(result.error).toContain("user@blocked.com");
    // Blocked pre-approval — the action pipeline is never reached
    expect(lastHandleActionCall).toBeNull();
  });

  it("proceeds to the approval pipeline when the gate allows", async () => {
    mockGateResult = { allowed: true };

    const result = (await aiTool.execute(
      { to: "alice@company.com", subject: "Test", body: "<p>Hi</p>" },
      opts,
    )) as { status: string };

    expect(result.status).toBe("pending");
  });

  it("passes all recipients and the active workspaceId to the gate", async () => {
    mockRequestContext = { user: { activeOrganizationId: "ws-123" } };

    await aiTool.execute(
      { to: ["a@corp.example", "b@corp.example"], subject: "Test", body: "<p>Hi</p>" },
      opts,
    );

    expect(lastGateCall).not.toBeNull();
    expect(lastGateCall!.workspaceId).toBe("ws-123");
    expect(lastGateCall!.to).toEqual(["a@corp.example", "b@corp.example"]);
  });

  it("passes an undefined workspaceId when there is no request context", async () => {
    mockRequestContext = undefined;

    await aiTool.execute(
      { to: "a@corp.example", subject: "Test", body: "<p>Hi</p>" },
      opts,
    );

    expect(lastGateCall!.workspaceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool execute — integration with handleAction
// ---------------------------------------------------------------------------

describe("sendEmailReport — tool execute", () => {
  it("calls handleAction with correct actionType and payload", async () => {
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
