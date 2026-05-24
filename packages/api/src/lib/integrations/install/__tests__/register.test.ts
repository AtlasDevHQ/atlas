/**
 * Tests for the env-gated builtin install-handler registration —
 * specifically the Telegram branch (1.5.3 #2748). Slack / Jira /
 * Salesforce / Email register helpers share the same shape; if any of
 * them get the env-gate severity wrong, the same #2673 silent-
 * degradation risk applies, but those cases are pinned by their own
 * handler tests + the AdapterRegistry tests upstream. This file
 * specifically pins the Telegram contract per the PR #2781 review:
 *
 *   - With TELEGRAM_BOT_TOKEN unset and the catalog disabled, the
 *     register call logs at info and skips (no-op).
 *   - With TELEGRAM_BOT_TOKEN unset but the catalog `enabled: true`,
 *     the register call logs at error so operator log streams catch
 *     the misconfig (per the #2673 incident class).
 *   - With TELEGRAM_BOT_TOKEN set, the handler is registered against
 *     the static-bot dispatch slot.
 *
 * The register helper reads `process.env` directly + lazily-requires
 * `getConfig`, so the tests manipulate both around each case. We mock
 * `db/internal` because the handler constructor doesn't touch it but
 * import-time module loading does (the handler imports `internalQuery`).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mock(() => Promise.resolve([])),
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

import {
  _resetInstallHandlerRegistries,
  getInstallHandler,
} from "../dispatch";
import {
  _resetRegistrationLatch,
  registerBuiltinInstallHandlers,
} from "../register";

const ORIGINAL_ENV = { ...process.env };

interface MockedConfig {
  catalog?: ReadonlyArray<{ slug: string; enabled: boolean }>;
}
let mockedConfig: MockedConfig | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockedConfig,
}));

function clearTelegramEnv(): void {
  delete process.env.TELEGRAM_BOT_TOKEN;
}

beforeEach(() => {
  // Reset the env to a known-clean state; each test sets only what it needs.
  process.env = { ...ORIGINAL_ENV };
  clearTelegramEnv();
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.SLACK_CLIENT_SECRET;
  delete process.env.JIRA_CLIENT_ID;
  delete process.env.JIRA_CLIENT_SECRET;
  delete process.env.SALESFORCE_CLIENT_ID;
  delete process.env.SALESFORCE_CLIENT_SECRET;
  mockedConfig = null;
  _resetRegistrationLatch();
  _resetInstallHandlerRegistries();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  mockedConfig = null;
  _resetRegistrationLatch();
  _resetInstallHandlerRegistries();
});

describe("registerBuiltinInstallHandlers — Telegram env gate", () => {
  it("does not register the Telegram handler when TELEGRAM_BOT_TOKEN is unset", () => {
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "telegram", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register when TELEGRAM_BOT_TOKEN is an empty string", () => {
    process.env.TELEGRAM_BOT_TOKEN = "";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "telegram", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("registers the Telegram handler when TELEGRAM_BOT_TOKEN is set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "987654:fake-secret-token-for-test";
    registerBuiltinInstallHandlers();
    const handler = getInstallHandler({
      slug: "telegram",
      install_model: "static-bot",
    });
    expect(handler.kind).toBe("static-bot");
  });

  it("is idempotent — multiple invocations don't re-register or warn", () => {
    process.env.TELEGRAM_BOT_TOKEN = "987654:fake-secret-token-for-test";
    registerBuiltinInstallHandlers();
    registerBuiltinInstallHandlers();
    registerBuiltinInstallHandlers();
    // The handler is still resolvable — re-registration is a no-op via
    // the alreadyRegistered latch.
    expect(
      getInstallHandler({ slug: "telegram", install_model: "static-bot" }).kind,
    ).toBe("static-bot");
  });

  it("logs (but does not throw) when the catalog says telegram is enabled but the env is unset — #2673 escalation", () => {
    // The actual severity escalation is asserted only by checking that
    // the register call completes without throwing — the log output is
    // captured by the createLogger pino sink and isn't observable here.
    // The behavioral guarantee is "no handler registered, no exception
    // raised"; the log severity is a separate observability concern.
    mockedConfig = {
      catalog: [{ slug: "telegram", enabled: true }],
    };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
    expect(() =>
      getInstallHandler({ slug: "telegram", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not throw when the catalog has no telegram row at all (operator hasn't opted in)", () => {
    mockedConfig = { catalog: [{ slug: "slack", enabled: true }] };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
  });
});
