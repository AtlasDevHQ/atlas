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
  type SlackWebhookMessageEvent,
} from "@atlas/api/lib/brain/ingest/slack/webhook";

const CHANNEL = "C01ABCDEF";
const PRIVATE_CHANNEL = "G01PRIVATE";
const TS = "1750000000.000100";

/** The registered Slack brain source, as the writer sees it in the registry. */
const CONNECTOR: BrainSourceConnector<typeof SLACK_SOURCE> = {
  catalogId: SLACK_HISTORY_CATALOG_ID,
  source: SLACK_SOURCE,
  // Chat-class ⇒ per-workspace (#5203). The webhook path never dispatches,
  // so `listWorkspaces` is unreachable here.
  scope: {
    kind: "per-workspace",
    syncId: "slack-history",
    listWorkspaces: () => Promise.resolve([]),
  },
  audience: { kind: "externally-synced" },
  createClient() {
    throw new Error("the webhook path never builds a vendor client");
  },
};

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

/**
 * #5203: the deriver takes a resolved `inScope` boolean, not install rows.
 * Scope is the bot's channel membership minus admin exclusions, resolved by the
 * SHELL (`isEventChannelInScope`) so this function stays I/O-free.
 */
function derive(event: SlackWebhookMessageEvent, inScope = true) {
  return deriveSlackWebhookEpisode({ event, connectors: [CONNECTOR], inScope });
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
    const a = derive(eventOf({ channel: CHANNEL }), true);
    const b = derive(eventOf({ channel: "C09OTHER" }), true);
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
      inScope: true,
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
      true,
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
      true,
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
  it("refuses a channel outside the workspace's resolved scope", () => {
    // Slack delivers events for every channel the bot is in, which since #5203
    // is a strictly WIDER set than what the workspace consented to retain: an
    // admin may exclude a channel the bot must stay in for chat. Storing outside
    // the resolved scope would ingest content the poll never would, so the two
    // writers' contents would diverge by construction.
    expect(derive(eventOf({ channel: "C09UNSCOPED" }), false)).toEqual({
      kind: "skipped",
      reason: "channel_not_configured",
    });
  });

  // ⚠️ #5203 REPLACED THIS WHOLE GROUP, and what it replaced is worth naming.
  //
  // These tests used to pin install-config parsing: which of several installs
  // covered a channel, that a hand-edited `channels` field reported
  // `install_config_unreadable` rather than out-of-scope, and that a FOREIGN
  // slack-vendor install's config was not diagnosed with slack-history's
  // schema. None of it has a subject any more — `catalog:slack-history` and its
  // installs were deleted by migration 0198, so there is no stored config to
  // parse, no second install to disambiguate against, and no unreadable-config
  // state to reach.
  //
  // What survives is the DISTINCTION those tests were really protecting: a
  // channel the workspace said no to, and a scope Atlas could not read, must
  // not share a counter. One is ordinary traffic; the other silently drops 100%
  // of a workspace's messages. That split now lives on the reason vocabulary as
  // `channel_not_configured` vs `scope_unreadable`, and the shell owns it —
  // `deriveSlackWebhookEpisode` never sees a failed read, because a failed read
  // never reaches it as `true`.

  it("refuses a channel outside the workspace's ingest scope", () => {
    expect(derive(eventOf(), false)).toEqual({
      kind: "skipped",
      reason: "channel_not_configured",
    });
  });

  it("stores a channel inside it, naming the per-workspace sync id", () => {
    const derived = derive(eventOf(), true);
    if (derived.kind !== "episode") throw new Error("expected an episode");
    // The `installId` field survives the retirement as the sync-state key, and
    // for a per-workspace source it is the connector's declared `syncId` rather
    // than any install's slug. Asserted because it is what
    // `knowledge_sync_state` is booked under.
    expect(derived.installId).toBe("slack-history");
  });

  it("refuses when no Slack brain source is registered at all", () => {
    expect(deriveSlackWebhookEpisode({ event: eventOf(), connectors: [], inScope: true })).toEqual({
      kind: "skipped",
      reason: "no_connector",
    });
  });

  it("⭐ refuses rather than GUESSING when two Slack sources are registered", () => {
    // With no install row left, nothing disambiguates a vendor lookup that
    // returns more than one connector. Resolving to `connectors[0]` would file a
    // second Slack source's events under this one's source-id namespace — a
    // silent cross-source collision the poll, dispatched per connector, would
    // never produce.
    //
    // MUTATION THIS CATCHES: replacing the length check with `connectors[0]`.
    const second = { ...CONNECTOR, catalogId: "catalog:some-other-chat-source" };
    expect(
      deriveSlackWebhookEpisode({ event: eventOf(), connectors: [CONNECTOR, second], inScope: true }),
    ).toEqual({ kind: "skipped", reason: "ambiguous_connector" });
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

  // ⚠️ #5203 collapsed this pair into one. The first used to assert that a
  // `D…` id in an install's `channels` list made the WHOLE config unreadable —
  // a claim about `parseSlackHistoryConfig`, which no longer parses anything
  // because there is no stored config. The DM defence that survives is
  // structural and stronger than the parse ever was:
  //
  //   - `SLACK_CHANNEL_ID_PATTERN` refuses `D…` in the shell before the
  //     workspace lookup;
  //   - `ck_brain_slack_channel_id_shape` refuses it at the TABLE, so a DM
  //     cannot be stored as in-scope even by a hand-written INSERT;
  //   - and the visibility layer below blocks it regardless.
  //
  // Three independent refusals where there used to be a config parse.
  it("is blocked on visibility even if it somehow reaches an in-scope decision", () => {
    // The layer that does not depend on scope at all. `channel_type: "im"`
    // blocks — a DM's audience is two people and ADR-0036 §T6 puts
    // source-principal-resolution failure on the BLOCK side, so there is no arm
    // that could mint a grant here.
    expect(derive(readMessage(dmEvent), true)).toEqual({
      kind: "skipped",
      reason: "unresolvable_visibility",
    });
    // ...and nothing about a DM can produce a usable visibility, which is what
    // makes the layer above a backstop rather than the only guard.
    expect(resolveWebhookChannelVisibility("im", "D01USER")).toBeNull();
  });
});
