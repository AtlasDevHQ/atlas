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

  it("posts the first time and stamps the row (UPDATE-first claim, post-1.5.0 polish)", async () => {
    // Post-1.5.0 the coordinator inverted SELECT-then-UPDATE to a
    // single atomic UPDATE-RETURNING claim. Concurrent admins racing
    // the enable flip now have Postgres serialise the WHERE-NULL
    // predicate — exactly one row is claimed and only the winner
    // calls the announcer. Claim returns a row when the UPDATE
    // succeeded.
    mockInternalRows = [
      // UPDATE ... RETURNING workspace_id AS id → one row when claim wins.
      [{ id: "org-1" }],
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

    // One query: the atomic claim UPDATE. No separate pre-check SELECT
    // (the conditional `WHERE announcement_posted_at IS NULL` IS the
    // pre-check — that's the whole point of the race-safety fix).
    expect(lastQueries).toHaveLength(1);
    expect(lastQueries[0].sql).toContain("UPDATE workspace_proactive_config");
    expect(lastQueries[0].sql).toContain("announcement_posted_at = NOW()");
    expect(lastQueries[0].sql).toContain("announcement_posted_at IS NULL");
    expect(lastQueries[0].sql).toContain("RETURNING workspace_id AS id");
  });

  it("no-ops the second time (already_posted reason)", async () => {
    // Claim UPDATE matches zero rows (row already stamped), so the
    // distinguishing SELECT runs to tell `no_config_row` vs
    // `already_posted` apart.
    mockInternalRows = [
      // 1st query: UPDATE → no claim (row already stamped).
      [],
      // 2nd query: distinguishing SELECT returns the stamped row.
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
    // UPDATE + distinguishing SELECT = 2 queries on this branch.
    expect(lastQueries).toHaveLength(2);
    expect(lastQueries[0].sql).toContain("UPDATE workspace_proactive_config");
    expect(lastQueries[1].sql).toContain("SELECT announcement_posted_at");
  });

  it("returns no_config_row when the workspace has no row", async () => {
    // UPDATE → no claim; distinguishing SELECT → no row at all.
    mockInternalRows = [[], []];
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

  it("post-claim announcer rejection maps to announcer_rejected with the platform message", async () => {
    // Post-1.5.0 polish: the bare `reason: string` was replaced by a
    // tagged union. Platform announcer rejections (other than the
    // recognised `no_announcer_configured` from NULL_ANNOUNCER) map
    // to `{ reason: "announcer_rejected", message }`. The claim
    // UPDATE is taken BEFORE the announcer call, so a rejection
    // doesn't release the stamp — see module header for the
    // race-safety / no-retry trade.
    mockInternalRows = [[{ id: "org-1" }]];
    const announcer: ChatAnnouncer = {
      postChannelAnnouncement: async () => ({ ok: false, reason: "rate_limited" }),
    };
    const outcome = await announceActivation({
      workspaceId: "org-1",
      channelId: "C-ann",
      announcer,
    });
    expect(outcome.posted).toBe(false);
    if (!outcome.posted && outcome.reason === "announcer_rejected") {
      expect(outcome.message).toBe("rate_limited");
    } else {
      throw new Error(
        `expected announcer_rejected outcome, got ${JSON.stringify(outcome)}`,
      );
    }
    // Only the claim UPDATE ran — stamp already taken.
    expect(lastQueries).toHaveLength(1);
    expect(lastQueries[0].sql).toContain("UPDATE workspace_proactive_config");
  });

  it("post-claim announcer throw maps to announcer_threw with the error message", async () => {
    mockInternalRows = [[{ id: "org-1" }]];
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
    if (!outcome.posted && outcome.reason === "announcer_threw") {
      expect(outcome.message).toBe("network");
    } else {
      throw new Error(
        `expected announcer_threw outcome, got ${JSON.stringify(outcome)}`,
      );
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
