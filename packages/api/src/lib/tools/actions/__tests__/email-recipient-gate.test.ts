/**
 * `sendEmailReport` against the REAL recipient gate (#4479 → #4663).
 *
 * `email.test.ts` mocks the gate to test wiring; this file deliberately does
 * not, so the action path's end state is pinned by behavior rather than by
 * composition. #4663 dropped the retired env-only fallback domain list, and
 * the failure mode to fear is a removal that WIDENS the allowed recipient
 * set — so the claim under test is the unconfigured default: with
 * `ATLAS_EMAIL_ALLOWED_RECIPIENT_DOMAINS` unset there is no domain source at
 * all, and the action blocks pre-approval.
 *
 * `DATABASE_URL` is cleared per test so the gate's default member resolver
 * takes its no-internal-DB branch (member half inert, no live query from a
 * unit test). That leaves the domain half as the only thing that can admit a
 * recipient, which is exactly the half this issue changed.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

let lastHandleActionCall: { request: unknown } | null = null;

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  buildActionRequest: (params: Record<string, unknown>) => ({
    id: "test-action-id",
    ...params,
  }),
  handleAction: async (request: unknown) => {
    lastHandleActionCall = { request };
    return { status: "pending", actionId: "test-action-id", summary: "test" };
  },
}));

let mockRequestContext: { user?: { activeOrganizationId?: string } } | undefined;

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

const { EMAIL_RECIPIENT_DOMAINS_SETTING, resetRecipientGateWarnsForTests } = await import(
  "@atlas/api/lib/email/recipient-gate"
);
const { sendEmailReport } = await import("@atlas/api/lib/tools/actions/email");

const ENV_KEYS = [EMAIL_RECIPIENT_DOMAINS_SETTING, "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  lastHandleActionCall = null;
  mockRequestContext = { user: { activeOrganizationId: "ws-action-gate-test" } };
  // This file DOES trip the no-internal-DB warn latch; re-arm it so the
  // tests don't depend on execution order.
  resetRecipientGateWarnsForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const aiTool = sendEmailReport.tool as unknown as {
  execute: (args: unknown, options: unknown) => Promise<unknown>;
};
const opts = {
  toolCallId: "test-call",
  messages: [],
  abortSignal: undefined as unknown as AbortSignal,
};

const send = (to: string) =>
  aiTool.execute({ to, subject: "Report", body: "<p>rows</p>" }, opts) as Promise<{
    status: string;
    error?: string;
  }>;

describe("sendEmailReport — real recipient gate, no domain configuration (#4663)", () => {
  it("blocks a recipient and never reaches the approval pipeline", async () => {
    const result = await send("outsider@partner.example");

    expect(result.status).toBe("failed");
    expect(result.error).toContain("not allowed");
    expect(result.error).toContain("outsider@partner.example");
    // Blocked pre-approval — nothing is queued for a human to approve.
    expect(lastHandleActionCall).toBeNull();
  });

  it("proceeds once that same domain IS configured", async () => {
    // The distinguishing half of the pair: without it, a gate that blocked
    // unconditionally would satisfy the assertion above.
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example";

    const result = await send("outsider@partner.example");

    expect(result.status).toBe("pending");
    expect(lastHandleActionCall).not.toBeNull();
  });
});
