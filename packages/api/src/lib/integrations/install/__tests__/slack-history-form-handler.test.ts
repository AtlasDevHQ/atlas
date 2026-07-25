/**
 * The Slack chat-history install handler (#4770).
 *
 * The handler's whole claim is that it verifies LOUDLY BEFORE PERSISTING — it
 * collects no credential, so pre-write verification is what replaces the
 * credential check its siblings run. So the highest-value test here is not
 * "does a good install work" but **"does a failed probe leave the database
 * untouched"**: a `workspace_plugins` row written against a channel the bot was
 * never invited to is a source that errors every cycle forever, discovered a
 * week later in a log instead of immediately on the form.
 *
 * The second-highest is the ROUND TRIP: `validateChannels` (here) and
 * `parseSlackHistoryConfig` (in the connector) are two hand-written statements
 * of the same rule in different files. A divergence means an install that
 * succeeds and then fails every single sync with "re-install it".
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";
import type { SlackConversationInfo } from "@atlas/api/lib/slack/api";
import {
  SLACK_HISTORY_MAX_CHANNELS,
  parseSlackHistoryConfig,
} from "@atlas/api/lib/brain/ingest/slack/config";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const catalogRows: { id: string }[] = [{ id: "catalog:slack-history" }];
let upserts: { sql: string; params: unknown[] }[] = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: async () => catalogRows }),
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
}));

void mock.module("@atlas/api/lib/integrations/install/knowledge-collection-install", () => ({
  assertCollectionInstallable: async () => {},
  // Mock-all-exports (CLAUDE.md) — unused here, but a missing symbol surfaces
  // as "Export named X not found" in an unrelated file, not this one.
  assertCollectionBatchInstallable: async () => {},
  upsertKnowledgeCollectionRow: async (params: { sql: string; params: unknown[] }) => {
    upserts.push({ sql: params.sql, params: params.params });
    return "row-id";
  },
}));

const { SlackHistoryFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/slack-history-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "ws-1" as WorkspaceId;

function channel(overrides: Partial<SlackConversationInfo> = {}): SlackConversationInfo {
  return { id: "C01ABCDEF", name: "general", isPrivate: false, isMember: true, isArchived: false, ...overrides };
}

function handler(opts: {
  info?: (channelId: string) => Promise<
    { ok: true; channel: SlackConversationInfo } | { ok: false; error: string; retryAfterSeconds: number | null }
  >;
  history?: () => Promise<
    | { ok: true; messages: []; nextCursor: null; dropped: number }
    | { ok: false; error: string; retryAfterSeconds: number | null }
  >;
  token?: string | null;
} = {}) {
  return new SlackHistoryFormInstallHandler({
    idGenerator: () => "fixed-id",
    store: {
      getInstallationByOrg: async () =>
        opts.token === null
          ? null
          : ({ team_id: "T1", org_id: WORKSPACE, workspace_name: "w", installed_at: "now" } as never),
      getBotToken: async () => opts.token ?? "xoxb-test",
    },
    getConversationInfo: (async (_token: string, channelId: string) =>
      (opts.info ?? (async () => ({ ok: true as const, channel: channel({ id: channelId }) })))(
        channelId,
      )) as never,
    fetchConversationHistoryPage: (async () =>
      (opts.history ?? (async () => ({ ok: true as const, messages: [], nextCursor: null, dropped: 0 })))()) as never,
  });
}

beforeEach(() => {
  upserts = [];
});

/**
 * `FormInstallValidationError`'s own `.message` is the generic "Form install
 * validation failed" — the ACTIONABLE text lives in `fieldErrors`/`formErrors`,
 * which is what the admin form renders. Asserting on `.message` would pass for
 * any validation failure at all, so every assertion here reads the payload.
 */
async function refusalText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FormInstallValidationError) {
      return [...Object.values(err.fieldErrors).flat(), ...err.formErrors].join(" | ");
    }
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the install to be refused");
}

describe("pre-write verification", () => {
  it("persists nothing when a channel probe fails", async () => {
    const h = handler({
      info: async () => ({ ok: false, error: "channel_not_found", retryAfterSeconds: null }),
    });
    await expect(
      h.validateConfig(WORKSPACE, { channels: "C01ABCDEF" }),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
    // The whole point of the handler's shape.
    expect(upserts).toHaveLength(0);
  });

  it("persists nothing when Slack is not connected", async () => {
    const h = handler({ token: null });
    expect(await refusalText(h.validateConfig(WORKSPACE, { channels: "C01ABCDEF" }))).toMatch(
      /connect Slack/i,
    );
    expect(upserts).toHaveLength(0);
  });

  it("refuses a channel the Atlas bot has not been invited to, naming the fix", async () => {
    const h = handler({
      info: async (channelId) => ({ ok: true, channel: channel({ id: channelId, isMember: false }) }),
    });
    expect(await refusalText(h.validateConfig(WORKSPACE, { channels: "C01ABCDEF" }))).toMatch(
      /invite the Atlas bot/i,
    );
    expect(upserts).toHaveLength(0);
  });

  it("probes HISTORY too — conversations.info alone cannot see the history scopes", async () => {
    // `conversations.info` is gated on channels:read/groups:read, which the
    // chat adapter's token already has. Without the history probe a token
    // missing channels:history passes every install check and then fails
    // `missing_scope` on the first sync — the per-cycle error nobody reads.
    const h = handler({
      history: async () => ({ ok: false, error: "missing_scope", retryAfterSeconds: null }),
    });
    expect(await refusalText(h.validateConfig(WORKSPACE, { channels: "C01ABCDEF" }))).toMatch(
      /channels:history/,
    );
    expect(upserts).toHaveLength(0);
  });

  it("ADMITS an archived channel — its history is still evidence", async () => {
    const h = handler({
      info: async (channelId) => ({ ok: true, channel: channel({ id: channelId, isArchived: true }) }),
    });
    await h.validateConfig(WORKSPACE, { channels: "C01ABCDEF" });
    expect(upserts).toHaveLength(1);
  });
});

describe("persisted install", () => {
  it("writes a knowledge-pillar row, normalised channels, and no credential", async () => {
    const h = handler();
    const result = await h.validateConfig(WORKSPACE, {
      channels: "c01abcdef, C02GHIJKL",
      description: "  eng chatter  ",
    });
    expect(result.credentialWritten).toBe(false);
    expect(upserts).toHaveLength(1);
    const config = JSON.parse(String(upserts[0]!.params[4])) as {
      channels: string[];
      description?: string;
    };
    expect(config.channels).toEqual(["C01ABCDEF", "C02GHIJKL"]);
    expect(config.description).toBe("eng chatter");
    expect(upserts[0]!.sql).toContain("'knowledge'");
    // No secret field anywhere in the persisted config.
    expect(JSON.stringify(config)).not.toContain("xoxb");
  });

  it("dedupes a repeated channel", async () => {
    const h = handler();
    await h.validateConfig(WORKSPACE, { channels: "C01ABCDEF,c01abcdef" });
    const config = JSON.parse(String(upserts[0]!.params[4])) as { channels: string[] };
    expect(config.channels).toEqual(["C01ABCDEF"]);
  });
});

describe("channel validation", () => {
  const cases: ReadonlyArray<[string, unknown, RegExp]> = [
    ["a 1:1 DM id", "D01ABCDEF", /Direct messages cannot be ingested/],
    ["a channel name", "#general", /not a Slack channel ID/],
    ["an empty list", "   ", /at least one Slack channel ID/],
    ["a non-string entry in an array", ["C01ABCDEF", 42], /must be a Slack channel ID string/],
    ["a non-list value", 42, /separated by commas/],
  ];
  for (const [label, input, pattern] of cases) {
    it(`refuses ${label}`, async () => {
      expect(await refusalText(handler().validateConfig(WORKSPACE, { channels: input }))).toMatch(
        pattern,
      );
      expect(upserts).toHaveLength(0);
    });
  }

  it("refuses more channels than one source may scope", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `C${String(i).padStart(8, "0")}`);
    expect(await refusalText(handler().validateConfig(WORKSPACE, { channels: many }))).toMatch(
      /at most 50/,
    );
  });

  it("accepts a whitespace-separated list as well as a comma-separated one", async () => {
    await handler().validateConfig(WORKSPACE, { channels: "C01ABCDEF C02GHIJKL" });
    const config = JSON.parse(String(upserts[0]!.params[4])) as { channels: string[] };
    expect(config.channels).toEqual(["C01ABCDEF", "C02GHIJKL"]);
  });
});

describe("the install ⇄ sync round trip", () => {
  it("everything the handler accepts, the connector's config parser also accepts", async () => {
    // Two hand-written statements of one rule in two files. A divergence is an
    // install that succeeds and then fails EVERY sync with "re-install it".
    const atCap = Array.from({ length: SLACK_HISTORY_MAX_CHANNELS }, (_, i) =>
      `C${String(i).padStart(8, "0")}`,
    );
    for (const input of [
      "C01ABCDEF",
      "c01abcdef, C02GHIJKL",
      "C01ABCDEF C02GHIJKL",
      ["C01ABCDEF", "G0123456789"],
      // The CAP BOUNDARY is the only real divergence surface: both sides
      // hand-write the same rule, and a `>=` on one side silently makes every
      // sync of a full-capacity install fail with "re-install it".
      atCap,
    ]) {
      upserts = [];
      await handler().validateConfig(WORKSPACE, { channels: input });
      const config = JSON.parse(String(upserts[0]!.params[4])) as Record<string, unknown>;
      const parsed = parseSlackHistoryConfig(config);
      expect({ input, ok: parsed.ok }).toEqual({ input, ok: true });
    }
  });
});
