/**
 * The Slack chat webhook fast-path's DECISION half (#4967, ADR-0036 §T6).
 *
 * The slice's whole safety argument is that the webhook writer and the poll
 * writer mint the SAME source-id for the same message, so a message delivered
 * both ways collapses to one episode. This file pins that as a PARITY property
 * — the two writers' outputs compared against each other — rather than as a
 * golden string, because a golden string agrees with a webhook writer that has
 * drifted from the poll just as happily as with one that has not.
 *
 * Everything here runs against `deriveSlackWebhookEpisode`, which is the same
 * decision the shell makes and has no I/O in it. The rows-in-Postgres half
 * (both writers colliding, and the corroboration inflation that duplication
 * would cause) is `slack-webhook-pg.test.ts` — those are claims only a live
 * schema can settle.
 *
 * The negative direction is what most of these assert. "The webhook stored the
 * message" is cheap and proves little; "the webhook refused to store a message
 * whose channel visibility it could not establish, and did NOT fall back to a
 * wider grant" is the one that would have caught a leak.
 */

import { describe, expect, it } from "bun:test";
import { SLACK_SOURCE } from "@atlas/api/lib/brain/sources";
import { ORG_PRINCIPAL } from "@atlas/api/lib/brain/acl";
import { deriveChatChannelGrant } from "@atlas/api/lib/brain/ingest/grant";
import type { BrainSourceConnector } from "@atlas/api/lib/brain/ingest/types";
import { toEpisode } from "@atlas/api/lib/brain/ingest/slack/client";
import {
  SLACK_HISTORY_CATALOG_ID,
  slackEpisodeSourceId,
} from "@atlas/api/lib/brain/ingest/slack/config";
import {
  deriveSlackWebhookEpisode,
  readSlackWebhookMessage,
  resolveWebhookChannelVisibility,
  type SlackWebhookInstall,
  type SlackWebhookMessageEvent,
} from "@atlas/api/lib/brain/ingest/slack/webhook";

const CHANNEL = "C01ABCDEF";
const PRIVATE_CHANNEL = "G01PRIVATE";
const TS = "1750000000.000100";

/** The registered Slack brain source, as the writer sees it in the registry. */
const CONNECTOR: BrainSourceConnector<typeof SLACK_SOURCE> = {
  catalogId: SLACK_HISTORY_CATALOG_ID,
  source: SLACK_SOURCE,
  audience: { kind: "externally-synced" },
  createClient() {
    throw new Error("the webhook path never builds a vendor client");
  },
};

function install(channels: readonly string[], overrides: Partial<SlackWebhookInstall> = {}): SlackWebhookInstall {
  return {
    installId: "install-1",
    catalogId: SLACK_HISTORY_CATALOG_ID,
    config: { channels },
    ...overrides,
  };
}

/** A plain `message.channels` event, as Slack's Events API delivers it. */
function rawMessageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    channel: CHANNEL,
    channel_type: "channel",
    user: "U123",
    text: "the deploy window is Thursdays",
    ts: TS,
    // Slack sends both. `event_ts` is when the EVENT was dispatched, never the
    // message's identity — see the test that pins it below.
    event_ts: "1750000000.000999",
    team_id: "T0ABC",
    ...overrides,
  };
}

function eventOf(overrides: Record<string, unknown> = {}): SlackWebhookMessageEvent {
  return readMessage(rawMessageEvent(overrides));
}

/**
 * Parse a payload and INSIST it produced a message.
 *
 * Throws rather than falling back, and that is load-bearing: an earlier cut of
 * this file wrote `readSlackWebhookMessage(...) ?? eventOf()` at the edit-parity
 * assertion, and the fallback's source-id is by construction equal to the value
 * that assertion compares against — so a parser that stopped recognising
 * `message_changed` entirely would have passed it.
 */
function readMessage(raw: unknown): SlackWebhookMessageEvent {
  const read = readSlackWebhookMessage(raw);
  if (read.kind !== "message") {
    throw new Error(`expected a parsed message, got skipped: ${read.reason}`);
  }
  return read.event;
}

function derive(
  event: SlackWebhookMessageEvent,
  installs: readonly SlackWebhookInstall[] = [install([CHANNEL])],
) {
  return deriveSlackWebhookEpisode({ event, connectors: [CONNECTOR], installs });
}

// ---------------------------------------------------------------------------
// The source-id contract — acceptance criterion 1
// ---------------------------------------------------------------------------

describe("source-id parity between the webhook and the poll", () => {
  it("mints the id the poll would mint for the same message", () => {
    const derived = derive(eventOf());
    expect(derived.kind).toBe("episode");
    if (derived.kind !== "episode") return;

    // The poll's own converter, fed the record its page walk produces for this
    // message. Comparing the two writers' OUTPUTS rather than comparing one of
    // them to a literal is the point: a literal would pass for a webhook writer
    // that had drifted from the poll in the same direction.
    const grant = deriveChatChannelGrant({
      source: SLACK_SOURCE,
      channelId: CHANNEL,
      isPrivate: false,
    });
    expect(grant).not.toBeNull();
    const polled = toEpisode(
      CHANNEL,
      { ts: TS, text: "the deploy window is Thursdays", user: "U123", subtype: null, botId: null },
      grant ?? [],
    );

    expect(polled).not.toBeNull();
    expect(derived.record.sourceId).toBe(polled?.sourceId ?? "<poll produced nothing>");
    // And the id is the documented contract, so a change to BOTH writers at
    // once still has to be deliberate.
    expect(derived.record.sourceId).toBe(slackEpisodeSourceId(CHANNEL, TS));
  });

  it("keys a thread REPLY on its own ts, not on its parent's", () => {
    // `thread_ts` is the parent. Keying on it would collapse every reply in a
    // thread onto the parent's episode — one message stored, the rest silently
    // dropped by the dedupe.
    const replyTs = "1750000500.000200";
    const derived = derive(eventOf({ ts: replyTs, thread_ts: TS }));
    expect(derived.kind).toBe("episode");
    if (derived.kind !== "episode") return;
    expect(derived.record.sourceId).toBe(slackEpisodeSourceId(CHANNEL, replyTs));
    expect(derived.record.sourceId).not.toContain(TS);
  });

  it("channel-scopes the id, so one ts in two channels is two episodes", () => {
    const a = derive(eventOf({ channel: CHANNEL }), [install([CHANNEL, "C09OTHER"])]);
    const b = derive(eventOf({ channel: "C09OTHER" }), [install([CHANNEL, "C09OTHER"])]);
    expect(a.kind).toBe("episode");
    expect(b.kind).toBe("episode");
    if (a.kind !== "episode" || b.kind !== "episode") return;
    expect(a.record.sourceId).not.toBe(b.record.sourceId);
  });

  it("normalises the channel id the way the install config does", () => {
    // The poll builds its ids from the PARSED config channels, which
    // `parseSlackHistoryConfig` uppercases. An un-normalised event id would
    // mint `c01abcdef:<ts>` against the poll's `C01ABCDEF:<ts>` — the exact
    // silent duplication this slice exists to prevent, and invisible on a
    // vendor that happens to send uppercase today.
    const derived = derive(eventOf({ channel: CHANNEL.toLowerCase() }));
    expect(derived.kind).toBe("episode");
    if (derived.kind !== "episode") return;
    expect(derived.record.sourceId).toBe(slackEpisodeSourceId(CHANNEL, TS));
  });
});

// ---------------------------------------------------------------------------
// Field paths — the trap `config.ts`'s header enumerates
// ---------------------------------------------------------------------------

describe("readSlackWebhookMessage: which field the ts comes from", () => {
  it("reads a plain message's own top-level ts", () => {
    expect(readMessage(rawMessageEvent()).ts).toBe(TS);
  });

  it("never reads event_ts, which sits beside ts and is a different thing", () => {
    // `event_ts` is when Slack DISPATCHED the event; `ts` is the message. They
    // are adjacent fields of the same object with the same shape, so confusing
    // them is a silent, plausible mistake — and one the poll can never make,
    // because `conversations.history` has no such field. A writer that read it
    // would mint an id the poll never mints, duplicating every message.
    const parsed = readMessage(rawMessageEvent());
    expect(parsed.ts).toBe(TS);
    expect(parsed.ts).not.toBe("1750000000.000999");
  });

  it("reads message_changed from the INNER message, never the event or the edit", () => {
    // Three different timestamps are in play and only one is the message's
    // identity. `event.ts` is when the EDIT was delivered and
    // `message.edited.ts` is when the edit was made; either would mint a fresh
    // id for a message already stored and duplicate every edited message.
    const parsed = readMessage({
      type: "message",
      subtype: "message_changed",
      channel: CHANNEL,
      channel_type: "channel",
      ts: "1750009999.000999",
      team_id: "T0ABC",
      message: {
        ts: TS,
        user: "U123",
        text: "the deploy window is Wednesdays",
        edited: { user: "U123", ts: "1750008888.000888" },
      },
    });
    expect(parsed.ts).toBe(TS);
    expect(parsed.text).toBe("the deploy window is Wednesdays");
    // The envelope's subtype is the ENVELOPE's, not the message's — passing it
    // through would make the record look like a subtype the poll never sees.
    expect(parsed.subtype).toBeNull();
  });

  it("keeps the INNER message's own subtype on an edit", () => {
    const parsed = readMessage({
      type: "message",
      subtype: "message_changed",
      channel: CHANNEL,
      channel_type: "channel",
      ts: "1750009999.000999",
      message: { ts: TS, text: "hi", user: "U1", subtype: "thread_broadcast" },
    });
    expect(parsed.subtype).toBe("thread_broadcast");
  });

  it("an edited message derives the SAME source-id as the original", () => {
    // The consequence of the field-path rule, stated as behaviour: an edit is
    // not new evidence for this source (`slack/config.ts`), so it must collapse
    // onto the stored episode rather than mint a second one.
    const original = derive(eventOf());
    const edited = deriveSlackWebhookEpisode({
      // `readMessage` THROWS if the payload stopped parsing. An earlier cut
      // wrote `?? eventOf()` here, whose source-id is by construction the value
      // the assertion below compares against — so a parser that stopped
      // recognising `message_changed` at all would have passed.
      event: readMessage({
        type: "message",
        subtype: "message_changed",
        channel: CHANNEL,
        channel_type: "channel",
        ts: "1750009999.000999",
        message: { ts: TS, user: "U123", text: "corrected", edited: { ts: "1750008888.1" } },
      }),
      connectors: [CONNECTOR],
      installs: [install([CHANNEL])],
    });
    expect(original.kind).toBe("episode");
    expect(edited.kind).toBe("episode");
    if (original.kind !== "episode" || edited.kind !== "episode") return;
    expect(edited.record.sourceId).toBe(original.record.sourceId);
  });

  it("refuses an app_mention, which is a second delivery of the same ts", () => {
    // Both `app_mention` and `message.channels` are subscribed (#4909), so a
    // mention arrives twice carrying one ts. Admitting both would be harmless
    // for the dedupe and double this path's work for every mention.
    expect(readSlackWebhookMessage(rawMessageEvent({ type: "app_mention" }))).toEqual({
      kind: "skipped",
      reason: "not_a_message",
    });
  });

  it("refuses a payload with no channel or no ts", () => {
    const unparseable = { kind: "skipped", reason: "unparseable_event" } as const;
    expect(readSlackWebhookMessage(rawMessageEvent({ channel: undefined }))).toEqual(unparseable);
    expect(readSlackWebhookMessage(rawMessageEvent({ ts: undefined }))).toEqual(unparseable);
    expect(readSlackWebhookMessage(null)).toEqual(unparseable);
    expect(readSlackWebhookMessage("not an object")).toEqual(unparseable);
    expect(readSlackWebhookMessage([])).toEqual(unparseable);
  });

  it("accepts either team_id or the older team alias", () => {
    expect(readMessage(rawMessageEvent()).teamId).toBe("T0ABC");
    expect(readMessage(rawMessageEvent({ team_id: undefined, team: "T0XYZ" })).teamId).toBe("T0XYZ");
    expect(
      readMessage(rawMessageEvent({ team_id: undefined, team: undefined })).teamId,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Visibility → grant. The block-vs-flag asymmetry.
// ---------------------------------------------------------------------------

describe("subtypes whose ts is the EVENT's, not the message's", () => {
  it("⭐ refuses message_deleted rather than minting from the event's own ts", () => {
    // `message_changed` is recoverable — the original id is at
    // `event.message.ts`, which the parser unwraps. `message_deleted` carries no
    // inner message, so its top-level `ts` is the EVENT's timestamp: an id the
    // poll never mints. Storing on it would create a duplicate episode that no
    // later pass converges, because `brain_episodes` is append-only.
    //
    // It survived before this guard only by ACCIDENT — no `text`, so the
    // empty-text skip inside `toEpisode` caught it. A payload that ever carried
    // text would have minted a novel id with nothing to stop it.
    //
    // MUTATION THIS CATCHES: removing the subtype guard. Note the fixture gives
    // it TEXT, which is what makes this test fail without the guard rather than
    // pass through the accidental noise skip.
    expect(
      readSlackWebhookMessage(
        rawMessageEvent({ subtype: "message_deleted", text: "still here", ts: "1750000900.000777" }),
      ),
    ).toEqual({ kind: "skipped", reason: "unmintable_subtype" });
  });

  it("refuses a tombstone for the same reason", () => {
    expect(
      readSlackWebhookMessage(rawMessageEvent({ subtype: "tombstone", text: "x" })),
    ).toEqual({ kind: "skipped", reason: "unmintable_subtype" });
  });

  it("still ACCEPTS message_changed — that one is unwrapped, not refused", () => {
    // The guard must not over-reach: an edit collapses onto the stored episode
    // by design, and refusing it would lose the one subtype the fast path
    // handles deliberately.
    const parsed = readMessage(
      rawMessageEvent({
        subtype: "message_changed",
        message: { ts: TS, text: "edited", user: "U123" },
        ts: "1750000900.000999",
      }),
    );
    expect(parsed.ts).toBe(TS);
  });
});

describe("resolveWebhookChannelVisibility", () => {
  it("maps Slack's own channel_type, and blocks everything it does not recognise", () => {
    expect(resolveWebhookChannelVisibility("channel", CHANNEL)).toEqual({ isPrivate: false });
    expect(resolveWebhookChannelVisibility("group", PRIVATE_CHANNEL)).toEqual({ isPrivate: true });
    expect(resolveWebhookChannelVisibility("mpim", PRIVATE_CHANNEL)).toEqual({ isPrivate: true });
    // A 1:1 DM is not an admissible channel for this source at all.
    expect(resolveWebhookChannelVisibility("im", "D01USER")).toBeNull();
    expect(resolveWebhookChannelVisibility(null, CHANNEL)).toBeNull();
    expect(resolveWebhookChannelVisibility("something_slack_added_later", CHANNEL)).toBeNull();
  });

  it("normalises the id itself rather than trusting the caller", () => {
    // The function is EXPORTED and the `G…` test guards the arm that mints the
    // ORG-WIDE grant, so a lowercase id from any future caller must not slip
    // past it. A precondition established in `readSlackWebhookMessage` is not
    // one this function can rely on when being wrong publishes a private
    // channel.
    expect(resolveWebhookChannelVisibility("channel", "g01legacy")).toBeNull();
    expect(resolveWebhookChannelVisibility("channel", "  G01LEGACY  ")).toBeNull();
    expect(resolveWebhookChannelVisibility("channel", "c01public")).toEqual({ isPrivate: false });
  });

  it("blocks a G-id claiming to be public, and does NOT block a C-id claiming to be private", () => {
    // The guard is one-directional on purpose. `G…` + public is Slack
    // contradicting itself on the arm that would mint the ORG-WIDE grant, so
    // blocking is free. The reverse — a modern `C…` private channel — is
    // ordinary and must not be blocked, which is why there is no symmetric
    // check.
    expect(resolveWebhookChannelVisibility("channel", PRIVATE_CHANNEL)).toBeNull();
    expect(resolveWebhookChannelVisibility("group", "C01MODERNPRIV")).toEqual({ isPrivate: true });
  });
});

describe("grant derivation matches the poll's", () => {
  it("gives a public channel the explicit org principal", () => {
    const derived = derive(eventOf());
    if (derived.kind !== "episode") throw new Error("expected an episode");
    expect(derived.record.visibleTo).toEqual([ORG_PRINCIPAL]);
    expect(derived.record.visibleTo).toEqual(
      deriveChatChannelGrant({ source: SLACK_SOURCE, channelId: CHANNEL, isPrivate: false }) ?? [],
    );
  });

  it("gives a private channel the SAME audience token the poll derives", () => {
    // Not merely "an audience token": the audience-membership sync (#4801)
    // resolves the very id `deriveChatChannelGrant` mints, so a webhook that
    // derived its own would write episodes granted to an audience nothing syncs
    // members into — invisible to everyone, and repairable only by rewriting
    // stored rows.
    const derived = derive(
      eventOf({ channel: PRIVATE_CHANNEL, channel_type: "group" }),
      [install([PRIVATE_CHANNEL])],
    );
    if (derived.kind !== "episode") throw new Error("expected an episode");
    expect(derived.record.visibleTo).toEqual(
      deriveChatChannelGrant({
        source: SLACK_SOURCE,
        channelId: PRIVATE_CHANNEL,
        isPrivate: true,
      }) ?? [],
    );
    expect(derived.record.visibleTo).not.toEqual([ORG_PRINCIPAL]);
  });

  it("BLOCKS rather than widening when visibility cannot be established", () => {
    // The failure this arm exists for: an episode's grant is frozen at insert
    // and `ON CONFLICT DO NOTHING` means the poll's later, correct grant never
    // replaces it. So guessing `org` here would publish a private channel's
    // contents org-wide permanently. Nothing is derived at all.
    const derived = derive(
      eventOf({ channel: PRIVATE_CHANNEL, channel_type: undefined }),
      [install([PRIVATE_CHANNEL])],
    );
    expect(derived).toEqual({ kind: "skipped", reason: "unresolvable_visibility" });
  });
});

// ---------------------------------------------------------------------------
// Skip rules — the poll's, reached through the poll's converter
// ---------------------------------------------------------------------------

describe("what the fast path declines to store", () => {
  it("skips bot/app messages, so the brain never cites itself", () => {
    expect(derive(eventOf({ bot_id: "B0ATLAS", user: undefined }))).toEqual({
      kind: "skipped",
      reason: "noise",
    });
  });

  it("skips channel-membership noise by the poll's denylist", () => {
    expect(derive(eventOf({ subtype: "channel_join", text: "<@U1> has joined" }))).toEqual({
      kind: "skipped",
      reason: "noise",
    });
  });

  it("skips a message with no text", () => {
    expect(derive(eventOf({ text: "   " }))).toEqual({ kind: "skipped", reason: "noise" });
  });

  it("does NOT skip an unknown subtype — an unknown one probably carries content", () => {
    const derived = derive(eventOf({ subtype: "file_share" }));
    expect(derived.kind).toBe("episode");
  });
});

// ---------------------------------------------------------------------------
// Install scoping — Slack delivers more than the admin configured
// ---------------------------------------------------------------------------

describe("configured-channel scoping", () => {
  it("refuses a channel the install did not configure", () => {
    // Slack delivers events for every channel the bot is in, which is strictly
    // wider than the channels an admin picked. Storing outside that set ingests
    // content the workspace never consented to — and the poll never would, so
    // the two writers' contents would diverge by construction.
    expect(derive(eventOf({ channel: "C09UNSCOPED" }))).toEqual({
      kind: "skipped",
      reason: "channel_not_configured",
    });
  });

  it("⭐ does not blame a DIFFERENT catalog id's install for failing a schema that is not its own", () => {
    // `findBrainSourceConnectors` returns an ARRAY and `ingest/types.ts`
    // explicitly disclaims uniqueness, so a second chat-vendor brain source
    // would put foreign installs in this list. Parsing those with
    // `parseSlackHistoryConfig` — a schema that is not theirs — reported
    // `install_config_unreadable` for a config that is perfectly valid for its
    // own connector, sending an admin to fix a row that was never broken.
    //
    // Latent today (one catalog id maps to the slack vendor), which is exactly
    // why it needs pinning: nothing else would notice the day that changes.
    //
    // The distinction under test is the REASON, not the refusal. Both outcomes
    // decline to store; only one of them tells the admin to go repair a healthy
    // row.
    //
    // ⚠️ The fixture below is one the production shell CAN produce, and that is
    // the point. An earlier version of this guard tested "is this install's
    // catalog id one of the connectors we resolved" and was pinned with a
    // catalog id outside that set — which the shell cannot emit, because it
    // queries BY those ids. The test passed and the guard defended nothing: the
    // real foreign row, belonging to a second slack-vendor source, IS in the
    // resolved set and was still blamed. So this fixture uses a foreign catalog
    // id that the vendor lookup WOULD return.
    //
    // MUTATION THIS CATCHES: dropping the `!== SLACK_HISTORY_CATALOG_ID` guard,
    // or restoring the `ownCatalogIds` form of it.
    const foreign = install([CHANNEL], {
      installId: "install-foreign",
      // A second slack-vendor brain source: resolved alongside slack-history,
      // so its rows reach here, and its config is not slack-history's schema.
      catalogId: "catalog:some-other-chat-source",
      config: { rooms: [CHANNEL] },
    });
    expect(derive(eventOf(), [foreign])).toEqual({
      kind: "skipped",
      reason: "channel_not_configured",
    });
  });

  it("still reports install_config_unreadable for OUR OWN unparseable install", () => {
    // The guard above must not silence the diagnosis it was narrowing. A
    // hand-edited slack-history row is a real misconfiguration and has to stay
    // distinguishable from ordinary out-of-scope traffic.
    expect(
      derive(eventOf(), [install([CHANNEL], { config: { channels: "not-a-list" } })]),
    ).toEqual({ kind: "skipped", reason: "install_config_unreadable" });
  });

  it("matches the install whose scope covers the channel when several are installed", () => {
    const derived = derive(eventOf(), [
      install(["C09OTHER"], { installId: "install-other" }),
      install([CHANNEL], { installId: "install-target" }),
    ]);
    if (derived.kind !== "episode") throw new Error("expected an episode");
    expect(derived.installId).toBe("install-target");
  });

  it("reports an unreadable install config as ITS OWN reason, not as out-of-scope", () => {
    // `parseSlackHistoryConfig` refuses rather than narrowing silently, and the
    // refusal has to survive out to here — an install whose config was edited
    // out of band must not fall through to "no scope, store everything".
    //
    // And it must not be reported as `channel_not_configured` either. That code
    // means "Slack delivered more than the admin asked for", which is ordinary
    // traffic; this means "the admin's own scope is unreadable", which silently
    // drops 100% of a workspace's messages until someone re-installs. One is
    // noise, the other is an incident, and a counter that merges them reports
    // the incident as noise.
    expect(derive(eventOf(), [install([], { config: { channels: "not-an-array" } })])).toEqual({
      kind: "skipped",
      reason: "install_config_unreadable",
    });
    expect(derive(eventOf(), [install([], { config: null })])).toEqual({
      kind: "skipped",
      reason: "install_config_unreadable",
    });
  });

  it("prefers the unreadable-config reason when a healthy install also misses", () => {
    // The two conditions coexist: one install is corrupt, another is fine but
    // does not cover this channel. Precedence is pinned so it is a decision
    // rather than an accident of `find` ordering — the corrupt install is a
    // genuine reason this workspace may be dropping messages it should store,
    // and that outranks "Slack sent us a channel nobody asked for".
    expect(
      derive(eventOf({ channel: "C09UNSCOPED" }), [
        install(["C09OTHER"], { installId: "healthy" }),
        install([], { installId: "corrupt", config: { channels: 42 } }),
      ]),
    ).toEqual({ kind: "skipped", reason: "install_config_unreadable" });
  });

  it("refuses when no install exists at all", () => {
    expect(derive(eventOf(), [])).toEqual({
      kind: "skipped",
      reason: "channel_not_configured",
    });
  });

  it("refuses when the matched install's catalog id has no registered connector", () => {
    const derived = deriveSlackWebhookEpisode({
      event: eventOf(),
      connectors: [CONNECTOR],
      installs: [install([CHANNEL], { catalogId: "catalog:some-other-slack-source" })],
    });
    expect(derived).toEqual({ kind: "skipped", reason: "no_connector" });
  });
});

// ---------------------------------------------------------------------------
// The poll backstop — which drops are deferred and which are permanent
// ---------------------------------------------------------------------------

describe("thread_ts is read for the backstop question and never for the id", () => {
  it("populates threadTs on a reply while keying the episode on the reply's own ts", () => {
    // Both halves in one assertion on purpose. `threadTs` exists ONLY so the
    // caller can tell "the poll will re-store this" from "this is gone" — the
    // poll never fetches replies. If it leaked into the id instead, every reply
    // in a thread would collapse onto the parent's episode.
    const replyTs = "1750000500.000200";
    const parsed = readMessage(rawMessageEvent({ ts: replyTs, thread_ts: TS }));
    expect(parsed.threadTs).toBe(TS);
    expect(parsed.ts).toBe(replyTs);

    const derived = derive(parsed);
    expect(derived.kind).toBe("episode");
    if (derived.kind !== "episode") return;
    expect(derived.record.sourceId).toBe(slackEpisodeSourceId(CHANNEL, replyTs));
  });

  it("leaves threadTs null on a top-level message", () => {
    expect(readMessage(rawMessageEvent()).threadTs).toBeNull();
  });

  it("reports a thread PARENT as backstopped, since history does return it", () => {
    // Slack sets `thread_ts === ts` on a thread's parent once it has replies.
    // That message IS returned by `conversations.history`, so treating any
    // non-null `thread_ts` as "no backstop" would misreport it as lost.
    const parsed = readMessage(rawMessageEvent({ thread_ts: TS }));
    expect(parsed.threadTs).toBe(parsed.ts);
  });
});

// ---------------------------------------------------------------------------
// DMs are not admissible channels for this source
// ---------------------------------------------------------------------------

describe("1:1 DMs", () => {
  const dmEvent = {
    type: "message",
    channel: "D01USER",
    channel_type: "im",
    user: "U123",
    text: "our runway is 14 months",
    ts: TS,
    team_id: "T0ABC",
  };

  it("cannot be brought into scope at all — a D-id makes the whole install config unreadable", () => {
    // The strongest of the three layers, and the one worth pinning because it
    // is the least obvious. Even a HAND-EDITED install row naming a DM does not
    // open a path: `SLACK_CHANNEL_ID_PATTERN` admits only `C…`/`G…`, so
    // `parseSlackHistoryConfig` refuses the whole config rather than dropping
    // the offending entry — the refusal-not-narrowing choice `config.ts` makes
    // for exactly this reason. So the DM is out of scope AND the tampering is
    // reported, instead of the row quietly working for its other channels.
    expect(derive(readMessage(dmEvent), [install(["D01USER"])])).toEqual({
      kind: "skipped",
      reason: "install_config_unreadable",
    });
  });

  it("is blocked on visibility even if it reaches a validly-scoped install", () => {
    // The second layer, reached by giving the install a legitimate channel so
    // the config parses. `channel_type: "im"` blocks — DM audiences are two
    // people and ADR-0036 §T6 puts source-principal-resolution failure on the
    // BLOCK side, so there is no arm that could mint a grant here.
    expect(derive(readMessage(dmEvent), [install([CHANNEL])])).toEqual({
      kind: "skipped",
      reason: "channel_not_configured",
    });
    // ...and nothing about a DM can produce a usable visibility, which is what
    // makes the layer above a backstop rather than the only guard.
    expect(resolveWebhookChannelVisibility("im", "D01USER")).toBeNull();
  });
});
