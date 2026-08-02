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

void mock.module("@atlas/api/lib/db/internal", () => ({
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
import {
  _resetKnowledgeSyncConnectors,
  getKnowledgeSyncConnector,
} from "@atlas/api/lib/knowledge/connectors";
import { CONFLUENCE_CATALOG_ID } from "@atlas/api/lib/knowledge/confluence/config";
import { CONFLUENCE_DC_CATALOG_ID } from "@atlas/api/lib/knowledge/confluence/config-datacenter";
import { NOTION_KNOWLEDGE_CATALOG_ID } from "@atlas/api/lib/knowledge/notion/connector";
import { GITBOOK_CATALOG_ID } from "@atlas/api/lib/knowledge/gitbook/config";
import { ZENDESK_CATALOG_ID } from "@atlas/api/lib/knowledge/zendesk/config";
import { SALESFORCE_KNOWLEDGE_CATALOG_ID } from "@atlas/api/lib/knowledge/salesforce/config";
import { INTERCOM_CATALOG_ID } from "@atlas/api/lib/knowledge/intercom/config";
import { FRONT_CATALOG_ID } from "@atlas/api/lib/knowledge/front/config";
import { HELPSCOUT_CATALOG_ID } from "@atlas/api/lib/knowledge/helpscout/config";
import { FRESHDESK_CATALOG_ID } from "@atlas/api/lib/knowledge/freshdesk/config";
import {
  _resetBrainSourceConnectors,
  getBrainSourceConnector,
} from "@atlas/api/lib/brain/ingest/types";
import {
  ZERO_REVERIFY,
  listAudienceReverifierSources,
  registerAudienceReverifier,
} from "@atlas/api/lib/brain/audience/reverify";
import { SLACK_HISTORY_CATALOG_ID } from "@atlas/api/lib/brain/ingest/slack/config";
import {
  ZOOM_TRANSCRIPTS_CATALOG_ID,
  ZOOM_TRANSCRIPT_SOURCE,
} from "@atlas/api/lib/brain/ingest/zoom/config";
import {
  OUTLOOK_MAIL_CATALOG_ID,
  OUTLOOK_MAIL_SOURCE,
} from "@atlas/api/lib/brain/ingest/outlook/config";

const ORIGINAL_ENV = { ...process.env };

interface MockedConfig {
  catalog?: ReadonlyArray<{ slug: string; enabled: boolean }>;
}
let mockedConfig: MockedConfig | null = null;

void mock.module("@atlas/api/lib/config", () => ({
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

function clearGchatEnv(): void {
  delete process.env.GCHAT_SERVICE_ACCOUNT_JSON;
  delete process.env.GCHAT_PUBSUB_TOPIC;
}

const FAKE_GCHAT_SA_JSON = JSON.stringify({
  client_email: "atlas-sa@atlas-test.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nfake-test-key-not-used-at-registration\n-----END PRIVATE KEY-----\n",
  project_id: "atlas-test",
});
const FAKE_GCHAT_PUBSUB_TOPIC = "projects/atlas-test/topics/gchat-events";


beforeEach(() => {
  // Reset the env to a known-clean state; each test sets only what it needs.
  process.env = { ...ORIGINAL_ENV };
  clearTelegramEnv();
  clearDiscordEnv();
  clearTeamsEnv();
  clearWhatsAppEnv();
  clearGchatEnv();
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.SLACK_CLIENT_SECRET;
  delete process.env.JIRA_CLIENT_ID;
  delete process.env.JIRA_CLIENT_SECRET;
  delete process.env.SALESFORCE_CLIENT_ID;
  delete process.env.SALESFORCE_CLIENT_SECRET;
  mockedConfig = null;
  _resetRegistrationLatch();
  _resetInstallHandlerRegistries();
  _resetKnowledgeSyncConnectors();
  // Brain sources dispatch through their own registry, and #4971 added a second
  // one beside it for audience re-verifiers. Both are process-global and neither
  // was reset here, so a suite that registers them leaked into the next file's
  // view of "what is registered". `_resetBrainSourceConnectors` clears both.
  _resetBrainSourceConnectors();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  mockedConfig = null;
  _resetRegistrationLatch();
  _resetInstallHandlerRegistries();
  _resetKnowledgeSyncConnectors();
  // Brain sources dispatch through their own registry, and #4971 added a second
  // one beside it for audience re-verifiers. Both are process-global and neither
  // was reset here, so a suite that registers them leaked into the next file's
  // view of "what is registered". `_resetBrainSourceConnectors` clears both.
  _resetBrainSourceConnectors();
});

describe("registerBuiltinInstallHandlers — SQL plugin datasources (#3300)", () => {
  // ClickHouse / Snowflake / BigQuery register the generic
  // DatasourceFormInstallHandler with no env gate — the customer admin supplies
  // credentials at install, same as every other form handler. So they're
  // resolvable as a `form` handler immediately after registration.
  for (const slug of ["clickhouse", "snowflake", "bigquery"] as const) {
    it(`registers a form handler for ${slug} with no env gate`, () => {
      registerBuiltinInstallHandlers();
      const handler = getInstallHandler({ slug, install_model: "form" });
      expect(handler.kind).toBe("form");
    });
  }

  it("registers all three independently of any chat-platform env wiring", () => {
    // No DATASOURCE-specific env vars exist; registration must not depend on the
    // chat-platform gates (which are all cleared in beforeEach).
    registerBuiltinInstallHandlers();
    expect(getInstallHandler({ slug: "clickhouse", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "snowflake", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "bigquery", install_model: "form" }).kind).toBe("form");
  });
});

describe("registerBuiltinInstallHandlers — knowledge sync connector pairing (#4377/#4378/#4393)", () => {
  // register.ts documents the FORM handler + CONNECTOR pairing as load-bearing:
  // dropping a registerXxxKnowledgeConnector() call would ship green while every
  // install of that vendor 500s at sync time (connector_unavailable — the cycle
  // walk dispatches on the connector registry, not the form handler). Pin that
  // one call to registerBuiltinInstallHandlers() registers every vendor's
  // connector alongside its form handler. No env gate on any.
  it("registers the Confluence, Confluence DC, Notion, GitBook, Zendesk, Salesforce Knowledge, Intercom, Front, Help Scout, and Freshdesk sync connectors alongside their form handlers", () => {
    registerBuiltinInstallHandlers();
    expect(getKnowledgeSyncConnector(CONFLUENCE_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(CONFLUENCE_DC_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(NOTION_KNOWLEDGE_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(GITBOOK_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(ZENDESK_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(SALESFORCE_KNOWLEDGE_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(INTERCOM_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(FRONT_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(HELPSCOUT_CATALOG_ID)).toBeDefined();
    expect(getKnowledgeSyncConnector(FRESHDESK_CATALOG_ID)).toBeDefined();
    expect(getInstallHandler({ slug: "confluence", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "confluence-datacenter", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "notion-knowledge", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "gitbook", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "zendesk", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "salesforce-knowledge", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "intercom", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "front", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "helpscout", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "freshdesk", install_model: "form" }).kind).toBe("form");
  });
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

describe("registerBuiltinInstallHandlers — Google Chat env gate (#2754)", () => {
  it("does not register the Google Chat handler when GCHAT_SERVICE_ACCOUNT_JSON is unset", () => {
    process.env.GCHAT_PUBSUB_TOPIC = FAKE_GCHAT_PUBSUB_TOPIC;
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "gchat", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register the Google Chat handler when GCHAT_PUBSUB_TOPIC is unset", () => {
    process.env.GCHAT_SERVICE_ACCOUNT_JSON = FAKE_GCHAT_SA_JSON;
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "gchat", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register when either Google Chat env var is an empty string", () => {
    process.env.GCHAT_SERVICE_ACCOUNT_JSON = "";
    process.env.GCHAT_PUBSUB_TOPIC = "";
    registerBuiltinInstallHandlers();
    expect(() =>
      getInstallHandler({ slug: "gchat", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register when GCHAT_SERVICE_ACCOUNT_JSON is malformed JSON — fails loudly at boot", () => {
    process.env.GCHAT_SERVICE_ACCOUNT_JSON = "not-a-json-blob";
    process.env.GCHAT_PUBSUB_TOPIC = FAKE_GCHAT_PUBSUB_TOPIC;
    // The handler's parser throws; register catches + logs at error and
    // skips. From the dispatch's perspective, nothing was registered.
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
    expect(() =>
      getInstallHandler({ slug: "gchat", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not register when GCHAT_PUBSUB_TOPIC is a bare topic name (not a fully-qualified path)", () => {
    process.env.GCHAT_SERVICE_ACCOUNT_JSON = FAKE_GCHAT_SA_JSON;
    process.env.GCHAT_PUBSUB_TOPIC = "just-the-topic";
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
    expect(() =>
      getInstallHandler({ slug: "gchat", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("registers the Google Chat handler when both GCHAT_SERVICE_ACCOUNT_JSON and GCHAT_PUBSUB_TOPIC are valid", () => {
    process.env.GCHAT_SERVICE_ACCOUNT_JSON = FAKE_GCHAT_SA_JSON;
    process.env.GCHAT_PUBSUB_TOPIC = FAKE_GCHAT_PUBSUB_TOPIC;
    registerBuiltinInstallHandlers();
    const handler = getInstallHandler({
      slug: "gchat",
      install_model: "static-bot",
    });
    expect(handler.kind).toBe("static-bot");
  });

  it("logs (but does not throw) when the catalog says gchat is enabled but the env is half-wired — #2673 escalation", () => {
    process.env.GCHAT_SERVICE_ACCOUNT_JSON = FAKE_GCHAT_SA_JSON;
    // GCHAT_PUBSUB_TOPIC missing — operator opted in via catalog but
    // half-wired the env. Same severity-escalation contract as the
    // other Phase D platforms.
    mockedConfig = {
      catalog: [{ slug: "gchat", enabled: true }],
    };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
    expect(() =>
      getInstallHandler({ slug: "gchat", install_model: "static-bot" }),
    ).toThrow(/No static-bot install handler registered/);
  });

  it("does not throw when the catalog has no gchat row at all (operator hasn't opted in)", () => {
    mockedConfig = { catalog: [{ slug: "slack", enabled: true }] };
    expect(() => registerBuiltinInstallHandlers()).not.toThrow();
  });
});

describe("registerBuiltinInstallHandlers — BRAIN source connector pairing (#4963/#4965/#4966/#4971)", () => {
  // The sibling block above pins the KNOWLEDGE connector pairing and would never
  // have covered these: brain sources dispatch through a DIFFERENT registry
  // (`getBrainSourceConnector`), so adding the two new slugs to that test would
  // have asserted nothing. That is why M3 tripled the brain-source surface
  // (1 → 3) with this enumeration left untouched and still green.
  //
  // There is also a THIRD registry now. `register{Zoom,Outlook}Connector` writes
  // the connector AND its audience re-verifier in one call, and `register.ts`
  // states the failure mode: a deploy with the connector and no re-verifier
  // ingests content whose `audience:` grants quietly stop granting a week later,
  // at the staleness bound, with every sync still green. Pinned here at the boot
  // seam as well as in each connector's own suite, because this is the file
  // where a vendor gets forgotten.
  it("registers all three brain source connectors AND their re-verifiers alongside their form handlers", () => {
    registerBuiltinInstallHandlers();

    // Every brain source: catalog id in the connector registry…
    expect(getBrainSourceConnector(SLACK_HISTORY_CATALOG_ID)).toBeDefined();
    expect(getBrainSourceConnector(ZOOM_TRANSCRIPTS_CATALOG_ID)).toBeDefined();
    expect(getBrainSourceConnector(OUTLOOK_MAIL_CATALOG_ID)).toBeDefined();

    // …its installable card…
    expect(getInstallHandler({ slug: "slack-history", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "zoom-transcripts", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "outlook-mail", install_model: "form" }).kind).toBe("form");

    // …and, for the two audience-bearing sources, the re-verifier that keeps
    // their grants alive. Slack's membership is synced by the Slack-scoped walk
    // in `audience/sync.ts` rather than by a registered re-verifier, so it is
    // deliberately absent from this list.
    const sources = listAudienceReverifierSources();
    expect(sources).toContain(ZOOM_TRANSCRIPT_SOURCE);
    expect(sources).toContain(OUTLOOK_MAIL_SOURCE);
  });

  it("⭐ a throwing brain registration costs that vendor ONLY — every later handler still registers", () => {
    // `registerBuiltinInstallHandlers` is a sequence of bare statements, and the
    // brain registrations are the first that can THROW on a code defect
    // (duplicate catalog id, unknown source kind, a re-verifier registered
    // twice) rather than short-circuit on missing env. Unwrapped, a throw in the
    // middle took down every handler after it — the remaining brain sources,
    // every OAuth handler, and every static bot handler — while `api/index.ts`
    // caught it at boot and carried on. The deployment then ran, silently,
    // without integrations nobody had touched.
    //
    // Provoked by pre-registering Zoom's re-verifier so the real registration
    // hits the duplicate throw, having already passed its connector-registry
    // gate. Asserts on the vendors AFTER it in the sequence.
    //
    // MUTATION THIS CATCHES: removing the `registerStep` wrapper.
    registerAudienceReverifier(ZOOM_TRANSCRIPT_SOURCE, () => Promise.resolve(ZERO_REVERIFY));

    expect(() => registerBuiltinInstallHandlers()).not.toThrow();

    // Outlook registers immediately after Zoom in the sequence…
    expect(getBrainSourceConnector(OUTLOOK_MAIL_CATALOG_ID)).toBeDefined();
    // …and so do the handlers far below it, which is where the real blast
    // radius was: every OAuth and static bot handler follows these three.
    expect(getInstallHandler({ slug: "outlook-mail", install_model: "form" }).kind).toBe("form");
    expect(getInstallHandler({ slug: "clickhouse", install_model: "form" }).kind).toBe("form");
  });
});
