/**
 * Tests for the proactive-chat AnnouncementCoordinator (#2300).
 *
 * Two surfaces:
 *   - `buildAnnouncementMessage` — pure markdown renderer. Smoke-pinned
 *     against the consent language so a regression of the disclosure
 *     copy fails CI loudly (the wording exists for a privacy reason).
 *   - `announceActivation` — DB-coupled idempotency contract. The
 *     internal DB is mocked at the `internalQuery` boundary so we can
 *     script the pre-check + UPDATE sides independently.
 *
 * The "two-call → one-post" assertion is the bug the slice exists to
 * prevent (re-announcing on every disable + re-enable noisy-pings the
 * end-user channel and erodes trust).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// --- Internal DB mock ---

type InternalQueryCall = { sql: string; params: unknown[] };
let lastQueries: InternalQueryCall[] = [];
let mockInternalRows: unknown[][] = [];
let mockHasInternalDB = true;

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    lastQueries.push({ sql, params: params ?? [] });
    return mockInternalRows.shift() ?? [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mockInternalQuery,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const {
  announceActivation,
  buildAnnouncementMessage,
  NULL_ANNOUNCER,
} = await import("../announcement-coordinator");

import type { ChatAnnouncer } from "../announcement-coordinator";

function reset(): void {
  mockHasInternalDB = true;
  lastQueries = [];
  mockInternalRows = [];
  mockInternalQuery.mockClear();
}

// ---------------------------------------------------------------------------
// Pure renderer
// ---------------------------------------------------------------------------

describe("buildAnnouncementMessage", () => {
  it("returns non-empty markdown", () => {
    const msg = buildAnnouncementMessage();
    expect(msg.length).toBeGreaterThan(0);
  });

  it("includes the disclosure language so users see the consent story", () => {
    // The slice's whole point is to give end-users the consent context
    // at the point of contact. If a future copy edit drops it, this
    // test fails and forces the author to confirm the intent.
    const msg = buildAnnouncementMessage();
    expect(msg).toContain("only reads messages in channels");
    expect(msg).toContain("opted in");
  });

  it("includes the opt-out instruction so we never look like we hide the off switch", () => {
    const msg = buildAnnouncementMessage();
    expect(msg).toContain("unsubscribe");
  });

  it("is deterministic across calls (no timestamps, no nonces)", () => {
    expect(buildAnnouncementMessage()).toBe(buildAnnouncementMessage());
  });
});

// ---------------------------------------------------------------------------
// Coordinator idempotency
// ---------------------------------------------------------------------------

describe("announceActivation", () => {
  beforeEach(reset);

  it("posts the first time and stamps the row", async () => {
    // Pre-check: row exists, announcement_posted_at NULL.
    mockInternalRows = [
      [{ announcement_posted_at: null }],
      // UPDATE returns nothing — we don't check the row count here, just
      // that the UPDATE fires.
      [],
    ];

    const calls: Array<{ channelId: string; workspaceId: string; markdown: string }> = [];
    const announcer: ChatAnnouncer = {
      postChannelAnnouncement: async (input) => {
        calls.push(input);
        return { ok: true as const, messageId: "m-1" };
      },
    };

    const outcome = await announceActivation({
      workspaceId: "org-1",
      channelId: "C-ann",
      announcer,
    });

    expect(outcome.posted).toBe(true);
    if (outcome.posted) {
      expect(outcome.messageId).toBe("m-1");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ workspaceId: "org-1", channelId: "C-ann" });
    expect(calls[0].markdown).toContain("only reads messages in channels");

    // Two queries: SELECT pre-check + UPDATE stamp.
    expect(lastQueries).toHaveLength(2);
    expect(lastQueries[0].sql).toContain("SELECT announcement_posted_at");
    expect(lastQueries[1].sql).toContain("UPDATE workspace_proactive_config");
    expect(lastQueries[1].sql).toContain("announcement_posted_at = NOW()");
    expect(lastQueries[1].sql).toContain("announcement_posted_at IS NULL");
  });

  it("no-ops the second time (already_posted reason)", async () => {
    // Pre-check returns a row with a non-null stamp.
    mockInternalRows = [
      [{ announcement_posted_at: new Date("2026-05-17T00:00:00Z") }],
    ];

    let announcerCallCount = 0;
    const announcer: ChatAnnouncer = {
      postChannelAnnouncement: async () => {
        announcerCallCount += 1;
        return { ok: true as const, messageId: "m-x" };
      },
    };

    const outcome = await announceActivation({
      workspaceId: "org-1",
      channelId: "C-ann",
      announcer,
    });

    expect(outcome.posted).toBe(false);
    if (!outcome.posted) {
      expect(outcome.reason).toBe("already_posted");
    }
    // Announcer was NOT called.
    expect(announcerCallCount).toBe(0);
    // Only the SELECT ran — no UPDATE.
    expect(lastQueries).toHaveLength(1);
  });

  it("returns no_config_row when the workspace has no row", async () => {
    mockInternalRows = [[]];
    const outcome = await announceActivation({
      workspaceId: "org-ghost",
      channelId: "C-ann",
      announcer: NULL_ANNOUNCER,
    });
    expect(outcome.posted).toBe(false);
    if (!outcome.posted) expect(outcome.reason).toBe("no_config_row");
  });

  it("returns no_internal_db when no internal DB is configured", async () => {
    mockHasInternalDB = false;
    const outcome = await announceActivation({
      workspaceId: "org-1",
      channelId: "C-ann",
      announcer: NULL_ANNOUNCER,
    });
    expect(outcome.posted).toBe(false);
    if (!outcome.posted) expect(outcome.reason).toBe("no_internal_db");
    expect(lastQueries).toHaveLength(0);
  });

  it("leaves the stamp NULL when the announcer rejects (retry-able)", async () => {
    mockInternalRows = [[{ announcement_posted_at: null }]];
    const announcer: ChatAnnouncer = {
      postChannelAnnouncement: async () => ({ ok: false, reason: "rate_limited" }),
    };
    const outcome = await announceActivation({
      workspaceId: "org-1",
      channelId: "C-ann",
      announcer,
    });
    expect(outcome.posted).toBe(false);
    if (!outcome.posted) expect(outcome.reason).toBe("rate_limited");
    // Only the SELECT — no UPDATE because we didn't post.
    expect(lastQueries).toHaveLength(1);
  });

  it("leaves the stamp NULL when the announcer throws", async () => {
    mockInternalRows = [[{ announcement_posted_at: null }]];
    const announcer: ChatAnnouncer = {
      postChannelAnnouncement: async () => {
        throw new Error("network");
      },
    };
    const outcome = await announceActivation({
      workspaceId: "org-1",
      channelId: "C-ann",
      announcer,
    });
    expect(outcome.posted).toBe(false);
    if (!outcome.posted) {
      expect(outcome.reason.startsWith("announcer_threw")).toBe(true);
    }
    expect(lastQueries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// NULL_ANNOUNCER fallback
// ---------------------------------------------------------------------------

describe("NULL_ANNOUNCER", () => {
  it("never posts and returns a stable reason", async () => {
    const res = await NULL_ANNOUNCER.postChannelAnnouncement({
      workspaceId: "org-1",
      channelId: "C-x",
      markdown: "...",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_announcer_configured");
  });
});
