/**
 * Deprecation-warn behavior of the recipient gate (#4479 → #4663).
 *
 * Split from `recipient-gate.test.ts` because observing the warn needs a
 * logger `mock.module()`, and that file deliberately runs against real
 * modules. Asserts the operator-facing contract phase 2 depends on: the
 * legacy-knob warns fire exactly once per process (and the test seam
 * re-arms them).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

const warnMessages: string[] = [];
const loggerStub = {
  info: () => {},
  warn: (_ctx: unknown, msg?: unknown) => {
    warnMessages.push(typeof msg === "string" ? msg : String(_ctx));
  },
  error: () => {},
  debug: () => {},
};

void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"],
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (value: unknown) => value,
  getLogger: () => loggerStub,
  createLogger: () => loggerStub,
  hashShareToken: (token: string) => token,
  setLogLevel: () => true,
}));

const {
  checkRecipientsAllowed,
  resetRecipientGateWarnsForTests,
  EMAIL_RECIPIENT_DOMAINS_SETTING,
  LEGACY_EMAIL_DOMAINS_ENV,
} = await import("@atlas/api/lib/email/recipient-gate");

const WSID = "ws-recipient-gate-warn-test";
const ENV_KEYS = [EMAIL_RECIPIENT_DOMAINS_SETTING, LEGACY_EMAIL_DOMAINS_ENV] as const;
const saved: Record<string, string | undefined> = {};

const noMembers = async () => [] as string[];
const deprecationWarns = () => warnMessages.filter((m) => m.includes("is deprecated"));
const ignoredWarns = () => warnMessages.filter((m) => m.includes("ignored"));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  warnMessages.length = 0;
  resetRecipientGateWarnsForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("recipient gate deprecation warns (#4479)", () => {
  it("warns exactly once per process when the legacy fallback is used", async () => {
    process.env[LEGACY_EMAIL_DOMAINS_ENV] = "legacy.example";

    await checkRecipientsAllowed(WSID, ["a@legacy.example"], noMembers);
    await checkRecipientsAllowed(WSID, ["b@legacy.example"], noMembers);

    expect(deprecationWarns()).toHaveLength(1);
    expect(deprecationWarns()[0]).toContain(LEGACY_EMAIL_DOMAINS_ENV);
    expect(deprecationWarns()[0]).toContain("#4663");
  });

  it("re-arms via the test seam", async () => {
    process.env[LEGACY_EMAIL_DOMAINS_ENV] = "legacy.example";

    await checkRecipientsAllowed(WSID, ["a@legacy.example"], noMembers);
    resetRecipientGateWarnsForTests();
    await checkRecipientsAllowed(WSID, ["a@legacy.example"], noMembers);

    expect(deprecationWarns()).toHaveLength(2);
  });

  it("warns once that the legacy knob is ignored when both knobs are set", async () => {
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example";
    process.env[LEGACY_EMAIL_DOMAINS_ENV] = "legacy.example";

    await checkRecipientsAllowed(WSID, ["a@partner.example"], noMembers);
    await checkRecipientsAllowed(WSID, ["b@partner.example"], noMembers);

    expect(ignoredWarns()).toHaveLength(1);
    expect(deprecationWarns()).toHaveLength(0);
  });

  it("does not warn when only the surviving setting is configured", async () => {
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example";

    await checkRecipientsAllowed(WSID, ["a@partner.example"], noMembers);

    expect(warnMessages).toHaveLength(0);
  });
});
