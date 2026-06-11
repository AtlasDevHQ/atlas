/**
 * Unit tests for the scheduled-task sender preflight (#3379).
 *
 * Warn-don't-block: the preflight only produces warning strings — it never
 * throws and never gates creation. These tests pin:
 *  - email warns iff the provider chain resolves to the `log` fallback;
 *  - slack warns iff BOTH the per-team token AND SLACK_BOT_TOKEN are absent;
 *  - webhook recipients never warn;
 *  - configured deployments (SaaS, self-hosted with a provider) get NO
 *    warnings — the acceptance criterion that behavior there is unchanged;
 *  - a failing lookup degrades to "no warning", not a throw.
 *
 * Dependencies are injected via the `SenderPreflightDeps` seam (mirrors
 * `TransactionalEmailDeps` in lib/email/delivery.ts) — no module mocks, no
 * top-level env mutation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Recipient } from "@atlas/api/lib/scheduled-task-types";
import type { ResolvedEmailSender } from "@atlas/api/lib/email/delivery";
import {
  checkDeliverySenders,
  EMAIL_NO_SENDER_WARNING,
  SLACK_NO_SENDER_WARNING,
} from "../sender-preflight";

const EMAIL: Recipient = { type: "email", address: "report@example.com" };
const SLACK_NO_TEAM: Recipient = { type: "slack", channel: "#reports" };
const SLACK_TEAM: Recipient = { type: "slack", channel: "#reports", teamId: "T123" };
const WEBHOOK: Recipient = { type: "webhook", url: "https://hook.example.com" };

const resolveLog = async (): Promise<ResolvedEmailSender> => ({ kind: "log" });
const resolveResendEnv = async (): Promise<ResolvedEmailSender> => ({ kind: "resend-env" });

let savedSlackToken: string | undefined;

beforeEach(() => {
  savedSlackToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
});

afterEach(() => {
  if (savedSlackToken !== undefined) process.env.SLACK_BOT_TOKEN = savedSlackToken;
  else delete process.env.SLACK_BOT_TOKEN;
});

describe("checkDeliverySenders — email", () => {
  it("warns when the provider chain resolves to the log fallback", async () => {
    const warnings = await checkDeliverySenders([EMAIL], "org-1", {
      resolveEmailSender: resolveLog,
    });
    expect(warnings).toEqual([EMAIL_NO_SENDER_WARNING]);
    expect(warnings[0]).toContain("server log");
  });

  it("does NOT warn when a real sender resolves (configured deployment unchanged)", async () => {
    for (const kind of ["resend-env", "smtp-webhook"] as const) {
      const warnings = await checkDeliverySenders([EMAIL], "org-1", {
        resolveEmailSender: async () => ({ kind }),
      });
      expect(warnings).toEqual([]);
    }
  });

  it("threads the orgId so per-org transports are honored", async () => {
    const seen: Array<string | undefined> = [];
    await checkDeliverySenders([EMAIL], "org-42", {
      resolveEmailSender: async (orgId) => {
        seen.push(orgId);
        return { kind: "resend-env" };
      },
    });
    expect(seen).toEqual(["org-42"]);
  });

  it("degrades to no warning (not a throw) when resolution itself fails", async () => {
    const warnings = await checkDeliverySenders([EMAIL], "org-1", {
      resolveEmailSender: async () => {
        throw new Error("settings store unavailable");
      },
    });
    expect(warnings).toEqual([]);
  });
});

describe("checkDeliverySenders — slack", () => {
  it("warns when there is no teamId and no SLACK_BOT_TOKEN", async () => {
    const warnings = await checkDeliverySenders([SLACK_NO_TEAM], undefined, {
      getBotToken: async () => null,
    });
    expect(warnings).toEqual([SLACK_NO_SENDER_WARNING]);
  });

  it("warns when the per-team token is absent AND SLACK_BOT_TOKEN is unset", async () => {
    const warnings = await checkDeliverySenders([SLACK_TEAM], undefined, {
      getBotToken: async () => null,
    });
    expect(warnings).toEqual([SLACK_NO_SENDER_WARNING]);
  });

  it("does NOT warn when the per-team token exists (installed workspace)", async () => {
    const warnings = await checkDeliverySenders([SLACK_TEAM], undefined, {
      getBotToken: async (teamId) => (teamId === "T123" ? "xoxb-token" : null),
    });
    expect(warnings).toEqual([]);
  });

  it("does NOT warn when SLACK_BOT_TOKEN is set, even without a per-team token", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-env-token";
    const warnings = await checkDeliverySenders([SLACK_NO_TEAM, SLACK_TEAM], undefined, {
      getBotToken: async () => null,
    });
    expect(warnings).toEqual([]);
  });

  it("degrades to no warning (not a throw) when the token lookup fails", async () => {
    const warnings = await checkDeliverySenders([SLACK_TEAM], undefined, {
      getBotToken: async () => {
        throw new Error("internal DB unavailable");
      },
    });
    expect(warnings).toEqual([]);
  });
});

describe("checkDeliverySenders — webhook + shape", () => {
  it("never warns for webhook recipients", async () => {
    const warnings = await checkDeliverySenders([WEBHOOK], "org-1", {
      resolveEmailSender: resolveLog,
      getBotToken: async () => null,
    });
    expect(warnings).toEqual([]);
  });

  it("returns an empty array for an empty recipient list", async () => {
    const warnings = await checkDeliverySenders([], "org-1", {
      resolveEmailSender: resolveLog,
    });
    expect(warnings).toEqual([]);
  });

  it("emits one warning per misconfigured channel (email + slack together)", async () => {
    const warnings = await checkDeliverySenders([EMAIL, SLACK_TEAM], "org-1", {
      resolveEmailSender: resolveLog,
      getBotToken: async () => null,
    });
    expect(warnings).toEqual([EMAIL_NO_SENDER_WARNING, SLACK_NO_SENDER_WARNING]);
  });

  it("emits NO warnings on a fully configured deployment (SaaS parity)", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-env-token";
    const warnings = await checkDeliverySenders([EMAIL, SLACK_TEAM, WEBHOOK], "org-1", {
      resolveEmailSender: resolveResendEnv,
    });
    expect(warnings).toEqual([]);
  });
});
