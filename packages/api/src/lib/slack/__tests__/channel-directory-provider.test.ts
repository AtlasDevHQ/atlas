/**
 * Tests for the Slack channel-directory provider (#3463) — the
 * installation → token → conversations.list resolution chain and its
 * mapping onto the platform-neutral failure reasons (#3466).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

let mockInstallationByOrg:
  | { team_id: string; org_id: string | null; workspace_name: string | null; installed_at: string }
  | null = null;
let mockBotToken: string | null = null;

mock.module("@atlas/api/lib/slack/store", () => ({
  ENV_TEAM_ID: "env",
  KEY_PREFIX: "slack:installation:",
  FIELD: {
    botToken: "botToken",
    botUserId: "botUserId",
    teamName: "teamName",
    orgId: "orgId",
    workspaceName: "workspaceName",
    installedAt: "installedAt",
  },
  getInstallation: mock(async () => null),
  getInstallationByOrg: mock(async () => mockInstallationByOrg),
  saveInstallation: mock(async () => {}),
  deleteInstallation: mock(async () => {}),
  deleteInstallationByOrg: mock(async () => false),
  getBotToken: mock(async () => mockBotToken),
}));

type SlackChannelSummary = { id: string; name: string; isPrivate: boolean; isMember: boolean };
let mockListChannelsResult:
  | { ok: true; channels: SlackChannelSummary[] }
  | { ok: false; error: string } = { ok: true, channels: [] };

mock.module("@atlas/api/lib/slack/api", () => ({
  slackAPI: mock(async () => ({ ok: false, error: "not_mocked" })),
  postMessage: mock(async () => ({ ok: false, error: "not_mocked" })),
  updateMessage: mock(async () => ({ ok: false, error: "not_mocked" })),
  postEphemeral: mock(async () => ({ ok: false, error: "not_mocked" })),
  listChannels: mock(async () => mockListChannelsResult),
}));

const { slackChannelDirectoryProvider } = await import("../channel-directory-provider");

const installation = {
  team_id: "T-1",
  org_id: "org-1",
  workspace_name: "Acme",
  installed_at: "2026-05-17T12:00:00Z",
};

describe("slackChannelDirectoryProvider", () => {
  beforeEach(() => {
    mockInstallationByOrg = null;
    mockBotToken = null;
    mockListChannelsResult = { ok: true, channels: [] };
  });

  it("maps a missing installation to no_chat_installation", async () => {
    const result = await slackChannelDirectoryProvider.listWorkspaceChannels("org-1");
    expect(result).toEqual({ ok: false, reason: "no_chat_installation" });
  });

  it("maps an unreadable bot token to no_chat_installation", async () => {
    mockInstallationByOrg = installation;
    mockBotToken = null;
    const result = await slackChannelDirectoryProvider.listWorkspaceChannels("org-1");
    expect(result).toEqual({ ok: false, reason: "no_chat_installation" });
  });

  it("maps missing_scope distinctly (#3466)", async () => {
    mockInstallationByOrg = installation;
    mockBotToken = "xoxb-test";
    mockListChannelsResult = { ok: false, error: "missing_scope" };
    const result = await slackChannelDirectoryProvider.listWorkspaceChannels("org-1");
    expect(result).toEqual({ ok: false, reason: "missing_scope", detail: "missing_scope" });
  });

  it("maps every other Slack error to platform_error with the raw detail", async () => {
    mockInstallationByOrg = installation;
    mockBotToken = "xoxb-test";
    mockListChannelsResult = { ok: false, error: "ratelimited" };
    const result = await slackChannelDirectoryProvider.listWorkspaceChannels("org-1");
    expect(result).toEqual({ ok: false, reason: "platform_error", detail: "ratelimited" });
  });

  it("passes a successful listing through unchanged", async () => {
    mockInstallationByOrg = installation;
    mockBotToken = "xoxb-test";
    const channels = [
      { id: "C1", name: "general", isPrivate: false, isMember: true },
      { id: "C2", name: "secrets", isPrivate: true, isMember: false },
    ];
    mockListChannelsResult = { ok: true, channels };
    const result = await slackChannelDirectoryProvider.listWorkspaceChannels("org-1");
    expect(result).toEqual({ ok: true, channels });
  });
});
