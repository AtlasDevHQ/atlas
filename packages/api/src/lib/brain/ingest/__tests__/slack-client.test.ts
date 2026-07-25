/**
 * The Slack chat-history vendor client (#4770).
 *
 * Two things here are contracts rather than implementation, and both are tested
 * against their stated property rather than a golden string:
 *
 *   - the SOURCE-ID FORMAT, which a future webhook writer (M3) must reproduce
 *     byte-for-byte or the two writers duplicate every message they race on;
 *   - the CURSOR's gapless-and-convergent behaviour under truncation, resume,
 *     budget exhaustion and channel-set changes — the only thing standing
 *     between a budget-limited pass and permanently lost history.
 *
 * The budget cases in particular are written so the branch under test actually
 * RUNS: an earlier cut of this file scripted every channel with
 * `nextCursor: null`, which short-circuits before the budget check, so it
 * certified an overshoot bug as safe. Any fixture here that means to exercise
 * truncation carries a non-null cursor.
 */

import { describe, expect, it } from "bun:test";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import type {
  SlackConversationInfo,
  SlackHistoryMessage,
  SlackHistoryPageParams,
} from "@atlas/api/lib/slack/api";
import {
  HISTORY_MAX_PAGES_PER_CHANNEL,
  HISTORY_MAX_PAGES_PER_PASS,
  HISTORY_PAGE_LIMIT,
  SAFETY_LAG_MS,
  createSlackHistoryClient,
  msToSlackTs,
  parseSlackHistoryCursor,
  serialiseSlackHistoryCursor,
  toEpisode,
  type SlackChannelMark,
  type SlackHistoryApi,
} from "@atlas/api/lib/brain/ingest/slack/client";
import { slackEpisodeSourceId } from "@atlas/api/lib/brain/ingest/slack/config";

const NOW = new Date("2026-07-01T12:00:00.000Z");
/** Inside the 7-day backfill window, so fixtures exercise real comparisons. */
const RECENT = Math.floor(NOW.getTime() / 1000) - 3600;

function message(overrides: Partial<SlackHistoryMessage> = {}): SlackHistoryMessage {
  return { ts: "1750000000.000100", text: "hello", user: "U1", subtype: null, botId: null, ...overrides };
}

function channel(overrides: Partial<SlackConversationInfo> = {}): SlackConversationInfo {
  return { id: "C1", name: "general", isPrivate: false, isMember: true, isArchived: false, ...overrides };
}

/** `n` messages, newest first — the order Slack pages them in. */
function page(n: number, startSeconds: number, nextCursor: string | null) {
  return {
    messages: Array.from({ length: n }, (_, i) =>
      message({ ts: `${startSeconds - i}.000000` }),
    ),
    nextCursor,
  };
}

function cursorOf(entries: Record<string, SlackChannelMark>): string {
  return serialiseSlackHistoryCursor(new Map(Object.entries(entries)));
}

function marksOf(raw: string | null | undefined): Map<string, SlackChannelMark> {
  return parseSlackHistoryCursor(raw ?? null).marks;
}

/** A fake Slack surface: one scripted page list per channel. */
function fakeApi(opts: {
  channels?: Record<string, SlackConversationInfo>;
  pages?: Record<string, { messages: SlackHistoryMessage[]; nextCursor: string | null }[]>;
  dropped?: Record<string, number>;
  onInfo?: (channelId: string) => ReturnType<SlackHistoryApi["getConversationInfo"]> | undefined;
  calls?: SlackHistoryPageParams[];
}): SlackHistoryApi {
  const pageIndex = new Map<string, number>();
  return {
    async getConversationInfo(_token, channelId) {
      const override = opts.onInfo?.(channelId);
      if (override !== undefined) return override;
      const info = opts.channels?.[channelId];
      if (info === undefined) {
        return { ok: false, error: "channel_not_found", retryAfterSeconds: null };
      }
      return { ok: true, channel: info };
    },
    async fetchConversationHistoryPage(_token, params) {
      opts.calls?.push(params);
      const pages = opts.pages?.[params.channel] ?? [];
      const index = pageIndex.get(params.channel) ?? 0;
      pageIndex.set(params.channel, index + 1);
      const scripted = pages[index];
      const dropped = index === 0 ? (opts.dropped?.[params.channel] ?? 0) : 0;
      if (scripted === undefined) return { ok: true, messages: [], nextCursor: null, dropped };
      return { ok: true, messages: scripted.messages, nextCursor: scripted.nextCursor, dropped };
    },
  };
}

function client(api: SlackHistoryApi, channels: string[] = ["C1"]) {
  return createSlackHistoryClient({
    token: "xoxb-test",
    channels,
    backfillWindowMs: 7 * 86_400_000,
    api,
    now: () => NOW,
  });
}

function fetchWith(
  api: SlackHistoryApi,
  channels: string[],
  overrides: Partial<Parameters<ReturnType<typeof client>["fetchEpisodes"]>[0]> = {},
) {
  return client(api, channels).fetchEpisodes({
    mode: "incremental",
    since: null,
    cursor: null,
    maxEpisodes: 1000,
    ...overrides,
  });
}

// ══════════════════════════════════════════════════════════════════
// The source-id contract
// ══════════════════════════════════════════════════════════════════

describe("the source-id contract", () => {
  it("is `<channelId>:<ts>` — the format a webhook writer must reproduce", () => {
    const episode = toEpisode("C01ABCDEF", message({ ts: "1750000000.000100" }), ["org"]);
    expect(episode?.sourceId).toBe("C01ABCDEF:1750000000.000100");
    expect(episode?.sourceId).toBe(slackEpisodeSourceId("C01ABCDEF", "1750000000.000100"));
  });

  it("is channel-scoped — the same ts in two channels is two episodes", () => {
    const a = toEpisode("C1", message({ ts: "1.000001" }), ["org"]);
    const b = toEpisode("C2", message({ ts: "1.000001" }), ["org"]);
    expect(a?.sourceId).not.toBe(b?.sourceId);
  });

  it("gives a thread reply its own id rather than folding it into its parent", () => {
    const parent = toEpisode("C1", message({ ts: "1.000001" }), ["org"]);
    const reply = toEpisode("C1", message({ ts: "1.000002" }), ["org"]);
    expect(parent?.sourceId).not.toBe(reply?.sourceId);
  });
});

describe("toEpisode", () => {
  it("carries the message text by value and the Slack author as the actor", () => {
    const episode = toEpisode("C1", message({ text: "we ship Thursdays", user: "U9" }), ["org"]);
    expect(episode?.body).toBe("we ship Thursdays");
    expect(episode?.sourceActor).toBe("U9");
  });

  it("converts the Slack ts to an event time", () => {
    const episode = toEpisode("C1", message({ ts: "1750000000.000100" }), ["org"]);
    expect(episode?.occurredAt?.toISOString()).toBe(new Date(1750000000000.1).toISOString());
  });

  it("skips bot messages — the brain must not cite itself as evidence", () => {
    expect(toEpisode("C1", message({ botId: "B123" }), ["org"])).toBeNull();
  });

  it("skips membership noise", () => {
    expect(toEpisode("C1", message({ subtype: "channel_join" }), ["org"])).toBeNull();
    expect(toEpisode("C1", message({ subtype: "channel_topic" }), ["org"])).toBeNull();
  });

  it("KEEPS an unknown subtype — the filter is a denylist on purpose", () => {
    expect(toEpisode("C1", message({ subtype: "thread_broadcast" }), ["org"])).not.toBeNull();
    expect(toEpisode("C1", message({ subtype: "file_share" }), ["org"])).not.toBeNull();
  });

  it("skips a blank message rather than letting the CHECK abort the batch", () => {
    expect(toEpisode("C1", message({ text: "   " }), ["org"])).toBeNull();
  });

  it("counts every skip by reason — 'stored 0' must be distinguishable from 'empty'", () => {
    const skips = { bot: 0, subtype: 0, emptyText: 0 };
    toEpisode("C1", message({ botId: "B1" }), ["org"], skips);
    toEpisode("C1", message({ subtype: "channel_join" }), ["org"], skips);
    toEpisode("C1", message({ text: "" }), ["org"], skips);
    toEpisode("C1", message(), ["org"], skips);
    expect(skips).toEqual({ bot: 1, subtype: 1, emptyText: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════
// Grant derivation flows from channel visibility
// ══════════════════════════════════════════════════════════════════

describe("grants", () => {
  it("stamps org on a public channel's episodes", async () => {
    const api = fakeApi({
      channels: { C1: channel({ isPrivate: false }) },
      pages: { C1: [{ messages: [message()], nextCursor: null }] },
    });
    const changes = await fetchWith(api, ["C1"]);
    expect(changes.episodes[0]?.visibleTo).toEqual(["org"]);
  });

  it("stamps a channel audience on a private channel's episodes", async () => {
    const api = fakeApi({
      channels: { C1: channel({ isPrivate: true }) },
      pages: { C1: [{ messages: [message()], nextCursor: null }] },
    });
    const changes = await fetchWith(api, ["C1"]);
    expect(changes.episodes[0]?.visibleTo).toEqual(["audience:chat-channel:slack:C1"]);
  });
});

// ══════════════════════════════════════════════════════════════════
// The per-channel cursor: gapless AND convergent
// ══════════════════════════════════════════════════════════════════

describe("the per-channel cursor", () => {
  it("round-trips both arms of the mark union", () => {
    const marks = new Map<string, SlackChannelMark>([
      ["C1", { kind: "backfilling", ts: "1.000001", top: "9.000009", resume: "5.000005" }],
      ["C2", { kind: "contiguous", ts: "3.000003" }],
    ]);
    expect(marksOf(serialiseSlackHistoryCursor(marks))).toEqual(marks);
  });

  it("treats an unreadable cursor as ABSENT rather than fatal", () => {
    expect(parseSlackHistoryCursor("{not json").marks.size).toBe(0);
    expect(parseSlackHistoryCursor('{"v":99,"channels":{"C1":{"ts":"1"}}}').marks.size).toBe(0);
    expect(parseSlackHistoryCursor(null).marks.size).toBe(0);
    expect(parseSlackHistoryCursor('["C1"]').marks.size).toBe(0);
    expect(parseSlackHistoryCursor('{"v":1,"channels":["C1"]}').marks.size).toBe(0);
  });

  it("NAMES the channels whose marks it had to drop", () => {
    // Dropping a mark restarts that channel at the backfill FLOOR, and when the
    // lost mark was older than the floor that is a forward jump over history
    // nobody will ever fetch. Silent would be the wrong shape of failure.
    const parsed = parseSlackHistoryCursor('{"v":1,"channels":{"C1":{"ts":""},"C2":{"ts":"5.0"}}}');
    expect(parsed.dropped).toEqual(["C1"]);
    expect(parsed.marks.get("C2")).toEqual({ kind: "contiguous", ts: "5.0" });
  });

  it("refuses a `resume` with no `top` — the pair is what stops a false completion", () => {
    // Half a pair would let a `latest`-bounded pass complete, take the ordinary
    // completion branch, and claim coverage of everything above `resume`.
    const parsed = parseSlackHistoryCursor(
      '{"v":1,"channels":{"C1":{"ts":"1.0","resume":"5.0"}}}',
    );
    expect(parsed.marks.get("C1")).toEqual({ kind: "contiguous", ts: "1.0" });
  });

  it("refuses an out-of-order backfill pair", () => {
    // `ts < resume ≤ top` or it is not a window this walk can fill.
    const parsed = parseSlackHistoryCursor(
      '{"v":1,"channels":{"C1":{"ts":"9.0","resume":"5.0","top":"7.0"}}}',
    );
    expect(parsed.marks.get("C1")?.kind).toBe("contiguous");
  });

  it("starts a never-synced channel at the backfill floor, not at epoch", async () => {
    const calls: SlackHistoryPageParams[] = [];
    const api = fakeApi({ channels: { C1: channel() }, pages: {}, calls });
    await fetchWith(api, ["C1"]);
    expect(calls[0]?.oldest).toBe(msToSlackTs(NOW.getTime() - 7 * 86_400_000));
  });

  it("advances a fully-covered EMPTY window to now-minus-the-safety-lag", async () => {
    const api = fakeApi({ channels: { C1: channel() }, pages: {} });
    const changes = await fetchWith(api, ["C1"], {
      cursor: cursorOf({ C1: { kind: "contiguous", ts: "1.000000" } }),
    });
    // EXACT, not a range: a range passes for a 1 ms lag, a 1 week lag, and for
    // replacing the floor with any arbitrary forward jump. The lag is what
    // stops a quiet channel's re-scan window from growing until it exceeds the
    // budget, so it is worth pinning to the constant.
    expect(marksOf(changes.cursor).get("C1")!.ts).toBe(
      msToSlackTs(NOW.getTime() - SAFETY_LAG_MS),
    );
  });

  it("does NOT advance the mark when a pass is truncated — no gap is skipped", async () => {
    const api = fakeApi({
      channels: { C1: channel() },
      pages: {
        C1: Array.from({ length: 6 }, (_, i) => page(HISTORY_PAGE_LIMIT, RECENT - i * 250, "more")),
      },
    });
    const changes = await fetchWith(api, ["C1"], {
      cursor: cursorOf({ C1: { kind: "contiguous", ts: `${RECENT - 10_000}.000000` } }),
      maxEpisodes: 2 * HISTORY_PAGE_LIMIT,
    });

    expect(changes.coverageIncomplete).toBe(true);
    const mark = marksOf(changes.cursor).get("C1")!;
    expect(mark.kind).toBe("backfilling");
    // The frontier is untouched: the BOTTOM of the window is still unfetched.
    expect(mark.ts).toBe(`${RECENT - 10_000}.000000`);
    if (mark.kind !== "backfilling") throw new Error("expected a backfilling mark");
    expect(Number.parseFloat(mark.resume)).toBeLessThan(Number.parseFloat(mark.top));
  });

  it("resumes a truncated backfill downward, then advances to the recorded ceiling", async () => {
    const calls: SlackHistoryPageParams[] = [];
    const api = fakeApi({
      channels: { C1: channel() },
      pages: { C1: [{ messages: [message({ ts: `${RECENT - 500}.000000` })], nextCursor: null }] },
      calls,
    });
    const changes = await fetchWith(api, ["C1"], {
      cursor: cursorOf({
        C1: {
          kind: "backfilling",
          ts: `${RECENT - 1000}.000000`,
          top: `${RECENT}.000000`,
          resume: `${RECENT - 400}.000000`,
        },
      }),
    });

    expect(calls[0]?.latest).toBe(`${RECENT - 400}.000000`);
    expect(calls[0]?.oldest).toBe(`${RECENT - 1000}.000000`);

    const mark = marksOf(changes.cursor).get("C1")!;
    // Window complete → the frontier jumps to the ceiling the truncated pass
    // recorded, NOT to the newest message this pass happened to see, and NOT
    // to `now` (everything above `top` was never fetched).
    expect(mark).toEqual({ kind: "contiguous", ts: `${RECENT}.000000` });
  });

  it("fetches identically in reconciliation mode — the cadence is #4771's, not a re-crawl", async () => {
    // An earlier cut rewound every channel to the floor on a reconciliation.
    // Combined with "an incomplete pass holds the reconcile clock", that
    // re-walked the same week every cycle and could not converge.
    const calls: SlackHistoryPageParams[] = [];
    const api = fakeApi({ channels: { C1: channel() }, pages: {}, calls });
    await fetchWith(api, ["C1"], {
      mode: "reconciliation",
      cursor: cursorOf({ C1: { kind: "contiguous", ts: msToSlackTs(NOW.getTime() - 3600_000) } }),
    });
    expect(calls[0]?.oldest).toBe(msToSlackTs(NOW.getTime() - 3600_000));
  });

  it("makes forward progress across consecutive cycles instead of re-walking", async () => {
    // The convergence claim, driven for two cycles: cycle 2 is fed cycle 1's
    // cursor and must ask for a strictly narrower window.
    const calls: SlackHistoryPageParams[] = [];
    const api1 = fakeApi({
      channels: { C1: channel() },
      pages: {
        C1: [page(HISTORY_PAGE_LIMIT, RECENT, "more"), page(HISTORY_PAGE_LIMIT, RECENT - 250, "more")],
      },
      calls,
    });
    const first = await fetchWith(api1, ["C1"], {
      cursor: cursorOf({ C1: { kind: "contiguous", ts: `${RECENT - 10_000}.000000` } }),
      maxEpisodes: HISTORY_PAGE_LIMIT,
    });
    const firstMark = marksOf(first.cursor).get("C1")!;
    if (firstMark.kind !== "backfilling") throw new Error("expected truncation");

    const calls2: SlackHistoryPageParams[] = [];
    const api2 = fakeApi({ channels: { C1: channel() }, pages: {}, calls: calls2 });
    await fetchWith(api2, ["C1"], {
      cursor: first.cursor,
      maxEpisodes: HISTORY_PAGE_LIMIT,
    });
    // Cycle 2 resumes strictly below cycle 1's ceiling.
    expect(Number.parseFloat(calls2[0]!.latest!)).toBeLessThan(Number.parseFloat(firstMark.top));
  });
});

// ══════════════════════════════════════════════════════════════════
// Channel-set changes
// ══════════════════════════════════════════════════════════════════

describe("channel-set changes", () => {
  it("drops the mark of a channel removed from the config", async () => {
    const api = fakeApi({ channels: { C1: channel() }, pages: {} });
    const changes = await fetchWith(api, ["C1"], {
      cursor: cursorOf({
        C1: { kind: "contiguous", ts: "5.000000" },
        C2: { kind: "contiguous", ts: "6.000000" },
      }),
    });
    const marks = marksOf(changes.cursor);
    expect(marks.has("C2")).toBe(false);
    expect(marks.has("C1")).toBe(true);
  });

  it("starts a channel newly added to the config at the backfill floor", async () => {
    const calls: SlackHistoryPageParams[] = [];
    const api = fakeApi({
      channels: { C1: channel(), C2: channel({ id: "C2" }) },
      pages: {},
      calls,
    });
    await fetchWith(api, ["C1", "C2"], {
      cursor: cursorOf({ C1: { kind: "contiguous", ts: "1500.000000" } }),
    });
    expect(calls.find((c) => c.channel === "C1")?.oldest).toBe("1500.000000");
    expect(calls.find((c) => c.channel === "C2")?.oldest).toBe(
      msToSlackTs(NOW.getTime() - 7 * 86_400_000),
    );
  });

  it("reports a channel whose stored mark was unreadable", async () => {
    const api = fakeApi({ channels: { C1: channel() }, pages: {} });
    const changes = await fetchWith(api, ["C1"], {
      cursor: '{"v":1,"channels":{"C1":{"ts":""}}}',
    });
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.warnings?.join(" ")).toContain("unreadable sync mark");
  });
});

// ══════════════════════════════════════════════════════════════════
// Budget — the contract the engine refuses a batch over
// ══════════════════════════════════════════════════════════════════

describe("budget", () => {
  it("never returns more episodes than the budget, even mid-page", async () => {
    // The regression that made the source unusable on the 250-record plan
    // tiers: the walk used to check the budget only BETWEEN pages, so a
    // 250-budget returned 400 and the engine refused the whole batch — every
    // cycle, forever, because the error path leaves the cursor untouched.
    const api = fakeApi({
      channels: { C1: channel() },
      pages: {
        C1: [page(HISTORY_PAGE_LIMIT, RECENT, "more"), page(HISTORY_PAGE_LIMIT, RECENT - 250, "more")],
      },
    });
    const changes = await fetchWith(api, ["C1"], { maxEpisodes: 250 });
    expect(changes.episodes).toHaveLength(250);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("resumes exactly below the last WALKED message after a mid-page stop", async () => {
    const api = fakeApi({
      channels: { C1: channel() },
      pages: { C1: [page(HISTORY_PAGE_LIMIT, RECENT, "more")] },
    });
    const changes = await fetchWith(api, ["C1"], { maxEpisodes: 10 });
    const mark = marksOf(changes.cursor).get("C1")!;
    if (mark.kind !== "backfilling") throw new Error("expected truncation");
    // 10 walked, newest first → the last walked is RECENT − 9.
    expect(mark.resume).toBe(`${RECENT - 9}.000000`);
    expect(mark.top).toBe(`${RECENT}.000000`);
  });

  it("resumes below a SKIPPED message — `resume` tracks what was WALKED, not what was kept", async () => {
    // A channel deeper than the page cap whose messages are ALL noise. The pass
    // truncates on pages, having kept nothing.
    //
    // Tracking KEPT records instead would leave `coveredDownTo` null here, the
    // pair would be judged unresumable, the incoming mark would be preserved,
    // and the channel would re-walk the same 50 pages every cycle forever. The
    // distinction is invisible on the episode-budget path — there the last
    // walked message is also the last kept one — so this is the fixture that
    // separates them.
    const noisePage = (start: number) => ({
      messages: Array.from({ length: HISTORY_PAGE_LIMIT }, (_, i) =>
        message({ ts: `${start - i}.000000`, subtype: "channel_join" }),
      ),
      nextCursor: "more" as const,
    });
    const api = fakeApi({
      channels: { C1: channel() },
      pages: {
        C1: Array.from({ length: HISTORY_MAX_PAGES_PER_CHANNEL + 5 }, (_, p) =>
          noisePage(RECENT - p * HISTORY_PAGE_LIMIT),
        ),
      },
    });
    const changes = await fetchWith(api, ["C1"], {
      cursor: cursorOf({ C1: { kind: "contiguous", ts: `${RECENT - 1_000_000}.000000` } }),
      maxEpisodes: 5000,
    });

    // Nothing was worth keeping…
    expect(changes.episodes).toHaveLength(0);
    const mark = marksOf(changes.cursor).get("C1")!;
    // …and the pass STILL recorded where to resume, because it walked plenty.
    expect(mark.kind).toBe("backfilling");
    if (mark.kind !== "backfilling") throw new Error("expected a resumable backfill");
    expect(mark.top).toBe(`${RECENT}.000000`);
    expect(mark.resume).toBe(
      `${RECENT - HISTORY_MAX_PAGES_PER_CHANNEL * HISTORY_PAGE_LIMIT + 1}.000000`,
    );
  });

  it("splits the budget across channels without overshooting the total", async () => {
    const api = fakeApi({
      channels: { C1: channel(), C2: channel({ id: "C2" }) },
      pages: {
        C1: [page(HISTORY_PAGE_LIMIT, RECENT, "more")],
        C2: [page(HISTORY_PAGE_LIMIT, RECENT - 1000, "more")],
      },
    });
    const changes = await fetchWith(api, ["C1", "C2"], { maxEpisodes: 300 });
    // EXACT: C1 completes its 200, C2 truncates at the remaining 100. A
    // regression where C2 contributes nothing still satisfies `<= 300`.
    expect(changes.episodes).toHaveLength(300);
    expect(changes.coverageIncomplete).toBe(true);
    expect(marksOf(changes.cursor).size).toBe(2);
  });

  it("leaves an unread channel's mark untouched so nothing is silently passed over", async () => {
    const api = fakeApi({
      channels: { C1: channel(), C2: channel({ id: "C2" }) },
      pages: { C1: [page(HISTORY_PAGE_LIMIT, RECENT, "more")] },
    });
    const changes = await fetchWith(api, ["C1", "C2"], {
      cursor: cursorOf({ C2: { kind: "contiguous", ts: "77.000000" } }),
      maxEpisodes: HISTORY_PAGE_LIMIT,
    });
    expect(marksOf(changes.cursor).get("C2")).toEqual({ kind: "contiguous", ts: "77.000000" });
  });

  it("bounds vendor calls with a PAGE budget, which noise cannot evade", async () => {
    // A channel of pure join-noise keeps zero episodes, so it spends none of
    // `maxEpisodes` while spending a Slack call per page. Without a separate
    // page budget that is an unbounded walk on a Tier-3 method.
    const calls: SlackHistoryPageParams[] = [];
    const noise = () => ({
      messages: Array.from({ length: HISTORY_PAGE_LIMIT }, (_, i) =>
        message({ ts: `${9000 - i}.000000`, subtype: "channel_join" }),
      ),
      nextCursor: "more" as const,
    });
    const api = fakeApi({
      channels: Object.fromEntries(
        ["C1", "C2", "C3"].map((id) => [id, channel({ id })]),
      ),
      pages: Object.fromEntries(
        ["C1", "C2", "C3"].map((id) => [id, Array.from({ length: 200 }, noise)]),
      ),
      calls,
    });
    const changes = await fetchWith(api, ["C1", "C2", "C3"], { maxEpisodes: 5000 });
    expect(changes.episodes).toHaveLength(0);
    expect(calls.length).toBeLessThanOrEqual(HISTORY_MAX_PAGES_PER_PASS);
    expect(changes.warnings?.join(" ")).toContain("stored none");
  });

  it("caps one channel's walk so it cannot hog the whole pass", async () => {
    const calls: SlackHistoryPageParams[] = [];
    const api = fakeApi({
      channels: { C1: channel() },
      pages: {
        C1: Array.from({ length: 200 }, (_, i) => page(1, 9000 - i, "more")),
      },
      calls,
    });
    await fetchWith(api, ["C1"], { maxEpisodes: 5000 });
    expect(calls.length).toBeLessThanOrEqual(HISTORY_MAX_PAGES_PER_CHANNEL);
  });

  it("KEEPS an in-flight backfill pair when a pass cannot resume", async () => {
    // The non-convergence case. A pass that covers nothing resumable must not
    // degrade a `backfilling` mark to `contiguous`: doing so discards a window
    // whose bottom is unfetched, and since the next pass then walks from `now`,
    // hits the same obstacle and degrades again, it is a fixed point rather
    // than a delay — the channel never converges and burns the shared budget
    // forever trying.
    const api = fakeApi({
      channels: { C1: channel() },
      // First page is entirely unidentifiable, so nothing is covered and there
      // is no `resume` to record from this pass.
      pages: { C1: [{ messages: [], nextCursor: "more" }] },
      dropped: { C1: 3 },
    });
    const before = {
      kind: "backfilling" as const,
      ts: `${RECENT - 1000}.000000`,
      top: `${RECENT}.000000`,
      resume: `${RECENT - 400}.000000`,
    };
    const changes = await fetchWith(api, ["C1"], { cursor: cursorOf({ C1: before }) });
    expect(changes.coverageIncomplete).toBe(true);
    expect(marksOf(changes.cursor).get("C1")).toEqual(before);
  });

  it("stops rather than marking a window covered when Slack returns unidentifiable messages", async () => {
    // Those entries sit INSIDE the window this pass would otherwise mark
    // covered, so advancing past them would be the silent skip the walk exists
    // to prevent.
    const api = fakeApi({
      channels: { C1: channel() },
      pages: { C1: [{ messages: [message({ ts: "5.000001" })], nextCursor: null }] },
      dropped: { C1: 3 },
    });
    const changes = await fetchWith(api, ["C1"], {
      cursor: cursorOf({ C1: { kind: "contiguous", ts: "1.000000" } }),
    });
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.warnings?.join(" ")).toContain("no usable identity");
    expect(marksOf(changes.cursor).get("C1")?.ts).toBe("1.000000");
  });
});

// ══════════════════════════════════════════════════════════════════
// Failure isolation
// ══════════════════════════════════════════════════════════════════

describe("failures", () => {
  it("isolates a per-channel failure instead of failing the whole pass", async () => {
    const api = fakeApi({
      channels: { C2: channel({ id: "C2" }) },
      pages: { C2: [{ messages: [message({ ts: "5.000001" })], nextCursor: null }] },
      onInfo: (channelId) =>
        channelId === "C1"
          ? Promise.resolve({ ok: false as const, error: "not_in_channel", retryAfterSeconds: null })
          : undefined,
    });
    const changes = await fetchWith(api, ["C1", "C2"]);
    expect(changes.episodes).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.warnings?.join(" ")).toContain("invite the Atlas bot");
  });

  it("propagates a rate limit when there is nothing banked, so the engine backs off", async () => {
    const api = fakeApi({
      onInfo: () => Promise.resolve({ ok: false as const, error: "ratelimited", retryAfterSeconds: 30 }),
    });
    await expect(fetchWith(api, ["C1"])).rejects.toBeInstanceOf(ConnectorRateLimitError);
  });

  it("BANKS partial progress when a rate limit hits mid-pass", async () => {
    // Throwing here would discard the episodes and marks the earlier channels
    // already earned — and because a throttled multi-channel crawl is the
    // steady state rather than an exception, the same prefix would be re-walked
    // and re-lost every cycle, starving every channel after it forever.
    const api = fakeApi({
      channels: { C1: channel() },
      pages: { C1: [{ messages: [message({ ts: "5.000001" })], nextCursor: null }] },
      onInfo: (channelId) =>
        channelId === "C2"
          ? Promise.resolve({ ok: false as const, error: "ratelimited", retryAfterSeconds: 30 })
          : undefined,
    });
    const changes = await fetchWith(api, ["C1", "C2", "C3"], {
      cursor: cursorOf({ C3: { kind: "contiguous", ts: "77.000000" } }),
    });
    expect(changes.episodes).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.warnings?.join(" ")).toContain("rate limiting");
    expect(marksOf(changes.cursor).has("C1")).toBe(true);
    // The pass STOPPED at the throttled channel — C3 was never probed, so it
    // contributes no warning. Without this, deleting the `break` still passes.
    expect(changes.warnings?.join(" ")).not.toContain("C3");
    // …and C3's existing mark survived. Reconstructing the cursor from only the
    // channels this pass VISITED would silently delete it, restarting C3 at the
    // backfill floor — a forward jump over history nothing re-fetches.
    expect(marksOf(changes.cursor).get("C3")).toEqual({ kind: "contiguous", ts: "77.000000" });
  });

  it("keeps the mark of a channel the pass never reached", async () => {
    // Same invariant as above, reached through the budget path instead of the
    // throttle path: whichever way a pass ends early, an unvisited channel must
    // not lose its place.
    const api = fakeApi({
      channels: { C1: channel() },
      pages: { C1: [page(HISTORY_PAGE_LIMIT, RECENT, "more")] },
    });
    const changes = await fetchWith(api, ["C1", "C2"], {
      cursor: cursorOf({
        C2: { kind: "backfilling", ts: "10.000000", top: "90.000000", resume: "50.000000" },
      }),
      maxEpisodes: HISTORY_PAGE_LIMIT,
    });
    expect(marksOf(changes.cursor).get("C2")).toEqual({
      kind: "backfilling",
      ts: "10.000000",
      top: "90.000000",
      resume: "50.000000",
    });
  });

  it("surfaces a missing history scope as an actionable reconnect message", async () => {
    const api = fakeApi({
      onInfo: () => Promise.resolve({ ok: false as const, error: "missing_scope", retryAfterSeconds: null }),
    });
    const changes = await fetchWith(api, ["C1"]);
    expect(changes.warnings?.join(" ")).toContain("channels:history");
  });

  it("names the fix for a revoked token rather than echoing the raw code", async () => {
    const api = fakeApi({
      onInfo: () => Promise.resolve({ ok: false as const, error: "token_revoked", retryAfterSeconds: null }),
    });
    const changes = await fetchWith(api, ["C1"]);
    expect(changes.warnings?.join(" ")).toContain("reconnect Slack");
  });

  it("reports no high-water mark when coverage was incomplete", async () => {
    // The interface requires the mark to cover only the CONTIGUOUS part of the
    // window; a truncated pass's newest episode is the top of a window whose
    // bottom is unfetched. Null is lossless — the state upsert COALESCEs.
    const api = fakeApi({
      channels: { C1: channel() },
      pages: { C1: [page(HISTORY_PAGE_LIMIT, RECENT, "more")] },
    });
    const changes = await fetchWith(api, ["C1"], { maxEpisodes: 10 });
    expect(changes.highWaterMark).toBeNull();
  });

  it("reports the newest covered event time on a complete pass", async () => {
    const api = fakeApi({
      channels: { C1: channel() },
      pages: {
        C1: [
          {
            messages: [message({ ts: "1750000000.000100" }), message({ ts: "1740000000.000100" })],
            nextCursor: null,
          },
        ],
      },
    });
    const changes = await fetchWith(api, ["C1"]);
    expect(changes.highWaterMark).toBe(new Date(1750000000000.1).toISOString());
  });
});

// ══════════════════════════════════════════════════════════════════
// The property the whole cursor design exists for
// ══════════════════════════════════════════════════════════════════

describe("gaplessness across cycles (end to end)", () => {
  it("collects EVERY message across a budget-limited multi-cycle walk", async () => {
    // The one test that would have caught the round-1 overshoot by
    // CONSTRUCTION rather than by fixture inspection: script a channel with N
    // messages, run cycles at a quarter of that budget, and assert the union of
    // everything ingested equals the full set — and that it terminates.
    const TOTAL = 400;
    const all = Array.from({ length: TOTAL }, (_, i) =>
      message({ ts: `${RECENT - i}.000000` }),
    );
    /** Serve `[oldest, latest]` from the full set, newest-first, 200 per page. */
    function windowApi(calls: SlackHistoryPageParams[]): SlackHistoryApi {
      const cursors = new Map<string, number>();
      return {
        async getConversationInfo() {
          return { ok: true, channel: channel() };
        },
        async fetchConversationHistoryPage(_token, params) {
          calls.push(params);
          const oldest = Number.parseFloat(params.oldest ?? "0");
          const latest = params.latest === undefined ? Infinity : Number.parseFloat(params.latest);
          const inWindow = all.filter((m) => {
            const ts = Number.parseFloat(m.ts);
            return ts > oldest && ts <= latest;
          });
          const offset = params.cursor === undefined ? 0 : (cursors.get(params.cursor) ?? 0);
          const slice = inWindow.slice(offset, offset + HISTORY_PAGE_LIMIT);
          const nextOffset = offset + slice.length;
          const more = nextOffset < inWindow.length;
          const nextCursor = more ? `off:${nextOffset}:${oldest}:${latest}` : null;
          if (nextCursor !== null) cursors.set(nextCursor, nextOffset);
          return { ok: true, messages: slice, nextCursor, dropped: 0 };
        },
      };
    }

    const seen = new Set<string>();
    let cursor: string | null = cursorOf({
      C1: { kind: "contiguous", ts: `${RECENT - TOTAL}.000000` },
    });
    let cycles = 0;
    for (; cycles < 20; cycles++) {
      const calls: SlackHistoryPageParams[] = [];
      const changes = await fetchWith(windowApi(calls), ["C1"], {
        cursor,
        maxEpisodes: TOTAL / 4,
      });
      // The budget is a HARD contract every cycle, not just at the end: without
      // this the loop passes even with the round-1 between-pages-only check,
      // because an over-budget cycle still terminates and still covers the set.
      expect(changes.episodes.length).toBeLessThanOrEqual(TOTAL / 4);
      for (const e of changes.episodes) seen.add(e.sourceId);
      cursor = changes.cursor ?? null;
      if (!changes.coverageIncomplete) break;
    }

    // Terminated…
    expect(cycles).toBeLessThan(20);
    // …and lost nothing.
    expect(seen.size).toBe(TOTAL);
    for (const m of all) expect(seen.has(`C1:${m.ts}`)).toBe(true);
    // …and settled on a contiguous mark, so steady state is cheap.
    expect(marksOf(cursor).get("C1")?.kind).toBe("contiguous");
  });

  it("rotates the starting channel so a busy first channel cannot starve the rest", async () => {
    // Static order + one shared budget is deterministic starvation: on the
    // 250-record tiers one busy channel takes the whole cap every cycle and the
    // channels after it are never read — not slowly, never.
    const busy = () => [page(HISTORY_PAGE_LIMIT, RECENT, "more")];
    const api = fakeApi({
      channels: Object.fromEntries(["C1", "C2"].map((id) => [id, channel({ id })])),
      pages: { C1: busy(), C2: busy() },
    });
    const first = await fetchWith(api, ["C1", "C2"], { maxEpisodes: HISTORY_PAGE_LIMIT });
    expect(first.warnings?.join(" ")).toContain("C2");

    const calls: SlackHistoryPageParams[] = [];
    const api2 = fakeApi({
      channels: Object.fromEntries(["C1", "C2"].map((id) => [id, channel({ id })])),
      pages: { C1: busy(), C2: busy() },
      calls,
    });
    await fetchWith(api2, ["C1", "C2"], {
      cursor: first.cursor,
      maxEpisodes: HISTORY_PAGE_LIMIT,
    });
    // Cycle 2 starts where cycle 1 stopped, so C2 is read first this time.
    expect(calls[0]?.channel).toBe("C2");
  });

  it("names the budget that actually ran out", async () => {
    // Blaming the record cap when the PAGE budget bound sends the operator to
    // raise a plan limit that was never the constraint.
    const noise = () => ({
      messages: Array.from({ length: HISTORY_PAGE_LIMIT }, (_, i) =>
        message({ ts: `${RECENT - i}.000000`, subtype: "channel_join" }),
      ),
      nextCursor: "more" as const,
    });
    const ids = ["C1", "C2", "C3", "C4"];
    const api = fakeApi({
      channels: Object.fromEntries(ids.map((id) => [id, channel({ id })])),
      pages: Object.fromEntries(ids.map((id) => [id, Array.from({ length: 200 }, noise)])),
    });
    const changes = await fetchWith(api, ids, { maxEpisodes: 5000 });
    const text = changes.warnings?.join(" ") ?? "";
    expect(text).toContain("page budget");
    expect(text).not.toContain("record budget");
  });
});
