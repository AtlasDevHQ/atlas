/**
 * `sendEmailReport` against the REAL recipient gate (#4479 → #4663).
 *
 * This is the action path's first coverage against an unmocked gate **in the
 * CI-gated unit lane**. Its directory sibling `email.test.ts` mocks the gate
 * to test wiring, and `e2e/surfaces/actions.test.ts` has driven the real gate
 * on this path since #4479 — but that file is in the `core` e2e tier, which
 * CI does not run (`.github/workflows/ci.yml` runs `integration` only), so
 * nothing gating a merge covered it. (Consequence of the mock split: this
 * file must not share a process with any file that binds the gate or its
 * logger first — `email.test.ts` mocks the gate itself, and a file importing
 * the gate against the real logger makes the stub below unreachable, since
 * `createLogger` is captured at module evaluation. The isolated per-file
 * runner guarantees separate processes; a bare `bun test <dir>` would not.)
 *
 * #4663 dropped the retired env-only fallback domain list, and the failure
 * mode to fear is a removal that WIDENS the allowed recipient set. So the
 * retired knob is SET here and asserted inert: asserting the end state alone
 * would pass against the pre-#4663 code too.
 *
 * `DATABASE_URL` is cleared per test so the gate's default member resolver
 * takes its no-internal-DB branch and no unit test ever issues a live query.
 * The settings cache is separately empty — nothing here calls `loadSettings`,
 * so `getSettingOverride` always misses — which leaves the env tier as the
 * whole domain policy, i.e. the half #4663 changed as the only thing that
 * could admit a recipient. Both halves of that premise are ASSERTED below
 * rather than assumed, and asserted off state the tests establish themselves:
 * `hasInternalDB()` directly, and the gate's own inert-member-half message.
 *
 * Residual gap, stated because nothing else states it: no test anywhere
 * proves a workspace MEMBER reaches `pending` via `sendEmailReport`. That
 * needs the member half live, and while `lib/db/internal.ts` is a
 * `mock.module` seam in principle, it has ~96 exports and the rule here is
 * mock-all-exports — disproportionate for one assertion, and #4663 changed
 * only the domain half. The gate's own suite covers members-pass directly.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ActionToolResult } from "@atlas/api/lib/action-types";

let lastHandleActionCall: { request: unknown } | null = null;
let mockRequestContext: { user?: { activeOrganizationId?: string } } | undefined;

// All value exports of the real logger module — a partial mock breaks with
// "Export named X not found" the moment another import in this file's graph
// reads a missing name. Registered FIRST: anything that loads a real module
// graph before this point captures the real logger permanently.
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

// Spread the real module so ALL its exports are present (the repo's
// mock-all-exports rule): a factory listing only the two names this action
// happens to import today breaks with "Export named X not found" the moment
// the action's graph reaches a third. The factory itself stays synchronous —
// an async `mock.module` factory deadlocks under bun:test. `satisfies Pick`
// is the rename tripwire: without it, renaming an override upstream lets the
// spread supply the REAL implementation under the new name, turning a loud
// import error into a unit test that runs the approval pipeline for real.
const realHandler = await import("@atlas/api/lib/tools/actions/handler");

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  ...realHandler,
  ...({
    buildActionRequest: (params: Record<string, unknown>) => ({
      id: "test-action-id",
      ...params,
    }),
    handleAction: async (request: unknown) => {
      lastHandleActionCall = { request };
      return { status: "pending", actionId: "test-action-id", summary: "test" };
    },
  } satisfies Record<keyof Pick<typeof realHandler, "buildActionRequest" | "handleAction">, unknown>),
}));

const { EMAIL_RECIPIENT_DOMAINS_SETTING } = await import("@atlas/api/lib/email/recipient-gate");
const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
const { sendEmailReport } = await import("@atlas/api/lib/tools/actions/email");

/**
 * The env knob #4663 retired — set, never read. See the fuller note in
 * `lib/email/__tests__/recipient-gate.test.ts`: it appears nowhere in shipped
 * code, and every test occurrence is a set-and-assert-inert fixture, because a
 * removal is not verifiable unless something supplies the removed input.
 */
const RETIRED_DOMAINS_ENV = "ATLAS_EMAIL_ALLOWED_DOMAINS";

const ENV_KEYS = [EMAIL_RECIPIENT_DOMAINS_SETTING, RETIRED_DOMAINS_ENV, "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env[RETIRED_DOMAINS_ENV] = "partner.example";
  lastHandleActionCall = null;
  mockRequestContext = { user: { activeOrganizationId: "ws-action-gate-test" } };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const aiTool = sendEmailReport.tool as unknown as {
  execute: (args: unknown, options: unknown) => Promise<ActionToolResult>;
};
const opts = { toolCallId: "test-call", messages: [] };

const send = (to: string) => aiTool.execute({ to, subject: "Report", body: "<p>rows</p>" }, opts);

describe("sendEmailReport — real recipient gate, unconfigured default (#4663)", () => {
  it("blocks a recipient on the retired knob's domain, pre-approval", async () => {
    // The premise, half one: DATABASE_URL clearing actually took effect, so
    // the member half is inert and no live query was issued. Asserted off the
    // same function the gate calls, not off a log line — `hasInternalDB()`
    // reads the env per call, so this is the real predicate.
    expect(hasInternalDB()).toBe(false);

    const result = await send("outsider@partner.example");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("not allowed");
      expect(result.error).toContain("outsider@partner.example");
      // The premise, half two, from the gate's own verdict: this branch of
      // the block message is reached only when the resolved member set is
      // empty. So the block above is the domain half's decision, and the
      // retired knob contributed nothing to it.
      expect(result.error).toContain("the workspace-member allowlist is unavailable");
    }
    // Blocked pre-approval — nothing is queued for a human to approve.
    expect(lastHandleActionCall).toBeNull();
  });

  it("proceeds once that same domain IS configured on the survivor", async () => {
    // The distinguishing half of the pair: without it, a gate that blocked
    // unconditionally would satisfy the assertions above.
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example";

    const result = await send("outsider@partner.example");

    expect(result.status).toBe("pending");
    expect(lastHandleActionCall).not.toBeNull();
  });
});
