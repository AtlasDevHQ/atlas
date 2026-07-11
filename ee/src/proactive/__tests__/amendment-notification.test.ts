/**
 * Tests for the amendments-pending proactive notice EE delivery (#4520).
 *
 * Two surfaces:
 *   - `buildAmendmentsPendingMessage` — pure markdown renderer. Pinned on
 *     the "pending your review" phrasing (PRD user story 25) and the
 *     singular/plural agreement so a copy regression fails loudly.
 *   - `notifyAmendmentsPending` — resolves the workspace's proactive
 *     announcement channel and posts via a `ChatAnnouncer` stub. The
 *     internal DB is mocked at `internalQuery` so channel-present /
 *     no-row / no-channel branches are scripted independently, and every
 *     failure path is asserted to resolve a `{ posted: false }` outcome
 *     (best-effort — nothing throws).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { ChatAnnouncer } from "@atlas/api/lib/proactive/types";

// --- Internal DB mock ---
type InternalQueryCall = { sql: string; params: unknown[] };
let lastQueries: InternalQueryCall[] = [];
let mockInternalRows: unknown[][] = [];
let mockHasInternalDB = true;
let internalQueryThrows = false;

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    lastQueries.push({ sql, params: params ?? [] });
    if (internalQueryThrows) throw new Error("db brownout");
    return mockInternalRows.shift() ?? [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mockInternalQuery,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { notifyAmendmentsPending, buildAmendmentsPendingMessage } = await import(
  "../amendment-notification"
);

function reset(): void {
  mockHasInternalDB = true;
  internalQueryThrows = false;
  lastQueries = [];
  mockInternalRows = [];
  mockInternalQuery.mockClear();
}

/** A recording announcer stub. `result` scripts its reply. */
function makeAnnouncer(
  result:
    | { ok: true; messageId?: string }
    | { ok: false; reason: string }
    | "throw",
): { announcer: ChatAnnouncer; calls: Array<{ workspaceId: string; channelId: string; markdown: string }> } {
  const calls: Array<{ workspaceId: string; channelId: string; markdown: string }> = [];
  const announcer: ChatAnnouncer = {
    async postChannelAnnouncement(input) {
      calls.push(input);
      if (result === "throw") throw new Error("network down");
      return result;
    },
  };
  return { announcer, calls };
}

describe("buildAmendmentsPendingMessage (#4520)", () => {
  it("uses singular agreement for a single amendment", () => {
    const msg = buildAmendmentsPendingMessage(1);
    expect(msg).toContain("1 new semantic-layer improvement is pending your review");
    expect(msg).toContain("queued a change");
  });

  it("uses plural agreement for multiple amendments", () => {
    const msg = buildAmendmentsPendingMessage(5);
    expect(msg).toContain("5 new semantic-layer improvements are pending your review");
    expect(msg).toContain("queued 5 changes");
  });
});

describe("notifyAmendmentsPending (#4520)", () => {
  beforeEach(reset);

  it("posts to the workspace's announcement channel and reports the message id", async () => {
    mockInternalRows = [[{ announcement_channel_id: "C123" }]];
    const { announcer, calls } = makeAnnouncer({ ok: true, messageId: "slack-9" });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 3, announcer });

    expect(outcome).toEqual({ posted: true, messageId: "slack-9" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ workspaceId: "org-a", channelId: "C123" });
    expect(calls[0].markdown).toContain("3 new semantic-layer improvements");
    // The config probe is keyed by workspace id.
    expect(lastQueries[0].params).toEqual(["org-a"]);
  });

  it("skips cleanly when no internal DB is configured", async () => {
    mockHasInternalDB = false;
    const { announcer, calls } = makeAnnouncer({ ok: true });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 1, announcer });

    expect(outcome).toEqual({ posted: false, reason: "no_internal_db" });
    expect(calls).toHaveLength(0);
  });

  it("skips with no_config_row when the workspace never engaged proactive", async () => {
    mockInternalRows = [[]];
    const { announcer, calls } = makeAnnouncer({ ok: true });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 2, announcer });

    expect(outcome).toEqual({ posted: false, reason: "no_config_row" });
    expect(calls).toHaveLength(0);
  });

  it("skips with no_channel when proactive config exists but no announcement channel", async () => {
    mockInternalRows = [[{ announcement_channel_id: null }]];
    const { announcer, calls } = makeAnnouncer({ ok: true });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 2, announcer });

    expect(outcome).toEqual({ posted: false, reason: "no_channel" });
    expect(calls).toHaveLength(0);
  });

  it("maps the null announcer to no_announcer_configured", async () => {
    mockInternalRows = [[{ announcement_channel_id: "C123" }]];
    const { announcer } = makeAnnouncer({ ok: false, reason: "no_announcer_configured" });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 1, announcer });

    expect(outcome).toEqual({ posted: false, reason: "no_announcer_configured" });
  });

  it("maps any other announcer rejection to announcer_rejected with the platform reason", async () => {
    mockInternalRows = [[{ announcement_channel_id: "C123" }]];
    const { announcer } = makeAnnouncer({ ok: false, reason: "channel_archived" });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 1, announcer });

    expect(outcome).toEqual({ posted: false, reason: "announcer_rejected", message: "channel_archived" });
  });

  it("maps a thrown announcer to announcer_threw without propagating", async () => {
    mockInternalRows = [[{ announcement_channel_id: "C123" }]];
    const { announcer } = makeAnnouncer("throw");

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 1, announcer });

    expect(outcome).toMatchObject({ posted: false, reason: "announcer_threw" });
  });

  it("maps a config-read failure to a non-throwing error outcome", async () => {
    internalQueryThrows = true;
    const { announcer, calls } = makeAnnouncer({ ok: true });

    const outcome = await notifyAmendmentsPending({ workspaceId: "org-a", count: 1, announcer });

    expect(outcome).toMatchObject({ posted: false, reason: "error" });
    expect(calls).toHaveLength(0);
  });
});
