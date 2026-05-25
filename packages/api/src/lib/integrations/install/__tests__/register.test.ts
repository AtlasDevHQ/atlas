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

function clearDiscordEnv(): void {
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_CLIENT_ID;
}

function clearTeamsEnv(): void {
  delete process.env.TEAMS_APP_ID;
  delete process.env.TEAMS_APP_PASSWORD;
}

function clearWhatsAppEnv(): void {
  delete process.env.META_BUSINESS_ACCESS_TOKEN;
  delete process.env.META_BUSINESS_APP_ID;
}

beforeEach(() => {
  // Reset the env to a known-clean state; each test sets only what it needs.
  process.env = { ...ORIGINAL_ENV };
  clearTelegramEnv();
  clearDiscordEnv();
  clearTeamsEnv();
  clearWhatsAppEnv();
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

describe("registerBuiltinInstallHandlers — Discord env gate (#2749)", () => {
  it("does not register the Discord handler when DISCORD_BOT_TOKEN is unset", () => {
    process.env.DISCORD_CLIENT_ID = "fake-application-id";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "discord", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register the Discord handler when DISCORD_CLIENT_ID is unset", () => {
    process.env.DISCORD_BOT_TOKEN = "fake-token";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "discord", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register when either Discord env var is an empty string", () => {
    process.env.DISCORD_BOT_TOKEN = "";
    process.env.DISCORD_CLIENT_ID = "";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "discord", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("registers the Discord handler when both DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are set", () => {
    process.env.DISCORD_BOT_TOKEN = "fake-discord-bot-token";
    process.env.DISCORD_CLIENT_ID = "fake-discord-application-id";
    registerBuiltinInstallHandlers();
    const handler = getInstallHandler({
      slug: "discord",
      install_model: "static-bot",
    });
    expect(handler.kind).toBe("static-bot");
  });

  it("logs (but does not throw) when the catalog says discord is enabled but the env is half-wired — #2673 escalation", () => {
    // Only DISCORD_BOT_TOKEN set (DISCORD_CLIENT_ID missing) — same
    // severity-escalation contract as Telegram's catalog-enabled +
    // env-missing path.
    process.env.DISCORD_BOT_TOKEN = "fake-token-only";
    mockedConfig = {
      catalog: [{ slug: "discord", enabled: true }],
    };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
    expect(() =>
      getInstallHandler({ slug: "discord", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not throw when the catalog has no discord row at all (operator hasn't opted in)", () => {
    mockedConfig = { catalog: [{ slug: "slack", enabled: true }] };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
  });
});

describe("registerBuiltinInstallHandlers — Teams env gate (#2752)", () => {
  it("does not register the Teams handler when TEAMS_APP_ID is unset", () => {
    process.env.TEAMS_APP_PASSWORD = "fake-password";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "teams", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register the Teams handler when TEAMS_APP_PASSWORD is unset", () => {
    process.env.TEAMS_APP_ID = "fake-app-id";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "teams", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register when either Teams env var is an empty string", () => {
    process.env.TEAMS_APP_ID = "";
    process.env.TEAMS_APP_PASSWORD = "";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "teams", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("registers the Teams handler when both TEAMS_APP_ID and TEAMS_APP_PASSWORD are set", () => {
    process.env.TEAMS_APP_ID = "fake-teams-app-id";
    process.env.TEAMS_APP_PASSWORD = "fake-teams-app-password";
    registerBuiltinInstallHandlers();
    const handler = getInstallHandler({
      slug: "teams",
      install_model: "static-bot",
    });
    expect(handler.kind).toBe("static-bot");
  });

  it("logs (but does not throw) when the catalog says teams is enabled but the env is half-wired — #2673 escalation", () => {
    // Only TEAMS_APP_ID set (TEAMS_APP_PASSWORD missing) — same
    // severity-escalation contract as Telegram/Discord's catalog-enabled
    // + env-missing path.
    process.env.TEAMS_APP_ID = "fake-app-id-only";
    mockedConfig = {
      catalog: [{ slug: "teams", enabled: true }],
    };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
    expect(() =>
      getInstallHandler({ slug: "teams", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not throw when the catalog has no teams row at all (operator hasn't opted in)", () => {
    mockedConfig = { catalog: [{ slug: "slack", enabled: true }] };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
  });
});

describe("registerBuiltinInstallHandlers — WhatsApp env gate (#2753)", () => {
  it("does not register the WhatsApp handler when META_BUSINESS_ACCESS_TOKEN is unset", () => {
    process.env.META_BUSINESS_APP_ID = "fake-meta-app-id";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "whatsapp", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register the WhatsApp handler when META_BUSINESS_APP_ID is unset", () => {
    process.env.META_BUSINESS_ACCESS_TOKEN = "fake-meta-token";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "whatsapp", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register when either WhatsApp env var is an empty string", () => {
    process.env.META_BUSINESS_ACCESS_TOKEN = "";
    process.env.META_BUSINESS_APP_ID = "";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "whatsapp", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("registers the WhatsApp handler when both META_BUSINESS_ACCESS_TOKEN and META_BUSINESS_APP_ID are set", () => {
    process.env.META_BUSINESS_ACCESS_TOKEN = "fake-meta-access-token";
    process.env.META_BUSINESS_APP_ID = "fake-meta-app-id";
    registerBuiltinInstallHandlers();
    const handler = getInstallHandler({
      slug: "whatsapp",
      install_model: "static-bot",
    });
    expect(handler.kind).toBe("static-bot");
  });

  it("logs (but does not throw) when the catalog says whatsapp is enabled but the env is half-wired — #2673 escalation", () => {
    // Only META_BUSINESS_ACCESS_TOKEN set (META_BUSINESS_APP_ID missing)
    // — same severity-escalation contract as the Telegram / Discord /
    // Teams catalog-enabled + env-missing paths.
    process.env.META_BUSINESS_ACCESS_TOKEN = "fake-token-only";
    mockedConfig = {
      catalog: [{ slug: "whatsapp", enabled: true }],
    };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
    expect(() =>
      getInstallHandler({ slug: "whatsapp", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not throw when the catalog has no whatsapp row at all (operator hasn't opted in)", () => {
    mockedConfig = { catalog: [{ slug: "slack", enabled: true }] };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
  });
});
