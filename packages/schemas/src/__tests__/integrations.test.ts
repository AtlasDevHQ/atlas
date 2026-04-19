import { describe, expect, test } from "bun:test";
import { INTEGRATION_PLATFORMS } from "@useatlas/types";
import {
  IntegrationStatusSchema,
  SlackStatusSchema,
  TeamsStatusSchema,
  DiscordStatusSchema,
  TelegramStatusSchema,
  GChatStatusSchema,
  GitHubStatusSchema,
  LinearStatusSchema,
  WhatsAppStatusSchema,
  EmailStatusSchema,
  WebhookStatusSchema,
} from "../integrations";

const slack = {
  connected: true,
  teamId: "T01ABCD2EF",
  workspaceName: "Acme HQ",
  installedAt: "2026-04-19T12:00:00.000Z",
  oauthConfigured: true,
  envConfigured: false,
  configurable: true,
} as const;

const teams = {
  connected: true,
  tenantId: "00000000-0000-0000-0000-000000000001",
  tenantName: "Acme",
  installedAt: "2026-04-19T12:00:00.000Z",
  configurable: true,
} as const;

const discord = {
  connected: true,
  guildId: "987654321098765432",
  guildName: "Acme Internal",
  installedAt: "2026-04-19T12:00:00.000Z",
  configurable: true,
} as const;

const telegram = {
  connected: true,
  botId: "123456789",
  botUsername: "acme_atlas_bot",
  installedAt: "2026-04-19T12:00:00.000Z",
  configurable: true,
} as const;

const gchat = {
  connected: true,
  projectId: "acme-prod-1",
  serviceAccountEmail: "atlas@acme-prod-1.iam.gserviceaccount.com",
  installedAt: "2026-04-19T12:00:00.000Z",
  configurable: true,
} as const;

const github = {
  connected: true,
  username: "acme-bot",
  installedAt: "2026-04-19T12:00:00.000Z",
  configurable: true,
} as const;

const linear = {
  connected: true,
  userName: "Acme Bot",
  userEmail: "bot@acme.example",
  installedAt: "2026-04-19T12:00:00.000Z",
  configurable: true,
} as const;

const whatsapp = {
  connected: true,
  phoneNumberId: "1098765432109876",
  displayPhone: "+1 555 0100",
  installedAt: "2026-04-19T12:00:00.000Z",
  configurable: true,
} as const;

const email = {
  connected: true,
  provider: "resend",
  senderAddress: "atlas@acme.example",
  installedAt: "2026-04-19T12:00:00.000Z",
  configurable: true,
} as const;

const webhooks = {
  activeCount: 3,
  configurable: true,
} as const;

const validIntegrationStatus = {
  slack,
  teams,
  discord,
  telegram,
  gchat,
  github,
  linear,
  whatsapp,
  email,
  webhooks,
  deliveryChannels: ["email", "slack", "webhook"] as ("email" | "slack" | "webhook")[],
  deployMode: "saas" as const,
  hasInternalDB: true,
};

describe("per-platform golden parses", () => {
  test("SlackStatusSchema parses a connected workspace", () => {
    expect(SlackStatusSchema.parse(slack)).toEqual(slack);
  });

  test("TeamsStatusSchema parses a connected tenant", () => {
    expect(TeamsStatusSchema.parse(teams)).toEqual(teams);
  });

  test("DiscordStatusSchema parses a connected guild", () => {
    expect(DiscordStatusSchema.parse(discord)).toEqual(discord);
  });

  test("TelegramStatusSchema parses a connected bot", () => {
    expect(TelegramStatusSchema.parse(telegram)).toEqual(telegram);
  });

  test("GChatStatusSchema parses a connected project", () => {
    expect(GChatStatusSchema.parse(gchat)).toEqual(gchat);
  });

  test("GitHubStatusSchema parses a connected user", () => {
    expect(GitHubStatusSchema.parse(github)).toEqual(github);
  });

  test("LinearStatusSchema parses a connected user", () => {
    expect(LinearStatusSchema.parse(linear)).toEqual(linear);
  });

  test("WhatsAppStatusSchema parses a connected business phone", () => {
    expect(WhatsAppStatusSchema.parse(whatsapp)).toEqual(whatsapp);
  });

  test("EmailStatusSchema parses a Resend-backed provider", () => {
    expect(EmailStatusSchema.parse(email)).toEqual(email);
  });

  test("WebhookStatusSchema parses an active workspace webhook count", () => {
    expect(WebhookStatusSchema.parse(webhooks)).toEqual(webhooks);
  });
});

describe("IntegrationStatusSchema happy-path", () => {
  test("parses the fully-connected aggregate response", () => {
    expect(IntegrationStatusSchema.parse(validIntegrationStatus)).toEqual(
      validIntegrationStatus,
    );
  });

  test("parses a disconnected aggregate (every nullable column null)", () => {
    const disconnected = {
      slack: { ...slack, connected: false, teamId: null, workspaceName: null, installedAt: null },
      teams: { ...teams, connected: false, tenantId: null, tenantName: null, installedAt: null },
      discord: { ...discord, connected: false, guildId: null, guildName: null, installedAt: null },
      telegram: { ...telegram, connected: false, botId: null, botUsername: null, installedAt: null },
      gchat: { ...gchat, connected: false, projectId: null, serviceAccountEmail: null, installedAt: null },
      github: { ...github, connected: false, username: null, installedAt: null },
      linear: { ...linear, connected: false, userName: null, userEmail: null, installedAt: null },
      whatsapp: { ...whatsapp, connected: false, phoneNumberId: null, displayPhone: null, installedAt: null },
      email: { ...email, connected: false, provider: null, senderAddress: null, installedAt: null },
      webhooks: { activeCount: 0, configurable: true },
      deliveryChannels: [],
      deployMode: "self-hosted" as const,
      hasInternalDB: false,
    };
    const parsed = IntegrationStatusSchema.parse(disconnected);
    expect(parsed.slack.connected).toBe(false);
    expect(parsed.deployMode).toBe("self-hosted");
    expect(parsed.deliveryChannels).toEqual([]);
  });

  test("INTEGRATION_PLATFORMS keys are each present on the aggregate", () => {
    const parsed = IntegrationStatusSchema.parse(validIntegrationStatus);
    for (const platform of INTEGRATION_PLATFORMS) {
      expect(parsed).toHaveProperty(platform);
    }
  });
});

// Strict `z.enum(TUPLE)` rejects unknown deploy modes and delivery channels at
// parse time so a drifted backend surfaces in the admin page's
// `schema_mismatch` banner instead of as undefined UI behavior.
describe("strict-enum rejection", () => {
  test("unknown deployMode fails parse", () => {
    const drifted = { ...validIntegrationStatus, deployMode: "hybrid" };
    expect(IntegrationStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown deliveryChannels entry fails parse", () => {
    const drifted = {
      ...validIntegrationStatus,
      deliveryChannels: ["email", "pager"],
    };
    expect(IntegrationStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("each DELIVERY_CHANNELS value parses", () => {
    for (const channel of ["email", "slack", "webhook"] as const) {
      const ok = { ...validIntegrationStatus, deliveryChannels: [channel] };
      expect(IntegrationStatusSchema.parse(ok).deliveryChannels).toEqual([channel]);
    }
  });

  test("each deployMode value parses", () => {
    for (const deployMode of ["saas", "self-hosted"] as const) {
      expect(
        IntegrationStatusSchema.parse({ ...validIntegrationStatus, deployMode }).deployMode,
      ).toBe(deployMode);
    }
  });

  // `installedAt` is `z.string().datetime()` — non-ISO timestamps fail parse.
  // Without this, a future relaxation back to `z.string()` would silently revert
  // the tightening introduced when the schemas were consolidated.
  test("non-ISO installedAt fails parse on every connection-bearing platform", () => {
    const cases = [
      [SlackStatusSchema, slack],
      [TeamsStatusSchema, teams],
      [DiscordStatusSchema, discord],
      [TelegramStatusSchema, telegram],
      [GChatStatusSchema, gchat],
      [GitHubStatusSchema, github],
      [LinearStatusSchema, linear],
      [WhatsAppStatusSchema, whatsapp],
      [EmailStatusSchema, email],
    ] as const;
    for (const [schema, payload] of cases) {
      const drifted = { ...payload, installedAt: "yesterday" };
      expect(schema.safeParse(drifted).success).toBe(false);
    }
  });
});

describe("structural rejection", () => {
  test("missing platform key (slack) fails parse", () => {
    const { slack: _slack, ...missing } = validIntegrationStatus;
    expect(IntegrationStatusSchema.safeParse(missing).success).toBe(false);
  });

  test("missing required sub-field (slack.configurable) fails parse", () => {
    const { configurable: _c, ...slackMissing } = slack;
    const drifted = { ...validIntegrationStatus, slack: slackMissing };
    expect(IntegrationStatusSchema.safeParse(drifted).success).toBe(false);
  });

  // Per-platform parity — each platform's first identity field stripped. Catches
  // a future "I copy-pasted the schema and forgot to keep field X" regression
  // that the satisfies-guard would only catch if the type was also wrong.
  test.each([
    ["teams", TeamsStatusSchema, teams, "tenantId"],
    ["discord", DiscordStatusSchema, discord, "guildId"],
    ["telegram", TelegramStatusSchema, telegram, "botId"],
    ["gchat", GChatStatusSchema, gchat, "projectId"],
    ["github", GitHubStatusSchema, github, "username"],
    ["linear", LinearStatusSchema, linear, "userName"],
    ["whatsapp", WhatsAppStatusSchema, whatsapp, "phoneNumberId"],
    ["email", EmailStatusSchema, email, "provider"],
  ] as const)("%s platform rejects payload missing %s", (_name, schema, payload, field) => {
    const drifted: Record<string, unknown> = { ...payload };
    delete drifted[field];
    expect(schema.safeParse(drifted).success).toBe(false);
  });

  test("non-boolean hasInternalDB fails parse", () => {
    const drifted = { ...validIntegrationStatus, hasInternalDB: "yes" };
    expect(IntegrationStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("non-array deliveryChannels fails parse", () => {
    const drifted = { ...validIntegrationStatus, deliveryChannels: "email" };
    expect(IntegrationStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("WebhookStatusSchema rejects negative activeCount", () => {
    expect(
      WebhookStatusSchema.safeParse({ activeCount: -1, configurable: true }).success,
    ).toBe(false);
  });

  test("WebhookStatusSchema rejects non-integer activeCount", () => {
    expect(
      WebhookStatusSchema.safeParse({ activeCount: 1.5, configurable: true }).success,
    ).toBe(false);
  });

  // Webhook is the structural outlier — no `connected` field. A copy-paste
  // mistake that shapes webhooks like the other platforms must fail loudly.
  test("aggregate rejects webhooks shaped like a connection-bearing platform", () => {
    const drifted = {
      ...validIntegrationStatus,
      webhooks: { connected: true, configurable: true },
    };
    expect(IntegrationStatusSchema.safeParse(drifted).success).toBe(false);
  });
});
