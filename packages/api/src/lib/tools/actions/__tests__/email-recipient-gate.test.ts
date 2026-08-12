/**
 * `sendEmailReport` against the REAL recipient gate (#4479 → #4663).
 *
 * This is the action path's first coverage against an unmocked gate — its
 * sibling `email.test.ts` mocks the gate to test wiring, so before this file
 * the acceptance criterion "members-only on BOTH agent email paths" was
 * provable on this path only by composition. (Consequence of that split: the
 * two files must never share a process, since the sibling's `mock.module`
 * of the gate is global. The isolated per-file runner guarantees they don't;
 * a bare `bun test <dir>` would not.)
 *
 * #4663 dropped the retired env-only fallback domain list, and the failure
 * mode to fear is a removal that WIDENS the allowed recipient set. So the
 * retired knob is SET here and asserted inert: asserting the end state alone
 * would pass against the pre-#4663 code too.
 *
 * `DATABASE_URL` is cleared per test, which does two things: the gate's
 * default member resolver takes its no-internal-DB branch (so no unit test
 * ever issues a live query), and the settings cache is empty. With the
 * survivor env var also unset the gate therefore has no domain source at
 * all — leaving the domain half, the half #4663 changed, as the only thing
 * that could admit a recipient. That premise is asserted rather than
 * assumed, via the gate's own no-internal-DB warn.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ActionToolResult } from "@atlas/api/lib/action-types";

let lastHandleActionCall: { request: unknown } | null = null;

// Spread the real module so ALL its exports are present (the repo's
// mock-all-exports rule): a factory listing only the two names this action
// happens to import today breaks with "Export named X not found" the moment
// the action's graph reaches a third. The factory itself stays synchronous —
// an async `mock.module` factory deadlocks under bun:test.
const realHandler = await import("@atlas/api/lib/tools/actions/handler");

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  ...realHandler,
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

const warnMessages: string[] = [];
const loggerStub = {
  info: () => {},
  warn: (ctx: unknown, msg?: unknown) => {
    warnMessages.push(typeof msg === "string" ? msg : String(ctx));
  },
  error: () => {},
  debug: () => {},
};

// All value exports of the real logger module — a partial mock breaks with
// "Export named X not found" the moment another import in this file's graph
// reads a missing name.
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

/** See `lib/email/__tests__/recipient-gate.test.ts` — set, never read. */
const RETIRED_DOMAINS_ENV = "ATLAS_EMAIL_ALLOWED_DOMAINS";

const ENV_KEYS = [EMAIL_RECIPIENT_DOMAINS_SETTING, RETIRED_DOMAINS_ENV, "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

const noMemberDbWarns = () => warnMessages.filter((m) => m.includes("no internal DB"));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env[RETIRED_DOMAINS_ENV] = "partner.example";
  lastHandleActionCall = null;
  warnMessages.length = 0;
  mockRequestContext = { user: { activeOrganizationId: "ws-action-gate-test" } };
  // This file trips the gate's no-internal-DB warn latch, and the first test
  // asserts on it — so re-arm it rather than depending on execution order.
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
const opts = { toolCallId: "test-call", messages: [] };

const send = (to: string) =>
  aiTool.execute({ to, subject: "Report", body: "<p>rows</p>" }, opts) as Promise<ActionToolResult>;

describe("sendEmailReport — real recipient gate, unconfigured default (#4663)", () => {
  it("blocks a recipient on the retired knob's domain, pre-approval", async () => {
    const result = await send("outsider@partner.example");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("not allowed");
      expect(result.error).toContain("outsider@partner.example");
    }
    // Blocked pre-approval — nothing is queued for a human to approve.
    expect(lastHandleActionCall).toBeNull();
    // The premise, asserted: the member half really was inert, so the block
    // above is the domain half's verdict and not a swallowed query error.
    expect(noMemberDbWarns()).toHaveLength(1);
  });

  it("proceeds once that same domain IS configured on the survivor", async () => {
    // The distinguishing half of the pair: without it, a gate that blocked
    // unconditionally would satisfy the assertion above.
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example";

    const result = await send("outsider@partner.example");

    expect(result.status).toBe("pending");
    expect(lastHandleActionCall).not.toBeNull();
  });
});
