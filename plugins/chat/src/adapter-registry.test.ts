/**
 * Tests for `buildChatAdapterRegistry` — slice 2 of #2649 (issue #2650).
 *
 * Asserted invariants (AC quoted from #2650):
 *
 *   - Chat plugin instantiates Slack adapter only when catalog entry
 *     exists with install_model='oauth' AND enabled=true AND env vars
 *     SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET /
 *     SLACK_ENCRYPTION_KEY are all present
 *   - Non-Slack chat adapters are NOT instantiated at boot in this
 *     milestone (verified by code grep + test)
 *   - AdapterRegistry unit-tested: env-var fixtures → correct adapter
 *     set; missing creds → adapter not registered + warn logged;
 *     non-OAuth catalog entries → adapter not registered
 */

import { describe, it, expect } from "bun:test";
import {
  buildChatAdapterRegistry,
  type ChatCatalogEntry,
  type RegistryLogger,
} from "./adapter-registry";

const SLACK_FULL_ENV: NodeJS.ProcessEnv = {
  SLACK_CLIENT_ID: "test-client-id",
  SLACK_CLIENT_SECRET: "test-client-secret",
  SLACK_SIGNING_SECRET: "abcdef0123456789abcdef0123456789",
  // 64-char hex = 32 raw bytes; the chat-adapter's `decodeKey` accepts
  // hex64 or base64-44. `f` is a valid hex char; `x` would fail decode.
  SLACK_ENCRYPTION_KEY: "f".repeat(64),
};

function makeLogger(): {
  logger: RegistryLogger;
  infos: Array<{ payload: Record<string, unknown>; msg: string }>;
  warns: Array<{ payload: Record<string, unknown>; msg: string }>;
  debugs: Array<{ payload: Record<string, unknown>; msg: string }>;
} {
  const infos: Array<{ payload: Record<string, unknown>; msg: string }> = [];
  const warns: Array<{ payload: Record<string, unknown>; msg: string }> = [];
  const debugs: Array<{ payload: Record<string, unknown>; msg: string }> = [];
  return {
    infos,
    warns,
    debugs,
    logger: {
      info: (payload, msg) => infos.push({ payload, msg }),
      warn: (payload, msg) => warns.push({ payload, msg }),
      debug: (payload, msg) => debugs.push({ payload, msg }),
    },
  };
}

function entry(partial: Partial<ChatCatalogEntry> & Pick<ChatCatalogEntry, "slug">): ChatCatalogEntry {
  return {
    type: "chat",
    install_model: "oauth",
    enabled: true,
    saas_eligible: true,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Happy path: Slack OAuth + full env → adapter registered
// ---------------------------------------------------------------------------

describe("buildChatAdapterRegistry — happy path", () => {
  it("registers Slack when catalog has slack OAuth + enabled AND all env vars present", () => {
    const { logger, infos } = makeLogger();
    const result = buildChatAdapterRegistry({
      catalog: [entry({ slug: "slack" })],
      env: SLACK_FULL_ENV,
      logger,
    });
    expect(result.adapters.slack).toBeDefined();
    expect(infos.some((l) => l.msg.includes("chat adapter registered"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing-env-var matrix — every required var skipped in isolation
// ---------------------------------------------------------------------------

describe("buildChatAdapterRegistry — missing env vars", () => {
  const required = [
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "SLACK_ENCRYPTION_KEY",
  ] as const;

  for (const missing of required) {
    it(`skips Slack + logs warn when ${missing} is missing`, () => {
      const { logger, warns } = makeLogger();
      const env: NodeJS.ProcessEnv = { ...SLACK_FULL_ENV };
      delete env[missing];

      const result = buildChatAdapterRegistry({
        catalog: [entry({ slug: "slack" })],
        env,
        logger,
      });
      expect(result.adapters.slack).toBeUndefined();
      expect(warns).toHaveLength(1);
      expect(warns[0]?.msg).toContain("required env vars missing");
      expect((warns[0]?.payload.requiredEnv as string[]).includes(missing)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Catalog gating: enabled / install_model / type
// ---------------------------------------------------------------------------

describe("buildChatAdapterRegistry — catalog filters", () => {
  it("does not register Slack when catalog entry is disabled", () => {
    const { logger, debugs } = makeLogger();
    const result = buildChatAdapterRegistry({
      catalog: [entry({ slug: "slack", enabled: false })],
      env: SLACK_FULL_ENV,
      logger,
    });
    expect(result.adapters.slack).toBeUndefined();
    expect(debugs.some((l) => l.msg.includes("enabled=false"))).toBe(true);
  });

  it("does not register Slack when install_model is form (skipped, no instantiation)", () => {
    const { logger, debugs } = makeLogger();
    const result = buildChatAdapterRegistry({
      catalog: [entry({ slug: "slack", install_model: "form" })],
      env: SLACK_FULL_ENV,
      logger,
    });
    expect(result.adapters.slack).toBeUndefined();
    expect(debugs.some((l) => l.msg.includes("non-OAuth install model"))).toBe(true);
  });

  it("does not register a static-bot chat platform — defer to 1.5.3", () => {
    // Pins the milestone scope: Teams/Discord/gchat/Telegram/WhatsApp
    // are seeded with install_model='static-bot' enabled=false; even
    // an accidentally-enabled static-bot row never instantiates an
    // adapter in 1.5.2.
    const { logger, debugs } = makeLogger();
    const result = buildChatAdapterRegistry({
      catalog: [
        entry({ slug: "telegram", install_model: "static-bot", enabled: true }),
        entry({ slug: "discord", install_model: "static-bot", enabled: true }),
      ],
      env: {
        ...SLACK_FULL_ENV,
        TELEGRAM_BOT_TOKEN: "1234:fake-telegram-token-for-test",
        DISCORD_BOT_TOKEN: "fake-discord-token",
        DISCORD_APPLICATION_ID: "fake",
        DISCORD_PUBLIC_KEY: "fake",
      },
      logger,
    });
    expect(result.adapters.slack).toBeUndefined();
    expect(
      debugs.filter((l) => l.msg.includes("non-OAuth install model")),
    ).toHaveLength(2);
  });

  it("ignores integration-type entries (slice 3 will own them)", () => {
    const { logger } = makeLogger();
    const result = buildChatAdapterRegistry({
      catalog: [
        entry({
          slug: "salesforce",
          type: "integration",
          install_model: "oauth",
        }),
        entry({ slug: "email", type: "integration", install_model: "form" }),
      ],
      env: SLACK_FULL_ENV,
      logger,
    });
    expect(result.adapters.slack).toBeUndefined();
  });

  it("warns on a chat-type OAuth entry whose slug has no builder (operator typo)", () => {
    const { logger, warns } = makeLogger();
    const result = buildChatAdapterRegistry({
      catalog: [entry({ slug: "slcak" })], // typo
      env: SLACK_FULL_ENV,
      logger,
    });
    expect(result.adapters.slack).toBeUndefined();
    expect(warns.some((l) => l.msg.includes("no builder registered"))).toBe(true);
  });

  it("returns empty registry when catalog is empty", () => {
    const result = buildChatAdapterRegistry({ catalog: [], env: SLACK_FULL_ENV });
    expect(result.adapters.slack).toBeUndefined();
  });

  it("returns empty registry when env is empty", () => {
    const result = buildChatAdapterRegistry({
      catalog: [entry({ slug: "slack" })],
      env: {},
    });
    expect(result.adapters.slack).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — surfaces enough info for healthCheck / install-route 500s
// ---------------------------------------------------------------------------

describe("buildChatAdapterRegistry — diagnostics", () => {
  it("reports missingCredSlugs when env vars are missing", () => {
    const result = buildChatAdapterRegistry({
      catalog: [entry({ slug: "slack" })],
      env: {},
    });
    expect(result.diagnostics.missingCredSlugs).toEqual(["slack"]);
    expect(result.diagnostics.unrecognizedSlugs).toEqual([]);
  });

  it("reports unrecognizedSlugs when no builder is registered for the slug", () => {
    const result = buildChatAdapterRegistry({
      catalog: [entry({ slug: "slcak" })],
      env: SLACK_FULL_ENV,
    });
    expect(result.diagnostics.unrecognizedSlugs).toEqual(["slcak"]);
    expect(result.diagnostics.missingCredSlugs).toEqual([]);
  });

  it("reports both lists when the catalog mixes the two failure modes", () => {
    const result = buildChatAdapterRegistry({
      catalog: [
        entry({ slug: "slack" }), // missing env
        entry({ slug: "unknown-slug" }), // no builder
      ],
      env: {},
    });
    expect(result.diagnostics.missingCredSlugs).toEqual(["slack"]);
    expect(result.diagnostics.unrecognizedSlugs).toEqual(["unknown-slug"]);
  });

  it("does not list disabled / non-OAuth / non-chat entries (they're not failures)", () => {
    const result = buildChatAdapterRegistry({
      catalog: [
        entry({ slug: "slack", enabled: false }),
        entry({ slug: "telegram", install_model: "static-bot" }),
        entry({ slug: "salesforce", type: "integration", install_model: "oauth" }),
      ],
      env: {},
    });
    expect(result.diagnostics.missingCredSlugs).toEqual([]);
    expect(result.diagnostics.unrecognizedSlugs).toEqual([]);
  });
});
