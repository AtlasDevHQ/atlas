/**
 * The Slack chat webhook FAST-PATH (#4967, ADR-0036 §T6) — a second writer into
 * the same idempotent episode store, not a second store and not a second
 * pipeline.
 *
 * ADR-0036 §T6: *"Freshness = poll + reconcile universally, plus a webhook
 * fast-path for event-native chat (an alternate writer into the same idempotent
 * episode store, safe by the source-id dedupe; each connector's obligation is a
 * stable source-id shared across webhook and poll)."*
 *
 * ══════════════════════════════════════════════════════════════════════
 * ██  WHY THIS IS SAFE: ONE FUNCTION MINTS BOTH WRITERS' SOURCE-IDS
 * ══════════════════════════════════════════════════════════════════════
 *
 * The whole safety argument is source-id dedupe. If the two writers ever
 * disagree about a message's id, that message is stored TWICE — and because
 * `brain_episodes` is append-only (migration 0180: no `updated_at`, no upsert)
 * there is no later pass that converges them. The damage is silent and
 * compounding: `extract.ts` spends a model call on each copy, and
 * `reconcile.ts` treats the two as INDEPENDENT corroboration — so a claim gains
 * a second `provenance` edge from its own echo and reads as better-evidenced
 * than it is.
 *
 * The defence is structural rather than documentary: this module does NOT
 * re-derive the id. It builds a {@link SlackHistoryMessage} — the exact record
 * shape the poll path's page walk produces — and hands it to
 * {@link toEpisode}, the SAME function `client.ts` calls. `slackEpisodeSourceId`
 * is therefore reached from one place, through one caller, for both writers. A
 * second call site would be a second thing to keep in step; there isn't one.
 *
 * That also buys the skip rules for free (bot/app authorship, the
 * membership-noise subtype denylist, empty `text`), which matter for the same
 * reason: a webhook that stored what the poll skips would make the store's
 * contents depend on which writer got there first.
 *
 * ⚠️ THE FIELD PATHS ARE THE TRAP, and `config.ts`'s header is where they are
 * enumerated. The two writers read `ts` from DIFFERENT places, so "just use
 * `ts`" is wrong: the poll reads `message.ts` from `conversations.history`, a
 * plain webhook `message` event carries `event.ts`, and a
 * `subtype: "message_changed"` event carries the original message's id at
 * `event.message.ts` while its OWN top-level `ts` is the EVENT's timestamp.
 * {@link readSlackWebhookMessage} is the only place that reading happens.
 *
 * ## An edit is NOT a new episode — for THIS source, deliberately
 *
 * `episodes.ts` states the general rule: "a chat message edited upstream is a
 * NEW episode (a new `source_id` is the source's business)". The clause in
 * brackets is the operative half — it defers to the SOURCE's id contract, and
 * Slack's contract (`config.ts`) deliberately does not mint a new id for an
 * edit: `conversations.history` serves the message's current state under its
 * ORIGINAL `ts`, so the poll path re-ingests an edited message as a no-op. The
 * webhook matches that by reading `event.message.ts`, which collapses the edit
 * onto the stored episode. Minting from `event.message.edited.ts` instead would
 * duplicate every edited message — one writer's view of an edit becoming a
 * second piece of "evidence" for the same sentence. Treating a revision as new
 * evidence stays a future, deliberate slice (`config.ts` says so); it is not
 * something this module gets to decide by choosing a field path.
 *
 * A `message_changed` event does not reach this writer TODAY: the Chat SDK's
 * Slack adapter drops that subtype (along with `message_deleted`,
 * `message_replied` and the membership subtypes) before dispatch —
 * `@chat-adapter/slack`'s `handleMessageEvent` `ignoredSubtypes` set. The
 * handling here is a guard against that filter changing under us, and it is
 * unit-tested directly rather than through the tee, because the tee cannot
 * currently reach it.
 *
 * ## Thread replies ARE their own episodes
 *
 * A reply's `thread_ts` is its PARENT; its own `ts` is its identity, and that is
 * what keys the episode (`config.ts` states the rule so both writers agree).
 * This means the fast-path covers something the poll does not: M1's poll calls
 * only `conversations.history`, which returns top-level messages and
 * `thread_broadcast` copies — never replies. So replies observed here are pure
 * gain, and they carry no duplication risk precisely because the poll never
 * mints those ids at all. A `thread_broadcast` copy DOES appear on both paths,
 * with one `ts`, and dedupes.
 *
 * ## Poll is the correctness floor — for TOP-LEVEL messages
 *
 * Stated plainly, and with the exception named, because the loose version of
 * this claim ("anything we drop, the poll stores") is BOTH the reassurance this
 * design rests on AND false for one specific class. The tee sits on the Chat
 * SDK's handler dispatch, and that dispatch drops messages by design in ways
 * this module cannot influence:
 *
 *   - the per-thread LOCK. The bridge runs the SDK's default `drop` strategy, so
 *     a message arriving while its thread is being processed is discarded, never
 *     dispatched;
 *   - the adapter's `ignoredSubtypes` filter (above);
 *   - the routing cascade's DM arm, which this writer deliberately does not
 *     register on — 1:1 DMs (`D…`) are not admissible channels for this source
 *     at all (`config.ts`: their audience is two people, and
 *     source-principal-resolution failure is on the BLOCK side).
 *
 * ⚠️ **The lock is THREAD-scoped, and that is exactly the wrong shape for the
 * backstop claim.** `Chat.getLockKey` defaults to `scope: "thread"` and the
 * Slack adapter overrides nothing, so the lock key is
 * `slack:<channel>:<thread_ts || ts>`. A top-level message's key contains its
 * OWN `ts`, so it is unique and can never contend. Only a THREAD REPLY shares a
 * key — with its parent and its siblings. So lock contention drops replies and
 * nothing else, and replies are precisely the messages
 * `conversations.history` never returns. A reply dropped here is dropped
 * PERMANENTLY, not deferred.
 *
 * That is why the not-stored outcomes carry {@link SlackWebhookIngestOutcome}'s
 * `pollBackstopped`, and why the observer logs a reply's loss at warn rather
 * than reciting "the scheduled sync still covers it" at debug. The reassurance
 * is true for top-level messages and false for replies, and a log line that
 * cannot tell them apart is worse than no log line.
 *
 * For everything else the design holds: the fast-path lowers latency from "next
 * sync tick" to "seconds" and contributes nothing to correctness. Turning it off
 * leaves ingest exactly as it was — which is why the knob defaults OFF and why
 * this module never touches the poll's cursor, high-water mark, or sync state.
 *
 * ## No privileged shortcut
 *
 * The same block-vs-flag asymmetry and the same grant derivation as the poll,
 * reached through the same `deriveChatChannelGrant`. The one thing that differs
 * is HOW visibility is learned: the poll calls `conversations.info`, which this
 * path must not do — a round-trip per message is exactly the latency the fast
 * path exists to avoid, and a Slack call inside a webhook handler is a rate
 * limit waiting to happen. The event carries `channel_type` instead, which is
 * Slack's own authoritative statement (`message.channels` → `"channel"`,
 * `message.groups` → `"group"`, `"mpim"` for a multi-person DM). An
 * unrecognised value BLOCKS: see {@link resolveWebhookChannelVisibility}.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { getInstallation } from "@atlas/api/lib/slack/store";
import type { SlackHistoryMessage } from "@atlas/api/lib/slack/api";
import { SLACK_SOURCE, type EpisodeSource } from "@atlas/api/lib/brain/sources";
import { deriveChatChannelGrant } from "../grant";
import { findBrainSourceConnectors } from "../types";
import type { BrainEpisodeRecord, BrainSourceConnector } from "../types";
import { ingestEpisodes } from "../episodes";
import { toEpisode } from "./client";
import {
  SLACK_CHANNEL_ID_PATTERN,
  SLACK_HISTORY_CATALOG_ID,
  parseSlackHistoryConfig,
} from "./config";

const log = createLogger("brain.ingest.slack.webhook");

/**
 * Is the chat webhook fast-path enabled?
 *
 * Read PER EVENT rather than once at wiring time. The knob is an operator's
 * incident lever — "stop writing episodes off Slack events right now" — and a
 * gate evaluated at boot would need a restart to honour it. The read is a
 * process-local settings-registry lookup, not a query.
 */
export function isSlackWebhookFastPathEnabled(): boolean {
  return getSettingAuto("ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED") === "true";
}

/**
 * Why an event produced no episode. Every arm is COUNTED and returned to the
 * caller, never swallowed: a fast-path that silently stores nothing looks
 * exactly like a fast-path that is working, and the poll would keep covering
 * for it forever.
 *
 * The arms fall into three groups, and keeping them distinct is the whole point
 * of the vocabulary — a counter that cannot separate them tells an operator
 * nothing:
 *
 *   - **not a fault at all** — `noise` (the poll's own skip rules agreeing with
 *     themselves here), `not_a_message`, `channel_not_configured`, `disabled`;
 *   - **configuration** — `no_install`, `unknown_workspace`,
 *     `install_config_unreadable`, `unresolvable_visibility`;
 *   - **fault** — `ingest_failed`. The path broke. It is spelled separately
 *     precisely so a DB outage cannot masquerade as routine traffic: an earlier
 *     cut folded every thrown error into `unparseable_event`, which also
 *     carries the steady-state `app_mention` refusals, so 100% failure and 100%
 *     normal operation produced the same counter.
 */
export type SlackWebhookSkipReason =
  | "disabled"
  | "no_internal_db"
  | "no_connector"
  /** The event was not a `message`-family event (e.g. `app_mention`). */
  | "not_a_message"
  /** A `message` event with no usable `channel`/`ts` identity. */
  | "unparseable_event"
  /**
   * A `message` subtype whose top-level `ts` is the EVENT's, not the original
   * message's — so minting from it would produce an id the poll never mints.
   */
  | "unmintable_subtype"
  | "unknown_workspace"
  | "no_install"
  /** An install matched, but its stored config could not be parsed. */
  | "install_config_unreadable"
  | "channel_not_configured"
  | "unresolvable_visibility"
  | "ungrantable_channel"
  | "noise"
  /** The path THREW. Never conflated with a refusal — see the group list. */
  | "ingest_failed";

/**
 * What one observed event did.
 *
 * The not-stored arms carry {@link SlackWebhookIngestOutcome.pollBackstopped}
 * because "not stored here" means two completely different things depending on
 * the message, and only the caller can act on the difference. See the module
 * header's floor section.
 */
export type SlackWebhookIngestOutcome =
  | {
      readonly status: "skipped";
      readonly reason: SlackWebhookSkipReason;
      /**
       * True when the scheduled poll WILL store this message on its next cycle,
       * so nothing was lost — the ordinary case, and the one the fast path is
       * designed around.
       *
       * False for a THREAD REPLY: `conversations.history` never returns
       * replies, so a reply this path did not store is not stored by anything.
       *
       * The arms that return before the payload is parsed (`disabled`,
       * `no_internal_db`, `no_connector`) report `true`, and it is worth being
       * exact about why: nothing is lost BY THIS PATH there — with the fast
       * path off, reply ingestion is simply the M1 status quo rather than a
       * regression this slice introduced.
       */
      readonly pollBackstopped: boolean;
    }
  /** The episode was written by THIS event. */
  | { readonly status: "inserted"; readonly sourceId: string }
  /**
   * The episode was already stored — the poll got there first, or Slack
   * redelivered. This is the dedupe DOING ITS JOB, and the count a test reads
   * to prove the two writers collapse onto one row.
   */
  | { readonly status: "duplicate"; readonly sourceId: string }
  /**
   * The record was refused by the ingest core's screens (blank body, unusable
   * grant, invalid event time). Distinct from `noise`: noise is a message this
   * source does not want, a refusal is a record it could not store.
   *
   * Note the poll would build the identical record and be refused identically,
   * so `pollBackstopped` is about the REPLY question only — a refused top-level
   * message is not stored by either writer.
   */
  | {
      readonly status: "refused";
      readonly sourceId: string;
      readonly pollBackstopped: boolean;
    };

/**
 * A Slack `message`-family event, narrowed to what the fast-path reads.
 *
 * Structural rather than imported from a Slack SDK type: it arrives through the
 * chat plugin as `Message["raw"]` (typed `unknown` at that boundary), so it is
 * untrusted input to be narrowed, not a type to be asserted.
 */
export interface SlackWebhookMessageEvent {
  /** The message's channel-scoped identity — the source-id's second half. */
  readonly ts: string;
  readonly channelId: string;
  readonly text: string;
  readonly user: string | null;
  readonly subtype: string | null;
  readonly botId: string | null;
  /** Slack's own visibility statement for the channel this arrived in. */
  readonly channelType: string | null;
  /** The Slack workspace that produced the event. */
  readonly teamId: string | null;
  /**
   * The PARENT message's `ts` when this is a thread reply; null for a top-level
   * message.
   *
   * ⚠️ Read for exactly ONE purpose: deciding whether the scheduled poll would
   * back this message up (it does not fetch replies). It must NEVER reach the
   * source-id — keying on `thread_ts` would collapse every reply in a thread
   * onto the parent's episode, storing one message and silently dropping the
   * rest. That is the single most plausible mistake here, because the Slack
   * adapter's own `handleMessageEvent` computes `thread_ts || ts` two lines
   * before it hands the event over, and copying that line looks right.
   * `slack-webhook.test.ts` pins both halves: the reply keys on its own `ts`,
   * AND `threadTs` is populated.
   */
  readonly threadTs: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * What {@link readSlackWebhookMessage} made of a payload.
 *
 * A union rather than `| null` so the two non-message outcomes stay
 * DISTINGUISHABLE all the way out to the counters: `not_a_message` is
 * steady-state traffic (every `app_mention`) and `unparseable_event` is a
 * payload that should have had an identity and did not. Collapsing them — which
 * an earlier cut did — makes the parse counter unreadable, because the benign
 * arm dominates it.
 */
export type SlackWebhookRead =
  | { readonly kind: "message"; readonly event: SlackWebhookMessageEvent }
  | {
      readonly kind: "skipped";
      readonly reason: Extract<
        SlackWebhookSkipReason,
        "not_a_message" | "unparseable_event" | "unmintable_subtype"
      >;
    };

/**
 * Narrow a raw Slack event payload into {@link SlackWebhookMessageEvent}, or
 * say why it could not be.
 *
 * THE field-path reading, in one place — see this module's header for why that
 * matters and `config.ts`'s ⚠️ section for the enumeration it implements.
 *
 * `message_changed` is unwrapped to the EDITED MESSAGE's sub-object: its `ts` is
 * the original message's id (so the edit collapses onto the stored episode),
 * and its `text` is the current text. The event's own top-level `ts` — the
 * edit's timestamp — is never read, because reading it would mint a fresh id
 * for a message already stored.
 *
 * `channel` and `channel_type` are always taken from the OUTER event: the inner
 * `message` sub-object carries neither.
 *
 * ⚠️ The channel id is NORMALISED (`trim().toUpperCase()`) — the same
 * normalisation `parseSlackHistoryConfig` applies to the configured list. That
 * is not cosmetic: the poll path builds its source-ids from the PARSED config
 * ids, so an un-normalised `c01abc` here would mint `c01abc:<ts>` against the
 * poll's `C01ABC:<ts>` and duplicate the message. Slack sends uppercase ids
 * today; making the two writers agree must not depend on that staying true.
 */
export function readSlackWebhookMessage(raw: unknown): SlackWebhookRead {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "skipped", reason: "unparseable_event" };
  }
  const event = raw as Record<string, unknown>;

  // Only the `message` family — and the reason is NOT "otherwise we do the work
  // twice", which would be wrong. Both `app_mention` and `message.channels` are
  // subscribed (#4909) and the adapter routes both into `handleMessageEvent`,
  // but the SDK sets its TTL'd `dedupe:slack:<message.id>` key BEFORE dispatch
  // and the adapter sets `id = event.ts` for both — so exactly ONE of the pair
  // ever reaches a handler. #4909 verified in prod which one: the plain
  // `message` event won every time.
  //
  // This refusal exists because an `app_mention` payload carries no
  // `channel_type`, so it could only ever block at visibility resolution
  // anyway; refusing at the top of the funnel NAMES the reason instead of
  // reporting it as an unresolvable channel. If the plain-`message` delivery
  // ever stops winning that race, mentions fall back to the poll — a latency
  // regression, not a correctness one.
  //
  // A payload with NO `type` at all is admitted: `parseMessage` re-parses
  // stored/replayed messages that carry no envelope type, and refusing those
  // would drop real messages to save nothing.
  const type = stringOrNull(event.type);
  if (type !== null && type !== "message") return { kind: "skipped", reason: "not_a_message" };

  const subtype = stringOrNull(event.subtype);
  const inner =
    subtype === "message_changed" &&
    event.message !== null &&
    typeof event.message === "object" &&
    !Array.isArray(event.message)
      ? (event.message as Record<string, unknown>)
      : null;
  // Subtypes whose top-level `ts` is the EVENT's timestamp rather than the
  // message's identity. `message_changed` is the one we can recover, by
  // unwrapping to `event.message.ts` above; these carry no inner message to
  // unwrap, so minting from them would produce a source-id the poll NEVER
  // mints — the exact duplicate-episode failure this module's header is about,
  // and unrecoverable because `brain_episodes` is append-only.
  //
  // Unreachable today: the Chat SDK's Slack adapter drops these before dispatch
  // (`ignoredSubtypes`). Guarded anyway, and for a sharper reason than
  // symmetry — `message_deleted` survives that filter's absence only by
  // ACCIDENT, because it carries no `text` and so trips the empty-text skip
  // inside `toEpisode`. An accident is not a guarantee: a payload that ever
  // carried text would mint a novel id with nothing to stop it. Its sibling
  // `message_changed` got an explicit guard; this is the one that needed it.
  if (subtype === "message_deleted" || subtype === "tombstone") {
    return { kind: "skipped", reason: "unmintable_subtype" };
  }
  // The record the id is minted from. For an edit that is the INNER message —
  // see the docstring. For everything else the event IS the message.
  const source = inner ?? event;

  const ts = stringOrNull(source.ts);
  const rawChannelId = stringOrNull(event.channel);
  if (ts === null || rawChannelId === null) {
    return { kind: "skipped", reason: "unparseable_event" };
  }
  const channelId = rawChannelId.trim().toUpperCase();
  if (channelId === "") return { kind: "skipped", reason: "unparseable_event" };

  const message: SlackWebhookMessageEvent = {
    ts,
    channelId,
    text: typeof source.text === "string" ? source.text : "",
    user: stringOrNull(source.user),
    // An unwrapped edit is a plain message again: its subtype belongs to the
    // ENVELOPE, not to the message, and passing `message_changed` through would
    // make the record look like a subtype the poll path never sees. (The inner
    // object may carry its own subtype — `thread_broadcast`, `file_share` — and
    // that one is the message's, so it is kept.)
    subtype: inner !== null ? stringOrNull(inner.subtype) : subtype,
    botId: stringOrNull(source.bot_id),
    channelType: stringOrNull(event.channel_type),
    // `team_id` is the envelope's field and `team` the per-message alias; which
    // one is present depends on the event shape, so accept either. Same rule
    // the proactive resolver applies (`ee/src/proactive/workspace-id-resolver.ts`).
    teamId: stringOrNull(event.team_id) ?? stringOrNull(event.team),
    // From the OUTER event even for an edit: `message_changed`'s inner object
    // carries no `thread_ts`. Read-only — see the field's docstring for why it
    // must never reach the id.
    threadTs: stringOrNull(event.thread_ts) ?? stringOrNull(source.thread_ts),
  };
  return { kind: "message", event: message };
}

/**
 * Slack's `channel_type` → the visibility bit `deriveChatChannelGrant` needs,
 * or `null` when it cannot be established.
 *
 * `null` BLOCKS the event (ADR-0036 §T6 puts source-principal-resolution
 * failure on the block side, and `grant.ts`'s `ChatChannelVisibility` says an
 * undeterminable visibility must never share a branch with "public"). Blocking
 * costs nothing here that is not recovered: the poll reads
 * `conversations.info`, learns the real answer, and stores the message on its
 * next cycle. Guessing costs a private channel's contents published org-wide,
 * frozen onto an append-only row that no later pass rewrites — an episode's
 * grant is minted once and `ON CONFLICT DO NOTHING` means the poll's correct
 * grant would arrive too late to matter.
 *
 * The `im` arm is a skip rather than a mistake: 1:1 DMs are not admissible
 * channels for this source (`SLACK_CHANNEL_ID_PATTERN` refuses `D…`), and they
 * are filtered here as well so the reason is NAMED rather than reported as a
 * generic id-shape refusal.
 *
 * The `C…`-id guard applies in ONE direction only, and that asymmetry is the
 * point. A legacy private channel carries a `G…` id, and Slack has issued `C…`
 * ids for private channels since 2021 — so "id prefix ⇒ visibility" is not
 * sound in general and must not be used to CLASSIFY. It is sound as a
 * contradiction check on the WIDENING direction alone: a `G…` id with
 * `channel_type: "channel"` is Slack telling us two incompatible things, and
 * the arm we would take on it mints the org-wide grant. Blocking there is free;
 * the reverse check (a `C…` id claiming `group`) is deliberately absent because
 * it would block correct, modern private channels.
 */
export function resolveWebhookChannelVisibility(
  channelType: string | null,
  channelId: string,
): { readonly isPrivate: boolean } | null {
  switch (channelType) {
    case "channel": {
      // Normalised HERE rather than trusting the caller, even though
      // `readSlackWebhookMessage` already uppercases. This function is
      // EXPORTED, and the `G…` test below is the guard on the arm that mints
      // the ORG-WIDE grant — so a caller passing `"g01legacy"` would get
      // `isPrivate: false` for a legacy private channel. A precondition
      // established in a different function is not a precondition this one can
      // rely on when the cost of being wrong is publishing a private channel.
      return channelId.trim().toUpperCase().startsWith("G") ? null : { isPrivate: false };
    }
    case "group":
    case "mpim":
      return { isPrivate: true };
    default:
      // Includes `im` and anything Slack adds later. Unknown ⇒ block.
      return null;
  }
}

/** One enabled Slack-history install: which workspace, which channels. */
interface SlackHistoryInstallRow extends Record<string, unknown> {
  install_id: string;
  catalog_id: string;
  config: Record<string, unknown> | null;
}

/** An install row, as {@link deriveSlackWebhookEpisode} needs to see it. */
export interface SlackWebhookInstall {
  readonly installId: string;
  readonly catalogId: string;
  readonly config: Record<string, unknown> | null;
}

/** What one event yields, before anything is written. */
export type SlackWebhookDerivation =
  | {
      readonly kind: "episode";
      readonly source: EpisodeSource;
      readonly installId: string;
      readonly record: BrainEpisodeRecord;
    }
  | { readonly kind: "skipped"; readonly reason: SlackWebhookSkipReason };

/**
 * Decide what one observed event becomes — the whole decision half, with no
 * I/O in it.
 *
 * Split out from {@link ingestSlackWebhookMessage} on purpose, and the split is
 * where the acceptance tests live. EVERY claim this slice has to make is
 * decided here — that the source-id matches the poll's byte for byte, that the
 * grant derivation and the skip rules are the poll's, that a channel outside
 * the install's configured scope is refused, that an unestablishable visibility
 * BLOCKS. A test for any of those against the I/O shell would be a test of five
 * mocks agreeing with each other; against this function it is a test of the
 * decision. The shell around it only fetches the two things this needs (which
 * workspace, which installs) and hands the result to the append-only writer.
 */
export function deriveSlackWebhookEpisode(params: {
  readonly event: SlackWebhookMessageEvent;
  readonly connectors: readonly BrainSourceConnector[];
  readonly installs: readonly SlackWebhookInstall[];
}): SlackWebhookDerivation {
  const { event, connectors, installs } = params;

  // The install whose configured channel scope COVERS this channel. Scope is
  // re-checked per event rather than trusted from the subscription: Slack
  // delivers events for every channel the bot is in, which is a strictly wider
  // set than the channels an admin picked at install time. Storing outside that
  // set would ingest content the workspace never consented to — and the poll
  // never would, so the two writers' contents would diverge by construction.
  let unreadableConfig = false;
  const match = installs.find((install) => {
    const parsed = parseSlackHistoryConfig(install.config);
    if (!parsed.ok) {
      // The error VALUE is not discarded. `parseSlackHistoryConfig` writes
      // actionable, admin-facing messages precisely so a hand-edited install
      // row is diagnosable, and the poll surfaces them into
      // `knowledge_sync_state.error`. Folding it into a boolean here would make
      // a corrupted config skip 100% of a workspace's messages forever with a
      // reason that reads like ordinary out-of-scope traffic.
      // Only a SLACK-HISTORY row's parse failure is a diagnosis, because this
      // is the only schema read here and it is slack-history's.
      //
      // `findBrainSourceConnectors` returns an array and `ingest/types.ts`
      // explicitly disclaims uniqueness, so the day a second slack-VENDOR brain
      // source exists, `installs` carries its rows too — the shell queries by
      // every catalog id the vendor lookup returned. Reading one of those with
      // `parseSlackHistoryConfig` fails on a config that is perfectly valid for
      // its own connector, and reporting THAT sends an admin to repair a row
      // that was never broken.
      //
      // Gated on the catalog id that owns the schema, which is the only thing
      // that discriminates. An earlier attempt gated on "is this install's
      // catalog id one of the connectors we resolved" — inert, since the shell
      // queries BY those ids, so it is true for every row that reaches here
      // including the foreign one it meant to exclude.
      //
      // The DIAGNOSIS is gated, never the match. A foreign install whose config
      // this schema happens to read still matches and still reaches
      // `no_connector` below — silently reclassifying it as out-of-scope would
      // trade one wrong answer for another.
      if (install.catalogId === SLACK_HISTORY_CATALOG_ID) {
        unreadableConfig = true;
        log.warn(
          { installId: install.installId, error: parsed.error },
          "Slack brain webhook: this install's stored channel scope could not be parsed, so nothing is stored for it — the scheduled sync reports the same error into knowledge_sync_state",
        );
      }
      return false;
    }
    // Both sides are already normalised — `parseSlackHistoryConfig` uppercases
    // the configured ids and `readSlackWebhookMessage` uppercases the event's —
    // so this is a plain comparison rather than a case-insensitive one. Doing
    // it case-insensitively HERE would be the wrong repair: the id that must
    // match is the id that goes on to mint the source-id.
    return parsed.channels.includes(event.channelId);
  });
  if (match === undefined) {
    // An unreadable config is reported as its own reason rather than as
    // "not in scope": one is a misconfiguration to fix, the other is Slack
    // delivering more than the admin asked for, which is normal.
    return {
      kind: "skipped",
      reason: unreadableConfig ? "install_config_unreadable" : "channel_not_configured",
    };
  }

  const connector = connectors.find((c) => c.catalogId === match.catalogId);
  if (connector === undefined) {
    // Reachable only if the caller passes installs whose catalog ids are not in
    // `connectors` — the shell cannot, since it queries BY those ids. A counted
    // skip rather than a non-null assertion, because the alternative to proving
    // it is asserting it.
    return { kind: "skipped", reason: "no_connector" };
  }

  const visibility = resolveWebhookChannelVisibility(event.channelType, event.channelId);
  if (visibility === null) {
    log.warn(
      { channelId: event.channelId, channelType: event.channelType },
      "Slack brain webhook: could not establish the channel's visibility from the event — leaving the message to the poll cycle, which reads conversations.info",
    );
    return { kind: "skipped", reason: "unresolvable_visibility" };
  }

  // The poll's deriver, called with the poll's inputs. Not a re-implementation
  // that happens to agree today: `grant.ts`'s header spells out what a SECOND
  // grant minter costs — the audience-membership sync (#4801) reads its answer
  // out of this same function, so a webhook that derived its own would write
  // episodes granted to an audience nothing syncs members into.
  const grant = deriveChatChannelGrant({
    source: connector.source,
    channelId: event.channelId,
    isPrivate: visibility.isPrivate,
  });
  if (grant === null) {
    // UNREACHABLE BY CONSTRUCTION today, and kept anyway. `deriveChatChannelGrant`
    // returns null only for a blank channel id or a blank source; the channel id
    // is non-empty by `readSlackWebhookMessage`'s own guard and the source is a
    // literal from the closed `EpisodeSource` vocabulary. It stays because
    // `grant.ts` is free to grow an arm that CAN refuse — and the alternative to
    // a counted skip here is a non-null assertion on a security-relevant value.
    // Noted rather than silently dead: an arm nothing can reach is a lie about
    // the state space unless it says so. That is also why no test drives it.
    log.warn(
      { channelId: event.channelId },
      "Slack brain webhook: no usable access grant could be derived — nothing was stored from this message",
    );
    return { kind: "skipped", reason: "ungrantable_channel" };
  }

  // ── The shared mint. See this module's header. ────────────────────────────
  // `toEpisode` is the POLL's converter, reached here with a record shaped
  // exactly as its page walk produces. It owns the source-id and the skip
  // rules, so neither can differ between the writers without differing for
  // both.
  const message: SlackHistoryMessage = {
    ts: event.ts,
    text: event.text,
    user: event.user,
    subtype: event.subtype,
    botId: event.botId,
  };
  const record = toEpisode(event.channelId, message, grant);
  if (record === null) return { kind: "skipped", reason: "noise" };

  return {
    kind: "episode",
    source: connector.source,
    installId: match.installId,
    record,
  };
}

/**
 * The install lookup. Exported so the real-Postgres test executes this exact
 * string against the live schema rather than asserting a paraphrase.
 *
 * Its predicates are those of `SYNC_CYCLE_INSTALLS_SQL` (`lib/knowledge/sync.ts`)
 * plus `workspace_id = $1` — the cycle walks every workspace, whereas a webhook
 * event belongs to exactly one. That extra predicate is what makes this query's
 * result a strict SUBSET of the cycle's, which is the property that matters:
 * an install this filter admitted but the cycle's did not would be a source
 * writing episodes that no poll ever backstops. Keep the other four
 * (`catalog_id = ANY`, `pillar`, `enabled`, `status <> 'archived'`) in lockstep.
 */
export const WEBHOOK_SLACK_INSTALLS_SQL = `SELECT install_id, catalog_id, config
         FROM workspace_plugins
        WHERE workspace_id = $1 AND catalog_id = ANY($2::text[]) AND pillar = 'knowledge'
          AND enabled = true AND status <> 'archived'
        ORDER BY install_id ASC`;

export interface IngestSlackWebhookMessageParams {
  /** The raw Slack event payload, straight off the chat plugin's boundary. */
  readonly raw: unknown;
}

/**
 * Is this message one the scheduled poll would store anyway?
 *
 * False for a thread reply — see the module header. Kept as a named function so
 * the rule has one home and the outcome construction reads as a statement about
 * the message rather than as an inline negation.
 *
 * `thread_broadcast` is the exception the `threadTs` test alone gets wrong. A
 * broadcast carries its PARENT's `thread_ts` — never equal to its own `ts` — so
 * the reply test classifies it as unbacked, yet `conversations.history` does
 * return broadcasts (this module's header and `client.ts` both say so). It is
 * the one subtype that is simultaneously a reply and top-level. Mislabelling it
 * only over-reported "this evidence is lost" in a log line, never lost
 * anything — but the file asserted the opposite of what it did.
 */
function hasPollBackstop(event: SlackWebhookMessageEvent): boolean {
  if (event.subtype === "thread_broadcast") return true;
  return event.threadTs === null || event.threadTs === event.ts;
}

/**
 * Store one webhook-delivered Slack message as an episode.
 *
 * NEVER throws. It is called from inside the Chat SDK's handler dispatch, where
 * a throw would abort the remaining handlers for that message — i.e. the brain
 * fast-path could take the chat pillar's answer down with it. Every failure is
 * a returned outcome plus a log line.
 *
 * Note what makes that safe, and what does not: the poll re-stores a dropped
 * TOP-LEVEL message, so a fault there costs latency. A dropped thread reply is
 * gone. The `pollBackstopped` flag on the not-stored arms is how the caller
 * tells those apart, and `brain-observer.ts` raises the log level accordingly.
 */
export async function ingestSlackWebhookMessage(
  params: IngestSlackWebhookMessageParams,
): Promise<SlackWebhookIngestOutcome> {
  try {
    return await runWebhookIngest(params);
  } catch (err) {
    // A FAULT, and spelled as its own reason. An earlier cut returned
    // `unparseable_event` here, which also carries every steady-state
    // `app_mention` refusal — so an internal-DB outage and ordinary traffic
    // produced the same counter and an operator triaging "why is latency not
    // improving" was sent to look for a payload-shape bug.
    //
    // The Error OBJECT, not `.message`: this arm catches what was not
    // anticipated, so the class and stack are the whole value, and
    // `lib/logger.ts`'s serializer only emits them for an Error.
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Slack brain webhook fast-path threw — this is a FAULT, not a skip. If the internal DB is the cause the scheduled sync is failing too, so nothing is backstopping this message",
    );
    // `pollBackstopped: false` — deliberately pessimistic. The throw may have
    // happened before the payload was parsed, so whether this was a reply is
    // unknown, and the honest answer to "will the poll cover it?" when the
    // store itself may be down is "assume not".
    return { status: "skipped", reason: "ingest_failed", pollBackstopped: false };
  }
}

async function runWebhookIngest(
  params: IngestSlackWebhookMessageParams,
): Promise<SlackWebhookIngestOutcome> {
  // The three pre-parse arms report `pollBackstopped: true`: nothing is lost BY
  // THIS PATH when it is not running at all (see the field's docstring).
  if (!isSlackWebhookFastPathEnabled()) {
    return { status: "skipped", reason: "disabled", pollBackstopped: true };
  }
  // Episodes live in the internal DB, so a deploy without one has no fast path
  // to run — and no poll either. Checked before the payload is parsed so the
  // common self-hosted-without-DB case costs nothing.
  if (!hasInternalDB()) {
    return { status: "skipped", reason: "no_internal_db", pollBackstopped: true };
  }

  // Resolved from the REGISTRY rather than from `SLACK_HISTORY_CATALOG_ID`,
  // which this module could equally have imported. #4963 split the source
  // vocabulary into class-major/vendor-minor axes precisely so a second Slack
  // brain source (canvases, say) is a registration rather than an edit here;
  // hard-coding one catalog id would make this writer silently serve the first
  // of them and no others. Empty means nothing registered — this deploy has no
  // Slack brain source at all.
  const connectors = findBrainSourceConnectors({ vendor: SLACK_SOURCE });
  if (connectors.length === 0) {
    return { status: "skipped", reason: "no_connector", pollBackstopped: true };
  }

  const read = readSlackWebhookMessage(params.raw);
  if (read.kind === "skipped") {
    return { status: "skipped", reason: read.reason, pollBackstopped: true };
  }
  const { event } = read;
  const backstopped = hasPollBackstop(event);
  if (event.teamId === null) {
    return { status: "skipped", reason: "unknown_workspace", pollBackstopped: backstopped };
  }

  // Channel-id shape is checked HERE, before the workspace lookup, because a
  // `D…` DM is the common case this refuses and it should not cost a DB read.
  // The same pattern the install config parses with, so a channel the install
  // could never have configured cannot reach the install query.
  if (!SLACK_CHANNEL_ID_PATTERN.test(event.channelId)) {
    return { status: "skipped", reason: "channel_not_configured", pollBackstopped: backstopped };
  }

  // `getInstallation` also decrypts the bot token, which this path has no use
  // for — only `org_id` is read. Tolerated rather than worked around: it is the
  // one team_id → workspace mapping in core (the same one
  // `ee/src/proactive/workspace-id-resolver.ts` uses), and a second lookup path
  // would be a second thing that can disagree about which tenant an event
  // belongs to.
  //
  // ⚠️ That store's decrypt-or-hide-row policy hides the WHOLE row when the bot
  // token will not decrypt — so a credential failure this path has no use for
  // still reads here as `unknown_workspace`. Benign, because the poll needs
  // that token and fails loudly on the same condition, but it is why an
  // undecryptable install looks like a missing one from here.
  const installation = await getInstallation(event.teamId);
  const workspaceId = installation?.org_id ?? null;
  if (workspaceId === null || workspaceId === "") {
    return { status: "skipped", reason: "unknown_workspace", pollBackstopped: backstopped };
  }

  const catalogIds = connectors.map((connector) => connector.catalogId);
  const installs = await internalQuery<SlackHistoryInstallRow>(WEBHOOK_SLACK_INSTALLS_SQL, [
    workspaceId,
    catalogIds,
  ]);
  if (installs.length === 0) {
    return { status: "skipped", reason: "no_install", pollBackstopped: backstopped };
  }

  const derived = deriveSlackWebhookEpisode({
    event,
    connectors,
    installs: installs.map((row) => ({
      installId: row.install_id,
      catalogId: row.catalog_id,
      config: row.config,
    })),
  });
  if (derived.kind === "skipped") {
    return { status: "skipped", reason: derived.reason, pollBackstopped: backstopped };
  }

  const { record } = derived;
  const report = await ingestEpisodes({
    workspaceId,
    source: derived.source,
    episodes: [record],
  });

  if (report.inserted === 1) {
    log.debug(
      { workspaceId, installId: derived.installId, sourceId: record.sourceId },
      "Slack brain webhook fast-path stored an episode ahead of the poll cycle",
    );
    return { status: "inserted", sourceId: record.sourceId };
  }
  if (report.duplicate === 1) return { status: "duplicate", sourceId: record.sourceId };
  // Refused by an ingest-core screen. Read off the report's own counter rather
  // than inferred from `!inserted && !duplicate`: the by-elimination form is
  // sound only while the batch is exactly one record, and would silently
  // mislabel a future outcome the report grows.
  const totalRefused = Object.values(report.refused).reduce((sum, n) => sum + n, 0);
  if (totalRefused === 0) {
    // Neither inserted, nor duplicate, nor refused — the report's arithmetic
    // does not add up for a one-record batch. Loud, because it means this
    // module's model of `ingestEpisodes` has drifted from the core's.
    log.error(
      { workspaceId, sourceId: record.sourceId, report },
      "Slack brain webhook: the ingest core reported neither an insert, a duplicate, nor a refusal for a single-record batch — treating it as not stored",
    );
  }
  return { status: "refused", sourceId: record.sourceId, pollBackstopped: backstopped };
}
