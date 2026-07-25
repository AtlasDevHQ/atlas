/**
 * The Slack chat-history vendor client (#4770, ADR-0036 §Ingestion &
 * connectors) — the thin half of the seam. It enumerates
 * `conversations.history` and converts messages to
 * {@link BrainEpisodeRecord}s. It owns NO scheduling and NO backoff policy:
 * cadence and 429 retry are the shared engine's. It DOES own bounding its own
 * fetch, because the engine hands it the per-sync budget as `maxEpisodes` and
 * refuses any batch that exceeds it.
 *
 * ## The walk, and why it is shaped this way
 *
 * Slack pages `conversations.history` NEWEST → oldest within `[oldest,
 * latest]`. That direction is the whole difficulty: if a pass runs out of
 * budget partway, it has covered the TOP of its window and left a hole at the
 * bottom — and an append-only store has no later pass that would notice the
 * hole, because "absent" and "not yet fetched" look identical.
 *
 * So the per-channel mark is a DISCRIMINATED UNION, not a bag of optionals:
 *
 *   - `contiguous` — covered end to end up to `ts` (the exclusive `oldest`
 *     bound of the next pass).
 *   - `backfilling` — a truncated window is being filled downward. `top` is
 *     the ceiling the truncated pass reached, `resume` is where the next pass
 *     continues walking down, and `ts` is still the untouched frontier. When
 *     the fill completes, the mark becomes `contiguous` at `top`.
 *
 * The union is what makes truncation both CONVERGENT (each cycle fills more of
 * the same window until it meets `ts`) and GAPLESS (the mark never jumps over
 * an unfetched range). It is a union rather than three optional fields because
 * `resume` WITHOUT `top` is unsound in a specific, silent way: the pass would
 * walk `[ts, resume]`, complete, take the ordinary completion branch, and
 * advance the mark to `now`, claiming coverage of `(resume, now]` it never
 * fetched. Optional fields made that state constructible from a hand-edited or
 * partially-written cursor; the union does not (`parseSlackHistoryCursor`
 * degrades such a cursor to `contiguous`, which over-crawls — a deduped no-op).
 *
 * ## Two budgets, because there are two costs
 *
 * `maxEpisodes` is a HARD contract: returning more makes the engine refuse the
 * whole batch (`episode-sync.ts`), and — because an error attempt COALESCEs the
 * old cursor forward — the next cycle would compute the identical over-cap
 * batch and fail identically, forever. So the walk trims to the budget and
 * records `resume` at the last message it WALKED, which turns an over-large
 * window into a normal truncation instead of a wedge. (Walked, not kept: a
 * message this pass skipped as noise is still a message this pass covered, and
 * resuming above it would re-read it forever.)
 *
 * That alone is not enough, because kept episodes are not the only cost: a
 * channel of pure join/leave noise keeps ZERO episodes while still costing a
 * Slack call per page. So the pass also carries a PAGE budget
 * ({@link HISTORY_MAX_PAGES_PER_PASS}), which bounds vendor calls regardless of
 * how much of what it reads is worth storing.
 *
 * ## Why `mode` does not change what this client fetches
 *
 * ADR-0036 repurposes ADR-0030's reconcile cadence to **re-run extraction**
 * (#4771) over a wider window — not to re-crawl the source. There is nothing
 * for a re-crawl to accomplish here: episodes are append-only, so a
 * reconciliation cannot archive absences, and a channel added since the last
 * pass has no mark and already backfills from the floor on an ordinary cycle.
 * An earlier cut had reconciliation rewind every channel to the floor; that
 * re-walked the same week every cycle, and — since an incomplete pass holds the
 * reconcile clock — it could not converge. `mode` stays on the seam because a
 * future source may need it; the ENGINE records it (in the sync report and its
 * log line) and this client never reads it.
 *
 * ## Why the engine's `since` is not used
 *
 * The engine's high-water mark is one timestamp per INSTALL; this cursor is one
 * per CHANNEL, which is strictly finer — a channel invited yesterday must
 * backfill from its own floor, not from the install's mark.
 *
 * ## What is deliberately not ingested
 *
 * Bot/app messages (`bot_id`) and membership noise (`channel_join`, topic
 * changes, …). Atlas's own Slack answers carry a `bot_id`, and ingesting them
 * would make the brain cite itself as evidence — the self-echo ADR-0036 §T9
 * neutralises on the write-back path for the same reason. Every skip is
 * COUNTED and surfaced, because "read 500 messages, stored 0" and "the channel
 * is empty" must not look the same to an operator.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { SYNC_OVERLAP_WINDOW_MS } from "@atlas/api/lib/knowledge/connector-sync";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import {
  fetchConversationHistoryPage,
  getConversationInfo,
  type SlackHistoryMessage,
  type SlackReadError,
} from "@atlas/api/lib/slack/api";
import { deriveChatChannelGrant } from "../grant";
import type {
  BrainEpisodeRecord,
  BrainSourceChanges,
  BrainSourceFetchParams,
  BrainSourceVendorClient,
} from "../types";
import { SLACK_HISTORY_SOURCE, slackEpisodeSourceId } from "./config";

const log = createLogger("brain.ingest.slack.client");

/**
 * Slack's RECOMMENDED page size for `conversations.history`. The documented
 * `limit` maximum is far higher (~1000), but Slack advises ≤200 and reserves
 * the right to return fewer; treating 200 as a hard vendor ceiling would be
 * wrong, and treating whatever it returns as "the page" is why the walk counts
 * actual messages rather than `pages * limit`.
 */
export const HISTORY_PAGE_LIMIT = 200;

/** Hard bound on pages per channel per pass — one bad channel can't hog the pass. */
export const HISTORY_MAX_PAGES_PER_CHANNEL = 50;

/**
 * Hard bound on Slack calls per PASS, across all channels.
 *
 * The episode budget cannot serve this purpose: a channel of pure join/leave
 * noise keeps zero episodes, so it spends none of `maxEpisodes` while spending
 * a Slack call per page. Without a separate page budget, 50 configured
 * channels × 50 pages is 2,500 calls in one cycle against a Tier-3 method —
 * i.e. the client burning the rate limit the engine's backoff then has to
 * absorb.
 */
export const HISTORY_MAX_PAGES_PER_PASS = 120;

/**
 * How far a channel's mark may be advanced past the newest message it actually
 * saw, when a window was covered end to end.
 *
 * Without it, a channel whose mark is old and which then goes quiet would
 * re-scan `[mark, now]` every cycle, and that window grows without bound until
 * it exceeds the budget. Advancing all the way to `now` would race messages in
 * flight: `ts` is stamped by SLACK's clock and the walk's `now` is ATLAS's, so
 * a message stamped just before our `now` can still arrive after we read the
 * last page.
 *
 * It is set to the engine's overlap window because five minutes is the right
 * order of magnitude for both and one number is cheaper to reason about than
 * two — NOT because they are the same mechanism. `SYNC_OVERLAP_WINDOW_MS`
 * rewinds a query's LOWER bound so a re-fetch can no-op in an upsert; this
 * holds back a mark's FORWARD advance. If either ever needs tuning
 * independently, split them rather than compromising on one value.
 */
export const SAFETY_LAG_MS = SYNC_OVERLAP_WINDOW_MS;

/**
 * Message subtypes that are not something a person said in the channel —
 * membership and channel bookkeeping (`channel_join`, topic/purpose/name
 * changes), app output (`bot_message`, which `bot_id` usually catches first),
 * and deleted-message placeholders (`tombstone`). Skipped as noise: each would
 * otherwise become an episode, and #4771 would spend an LLM call deciding that
 * "X joined the channel" contains no claim.
 *
 * A DENYLIST, not an allowlist: an unknown subtype is a message Slack added
 * that probably does carry content (`thread_broadcast`, `file_share`, …), and
 * defaulting those to "drop" would silently lose evidence, which is the one
 * failure mode an evidence store must not have.
 */
export const SKIPPED_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set([
  "channel_join",
  "channel_leave",
  "group_join",
  "group_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "bot_message",
  "tombstone",
]);

/**
 * Per-channel bookkeeping. See the module header for why this is a union.
 *
 * `ts` is the contiguous frontier in both arms. The `backfilling` arm adds the
 * pair — never one without the other — that a resumed walk needs.
 */
export type SlackChannelMark =
  | { readonly kind: "contiguous"; readonly ts: string }
  | {
      readonly kind: "backfilling";
      readonly ts: string;
      readonly top: string;
      readonly resume: string;
    };

/** The opaque cursor persisted in `knowledge_sync_state.sync_cursor`. */
export interface SlackHistoryCursor {
  readonly v: 1;
  readonly channels: Readonly<Record<string, { ts: string; top?: string; resume?: string }>>;
  /**
   * Index into the install's channel list where the NEXT pass starts walking.
   * Persisted so budget pressure circulates instead of always falling on the
   * same tail of the list.
   */
  readonly nextStart?: number;
}

/** What a cursor parse found — the marks plus anything it had to discard. */
export interface ParsedSlackHistoryCursor {
  readonly marks: Map<string, SlackChannelMark>;
  /** Where the next pass starts walking; 0 when absent or unusable. */
  readonly nextStart: number;
  /**
   * Channel ids whose stored mark was unusable and was dropped. NOT merely a
   * log line: dropping a mark makes that channel restart at the backfill
   * FLOOR, and when the lost mark was OLDER than the floor that is a forward
   * jump over history nobody will ever fetch. The caller reports these so the
   * loss lands in the sync state row rather than only in a log nobody tails.
   */
  readonly dropped: readonly string[];
}

/**
 * Parse the stored cursor. An unreadable cursor degrades rather than throwing:
 * throwing would wedge the source permanently on one bad row with no
 * operator-reachable repair, whereas re-crawling is a deduped no-op WRITE.
 *
 * Two things it will not do:
 *   - keep a `resume` without a `top` (see the module header — that pair is
 *     what stops a completing pass from claiming coverage it never fetched);
 *   - discard a mark silently. Every drop is named in {@link
 *     ParsedSlackHistoryCursor.dropped}.
 */
export function parseSlackHistoryCursor(raw: string | null): ParsedSlackHistoryCursor {
  const marks = new Map<string, SlackChannelMark>();
  const dropped: string[] = [];
  const empty = { marks, dropped, nextStart: 0 };
  if (raw === null || raw === "") return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Slack history cursor is not valid JSON — every channel restarts at the backfill floor",
    );
    return empty;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn({}, "Slack history cursor is not an object — every channel restarts at the backfill floor");
    return empty;
  }
  const outer = parsed as Record<string, unknown>;
  if (outer.v !== 1) {
    log.warn(
      { version: outer.v },
      "Slack history cursor has an unrecognised version — every channel restarts at the backfill floor",
    );
    return empty;
  }
  const channels = outer.channels;
  if (channels === null || typeof channels !== "object" || Array.isArray(channels)) {
    log.warn({}, "Slack history cursor carries no channel map — every channel restarts at the backfill floor");
    return empty;
  }

  for (const [channelId, value] of Object.entries(channels as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      dropped.push(channelId);
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.ts !== "string" || entry.ts === "" || !isNumericTs(entry.ts)) {
      dropped.push(channelId);
      continue;
    }
    const top = typeof entry.top === "string" && isNumericTs(entry.top) ? entry.top : null;
    const resume = typeof entry.resume === "string" && isNumericTs(entry.resume) ? entry.resume : null;
    // The pair is kept only when it is INTERNALLY CONSISTENT: `ts < resume ≤
    // top`. A half-pair or an out-of-order one degrades to `contiguous`, which
    // re-crawls `[ts, now]` — more work, no gap. Keeping half of it would
    // instead advance the mark over a range never fetched.
    if (
      top !== null &&
      resume !== null &&
      tsGreater(resume, entry.ts) &&
      !tsGreater(resume, top)
    ) {
      marks.set(channelId, { kind: "backfilling", ts: entry.ts, top, resume });
      continue;
    }
    if (top !== null || resume !== null) {
      log.warn(
        { channelId },
        "Slack history cursor has an inconsistent backfill pair — restarting that channel's window from its frontier",
      );
    }
    marks.set(channelId, { kind: "contiguous", ts: entry.ts });
  }

  if (dropped.length > 0) {
    log.warn(
      { channels: dropped },
      "Slack history cursor entries were unusable — those channels restart at the backfill floor, which skips anything older than it",
    );
  }
  const nextStart =
    typeof outer.nextStart === "number" && Number.isInteger(outer.nextStart) && outer.nextStart >= 0
      ? outer.nextStart
      : 0;
  return { marks, dropped, nextStart };
}

/**
 * Serialise whatever marks it is given — pruning REMOVED channels is the
 * CALLER's, and falls out of `fetchEpisodes` building its map exclusively from
 * `options.channels`. Stated here because a future caller passing an unfiltered
 * map would get no pruning and no warning.
 *
 * The cost of that pruning, stated because it is invisible otherwise: removing
 * a channel and RE-ADDING it later restarts it at the backfill floor, so
 * anything older than the floor at that moment is never ingested. Widening the
 * floor before re-adding is the workaround.
 */
export function serialiseSlackHistoryCursor(
  marks: ReadonlyMap<string, SlackChannelMark>,
  nextStart = 0,
): string {
  const channels: Record<string, { ts: string; top?: string; resume?: string }> = {};
  for (const [channelId, mark] of marks) {
    channels[channelId] =
      mark.kind === "backfilling"
        ? { ts: mark.ts, top: mark.top, resume: mark.resume }
        : { ts: mark.ts };
  }
  return JSON.stringify({ v: 1, channels, nextStart } satisfies SlackHistoryCursor);
}

/** Milliseconds → a Slack `ts` bound. Slack compares these numerically. */
export function msToSlackTs(ms: number): string {
  return (ms / 1000).toFixed(6);
}

/** A Slack `ts` → milliseconds, or null when it is not a finite number. */
export function slackTsToMs(ts: string): number | null {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * A Slack `ts` is `<seconds>.<microseconds>`. FULL-STRING matched, because
 * `parseFloat` prefix-parses — `"12abc"` would otherwise pass validation and be
 * sent to Slack verbatim as an `oldest` bound, turning a clean degrade-to-floor
 * into a per-cycle vendor rejection.
 */
function isNumericTs(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number.parseFloat(value));
}

/**
 * Numeric comparison. Today's Slack `ts` values are fixed-width (`10.6`) and
 * would in fact sort lexicographically, but they ARE numbers — Slack compares
 * them numerically, and a width change (or a hand-written bound like `"1.0"`
 * from a repaired cursor) would silently reorder a text sort.
 */
function tsGreater(a: string, b: string): boolean {
  return Number.parseFloat(a) > Number.parseFloat(b);
}

/** The Slack surface this client needs — injectable so tests need no HTTP. */
export interface SlackHistoryApi {
  readonly getConversationInfo: typeof getConversationInfo;
  readonly fetchConversationHistoryPage: typeof fetchConversationHistoryPage;
}

export interface SlackHistoryClientOptions {
  readonly token: string;
  readonly channels: readonly string[];
  /** How far back a never-synced channel backfills. */
  readonly backfillWindowMs: number;
  /** Test-only injection. */
  readonly api?: SlackHistoryApi;
  /** Test-only clock. */
  readonly now?: () => Date;
}

/**
 * Turn a Slack read failure into the shared throttle vocabulary, or a plain
 * `Error`. `ratelimited` becomes {@link ConnectorRateLimitError} so the
 * ENGINE's bounded backoff applies unchanged — a client that retried on its
 * own would be exactly the per-vendor backoff ADR-0030 forbids.
 *
 * The non-throttle arms mirror the install handler's table on purpose: an
 * admin who saw "invite the Atlas bot" at install time should see the same
 * sentence if the bot is later removed, not a raw Slack error code.
 */
function toClientError(context: string, failure: SlackReadError): Error {
  switch (failure.error) {
    case "ratelimited":
      return new ConnectorRateLimitError(
        `Slack is rate limiting ${context}`,
        failure.retryAfterSeconds,
      );
    case "missing_scope":
      return new Error(
        `The Slack connection is missing the history scopes (channels:history / groups:history) needed to read ${context} — reconnect Slack under Admin → Integrations to grant them.`,
      );
    case "not_in_channel":
      return new Error(
        `Atlas is not a member of ${context} — invite the Atlas bot to the channel, then sync again.`,
      );
    case "channel_not_found":
      return new Error(
        `Slack no longer recognises ${context} — it may have been deleted, or the id may have changed. Re-install this source with the current channel list.`,
      );
    case "invalid_auth":
    case "token_revoked":
    case "account_inactive":
      return new Error(
        `The workspace's Slack connection is no longer valid (${failure.error}) — reconnect Slack under Admin → Integrations, then sync again.`,
      );
    default:
      return new Error(`Slack rejected the request for ${context}: ${failure.error}`);
  }
}

/** Per-channel drop tally — every message read but not stored, by reason. */
interface ChannelSkips {
  bot: number;
  subtype: number;
  emptyText: number;
}

/** One channel's pass result. */
interface ChannelPass {
  readonly episodes: readonly BrainEpisodeRecord[];
  readonly mark: SlackChannelMark;
  /** True when the pass ran out of budget/pages before covering its window. */
  readonly truncated: boolean;
  /** Raw messages read from Slack, whether or not they were kept. */
  readonly walked: number;
  readonly pages: number;
  /** Entries Slack returned that carried no usable identity (see the walk). */
  readonly unidentifiable: number;
  /**
   * True when the pass truncated with NO resumable window — it made no progress
   * and will not on its own. Distinct from an ordinary truncation, because the
   * two need different words: a backlog continues next cycle, a stall does not.
   */
  readonly stalled: boolean;
  readonly skips: ChannelSkips;
}

export function createSlackHistoryClient(
  options: SlackHistoryClientOptions,
): BrainSourceVendorClient {
  const api: SlackHistoryApi = options.api ?? {
    getConversationInfo,
    fetchConversationHistoryPage,
  };
  const now = options.now ?? (() => new Date());

  async function runChannel(
    channelId: string,
    existing: SlackChannelMark | undefined,
    floorTs: string,
    budget: { episodes: number; pages: number },
  ): Promise<ChannelPass> {
    // Visibility first: the grant is derived from it, and ADR-0036 §T6 puts
    // source-principal-resolution failure on the BLOCK side — so a channel we
    // cannot classify contributes nothing rather than defaulting to `org`.
    const info = await api.getConversationInfo(options.token, channelId);
    if (!info.ok) throw toClientError(`channel ${channelId}`, info);
    const grant = deriveChatChannelGrant({
      source: SLACK_HISTORY_SOURCE,
      channelId,
      isPrivate: info.channel.isPrivate,
    });
    if (grant === null) {
      throw new Error(
        `Could not derive an access grant for Slack channel ${channelId} — nothing was ingested from it.`,
      );
    }

    const oldest = existing?.ts ?? floorTs;
    const windowTop = existing?.kind === "backfilling" ? existing.top : null;
    const resume = existing?.kind === "backfilling" ? existing.resume : null;

    const episodes: BrainEpisodeRecord[] = [];
    const skips: ChannelSkips = { bot: 0, subtype: 0, emptyText: 0 };
    let newestSeen: string | null = null;
    /** The oldest ts the pass covered CONTIGUOUSLY from its ceiling downward. */
    let coveredDownTo: string | null = null;
    let cursor: string | undefined;
    let pages = 0;
    let walked = 0;
    let unidentifiable = 0;
    let truncated = false;
    const maxPages = Math.min(HISTORY_MAX_PAGES_PER_CHANNEL, budget.pages);

    for (;;) {
      if (pages >= maxPages) {
        truncated = true;
        break;
      }
      const page = await api.fetchConversationHistoryPage(options.token, {
        channel: channelId,
        oldest,
        ...(pages === 0 && resume !== null ? { latest: resume } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        limit: HISTORY_PAGE_LIMIT,
      });
      if (!page.ok) throw toClientError(`channel ${channelId}`, page);
      pages++;
      if (page.dropped > 0) {
        // Messages Slack returned that carry no usable identity. They sit
        // INSIDE the window this pass is about to mark covered, so advancing
        // the mark past them would be the silent skip this walk exists to
        // prevent. Truncating instead re-reads them next cycle.
        //
        // NOTE this does not by itself get PAST a persistently-malformed page:
        // the mark is preserved, so the next cycle walks the same window and
        // stops in the same place. That is a VISIBLE stall — the warning and
        // `coverageIncomplete` fire every cycle — never a silent skip, which is
        // the trade this store makes everywhere.
        unidentifiable += page.dropped;
        truncated = true;
        break;
      }

      let budgetHit = false;
      for (const message of page.messages) {
        // The episode budget is a HARD contract with the engine, so it is
        // checked BEFORE each record is kept, not once per page. Stopping here
        // leaves `coveredDownTo` at the last message we actually kept, which is
        // exactly the `resume` the next pass needs — an over-large window
        // becomes an ordinary truncation instead of a refused batch.
        if (episodes.length >= budget.episodes) {
          budgetHit = true;
          truncated = true;
          break;
        }
        walked++;
        if (newestSeen === null || tsGreater(message.ts, newestSeen)) newestSeen = message.ts;
        coveredDownTo = message.ts;
        const record = toEpisode(channelId, message, grant, skips);
        if (record !== null) episodes.push(record);
      }
      if (budgetHit) break;

      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    if (!truncated) {
      // Window covered end to end. WHERE the mark lands depends on where the
      // window ENDED, and conflating the two cases loses history:
      //
      //   - completing a backfill (`windowTop` set) — the window ends at `top`,
      //     NOT at now. Anything above `top` has never been fetched, so
      //     advancing past it would skip that range permanently.
      //   - an ordinary pass — the walk had no `latest` bound, so it ran to
      //     now. The mark takes `max(newest seen, now − SAFETY_LAG)`. The lag
      //     floor applies whether or not the window was empty: the window was
      //     PROVEN covered, so a quiet stretch is genuinely covered too, and
      //     without the floor a channel that goes quiet would re-scan an
      //     ever-growing window until it exceeded the budget.
      if (windowTop !== null) {
        return {
          episodes,
          mark: { kind: "contiguous", ts: windowTop },
          truncated: false,
          walked,
          pages,
          unidentifiable,
          stalled: false,
          skips,
        };
      }
      const lagTs = msToSlackTs(now().getTime() - SAFETY_LAG_MS);
      let next = oldest;
      for (const candidate of [newestSeen, lagTs]) {
        if (candidate !== null && tsGreater(candidate, next)) next = candidate;
      }
      return {
        episodes,
        mark: { kind: "contiguous", ts: next },
        truncated: false,
        walked,
        pages,
        unidentifiable,
        stalled: false,
        skips,
      };
    }

    // Truncated: keep what was fetched (episodes are idempotent, so landing the
    // top of the window early is pure gain) but do NOT advance `ts` — the
    // bottom of the window is still unfetched. `top` remembers the ceiling so
    // the completing pass knows where to advance to; `resume` is where the next
    // pass continues downward.
    //
    // A truncated pass with no resumable window — it covered nothing, or what
    // it covered is not consistently below its own ceiling — KEEPS the mark it
    // came in with, so the next cycle picks up exactly where this one did. It is
    // logged as its own condition because the generic "more history than one
    // cycle can read" message would misdiagnose a stall as a backlog.
    // The pair must satisfy the same `ts < resume ≤ top` the parser enforces.
    // Emitting a half-consistent one would be the producer creating the state
    // the parser exists to reject — and the parser would then silently degrade
    // it, quietly discarding the backfill this pass just earned.
    // Frozen into `const`s so the guard below NARROWS them — a `let` would
    // force a non-null assertion at the construction site, which is the one
    // place this module cannot afford to assert rather than prove.
    const covered = coveredDownTo;
    const ceiling = windowTop ?? newestSeen;
    const consistent =
      covered !== null &&
      ceiling !== null &&
      tsGreater(covered, oldest) &&
      !tsGreater(covered, ceiling);
    if (!consistent) {
      // No resumable window: the pass covered nothing, or what it covered does
      // not sit consistently below its own ceiling. KEEP THE INCOMING MARK.
      // Degrading an in-flight `backfilling` mark to `contiguous` would throw
      // away a window whose bottom is unfetched — and because the next pass
      // then walks from `now` again, hits the same obstacle, and degrades
      // again, that is a fixed point rather than a delay: the channel never
      // converges and consumes the shared budget forever trying.
      log.warn(
        { channelId, pages, oldest, coveredDownTo: covered, ceiling, kept: existing?.kind ?? "none" },
        "Slack history pass was truncated with no resumable window — the channel makes no progress this cycle and will not on its own",
      );
      return {
        episodes,
        mark: existing ?? { kind: "contiguous", ts: oldest },
        truncated: true,
        walked,
        pages,
        unidentifiable,
        stalled: true,
        skips,
      };
    }
    return {
      episodes,
      mark: { kind: "backfilling", ts: oldest, top: ceiling, resume: covered },
      truncated: true,
      walked,
      pages,
      unidentifiable,
      stalled: false,
      skips,
    };
  }

  return {
    async fetchEpisodes(params: BrainSourceFetchParams): Promise<BrainSourceChanges> {
      const { marks, dropped, nextStart } = parseSlackHistoryCursor(params.cursor);
      const floorTs = msToSlackTs(now().getTime() - options.backfillWindowMs);

      const nextMarks = new Map<string, SlackChannelMark>();
      const episodes: BrainEpisodeRecord[] = [];
      const warnings: string[] = [];
      let coverageIncomplete = false;
      let remainingEpisodes = params.maxEpisodes;
      let remainingPages = HISTORY_MAX_PAGES_PER_PASS;
      const totals: ChannelSkips = { bot: 0, subtype: 0, emptyText: 0 };
      let walked = 0;

      for (const channelId of dropped) {
        if (!options.channels.includes(channelId)) continue;
        coverageIncomplete = true;
        warnings.push(
          `Channel ${channelId} had an unreadable sync mark — it restarts at the backfill window, so anything older than that is not ingested.`,
        );
      }

      // ROTATE the starting channel each pass. A fixed order plus one shared
      // budget is deterministic starvation: on the 250-record tiers a single
      // busy channel takes the whole cap every cycle, and channels after it are
      // never read — not slowly, never. Rotating makes the budget circulate, so
      // "not read this cycle" is genuinely this cycle.
      const start = options.channels.length === 0 ? 0 : nextStart % options.channels.length;
      const ordered = [...options.channels.slice(start), ...options.channels.slice(0, start)];
      let advancedTo = start;

      for (const channelId of ordered) {
        const existing = marks.get(channelId);

        if (remainingEpisodes <= 0 || remainingPages <= 0) {
          // Out of budget: leave this channel's mark untouched so the next
          // cycle picks it up exactly where it was.
          if (existing !== undefined) nextMarks.set(channelId, existing);
          coverageIncomplete = true;
          // Name the budget that ACTUALLY ran out. Blaming the record cap when
          // the page budget bound sends the operator to raise a plan limit that
          // was never the constraint — the noisy-channel case the page budget
          // exists for is exactly when the two diverge.
          warnings.push(
            remainingEpisodes <= 0
              ? `Channel ${channelId} was not read this cycle — the per-sync record budget (${params.maxEpisodes}) was reached first. It resumes next cycle.`
              : `Channel ${channelId} was not read this cycle — the per-pass Slack page budget (${HISTORY_MAX_PAGES_PER_PASS}) was spent on earlier channels. It resumes next cycle.`,
          );
          continue;
        }

        let pass: ChannelPass;
        try {
          pass = await runChannel(channelId, existing, floorTs, {
            episodes: remainingEpisodes,
            pages: remainingPages,
          });
        } catch (err) {
          // Per-channel isolation, matching the engine's per-collection
          // posture: one misconfigured channel must not cost the others their
          // cycle. Its mark stays put, so nothing is skipped.
          //
          // A rate limit is the one failure that also stops the PASS: Slack is
          // telling us to stop talking, and the remaining channels would each
          // earn their own 429. But the pass still RETURNS rather than throwing
          // once anything has been collected — throwing would discard the
          // episodes and marks earned by the channels that already succeeded,
          // and (because a throttled multi-channel crawl is the steady state,
          // not an exception) the same prefix would be re-walked and re-lost on
          // every cycle. Only a pass that has nothing to bank rethrows, so the
          // ENGINE's backoff still owns the retry.
          const throttled = err instanceof ConnectorRateLimitError;
          if (throttled && episodes.length === 0 && nextMarks.size === 0) throw err;
          if (existing !== undefined) nextMarks.set(channelId, existing);
          coverageIncomplete = true;
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(
            throttled
              ? `Channel ${channelId} and any channels after it were not read — Slack is rate limiting this workspace. They resume on the next cycle.`
              : `Channel ${channelId} was skipped: ${message}`,
          );
          log.warn(
            { channelId, err: message, throttled },
            throttled
              ? "Slack rate limit mid-pass — banking the channels already read and stopping"
              : "Slack history channel pass failed — continuing with the remaining channels",
          );
          if (throttled) break;
          continue;
        }

        nextMarks.set(channelId, pass.mark);
        advancedTo = (options.channels.indexOf(channelId) + 1) % options.channels.length;
        episodes.push(...pass.episodes);
        remainingEpisodes -= pass.episodes.length;
        remainingPages -= pass.pages;
        walked += pass.walked;
        totals.bot += pass.skips.bot;
        totals.subtype += pass.skips.subtype;
        totals.emptyText += pass.skips.emptyText;
        if (pass.unidentifiable > 0) {
          coverageIncomplete = true;
          warnings.push(
            `Channel ${channelId}: Slack returned ${pass.unidentifiable} message(s) with no usable identity — that part of the window was not marked covered and is re-read next cycle.`,
          );
        } else if (pass.stalled) {
          // A stall is NOT a backlog. Telling the operator to narrow the
          // backfill window would be the same misdiagnosis the log line at the
          // stall site is careful to avoid — the window is not too big, the
          // channel is not moving.
          coverageIncomplete = true;
          warnings.push(
            `Channel ${channelId} made no progress this cycle and will not on its own — Slack returned nothing this pass could resume from. Check the API logs for that channel.`,
          );
        } else if (pass.truncated) {
          coverageIncomplete = true;
          warnings.push(
            `Channel ${channelId} has more history than one cycle can read — the backlog continues on the next cycle. Lower ATLAS_BRAIN_CHAT_BACKFILL_DAYS to narrow a first sync.`,
          );
        }
      }

      if (walked > 0 && episodes.length === 0) {
        // "Read 500 messages, stored 0" and "the channel is empty" must not
        // look the same. Most often this is a channel of bot output or of
        // attachment-only posts (Slack puts their content in `files`/`blocks`,
        // leaving `text` empty — richer extraction is M3's).
        warnings.push(
          `Read ${walked} Slack messages but stored none: ${totals.bot} from bots/apps, ${totals.subtype} channel-membership events, ${totals.emptyText} with no message text.`,
        );
      }
      if (totals.bot + totals.subtype + totals.emptyText > 0) {
        log.info(
          { walked, kept: episodes.length, ...totals },
          "Slack history pass complete — messages read but not stored, by reason",
        );
      }

      // Any channel this pass never REACHED keeps the mark it came in with.
      //
      // This is structural on purpose. `serialiseSlackHistoryCursor` writes a
      // whole-cursor REPLACEMENT and the state upsert only COALESCEs a NULL
      // cursor forward — so a channel missing from `nextMarks` is a channel
      // whose mark is deleted, which restarts it at the backfill floor and, if
      // its frontier was older than the floor, jumps forward over history
      // nothing will ever re-fetch. Handling that per-branch is how the
      // rate-limit `break` above lost every channel after the throttled one;
      // doing it once, here, means no future `break`/`return` can reintroduce
      // it. Iterating `options.channels` keeps REMOVED channels pruned.
      for (const channelId of options.channels) {
        if (nextMarks.has(channelId)) continue;
        const existing = marks.get(channelId);
        if (existing !== undefined) nextMarks.set(channelId, existing);
      }

      // The mark the ENGINE persists is coarse (one per install) and this
      // source's real bookkeeping is the per-channel cursor. It is still
      // reported honestly: `null` whenever coverage was incomplete, because
      // `BrainSourceChanges` requires a high-water mark to cover only the
      // CONTIGUOUS part of the window, and a truncated pass's newest episode is
      // the top of a window whose bottom is unfetched. The state upsert
      // COALESCEs the previous mark forward, so null loses nothing.
      let highWaterMark: string | null = null;
      if (!coverageIncomplete) {
        for (const record of episodes) {
          if (record.occurredAt === null) continue;
          const iso = record.occurredAt.toISOString();
          if (highWaterMark === null || iso > highWaterMark) highWaterMark = iso;
        }
      }

      return {
        episodes,
        highWaterMark,
        cursor: serialiseSlackHistoryCursor(nextMarks, advancedTo),
        coverageIncomplete,
        warnings,
      };
    },
  };
}

/**
 * One Slack message → an episode record, or null when it is not evidence.
 * Increments `skips` by reason, so a channel that yields nothing can say why.
 *
 * SCOPE: only what `conversations.history` returns — top-level channel posts
 * and `thread_broadcast` copies. THREAD REPLIES ARE NOT FETCHED AT ALL (that
 * needs `conversations.replies`, which M1 does not call), so they never reach
 * this function and are absent from every skip tally. A thread-heavy channel
 * therefore ingests only its top-level messages; see
 * `docs/development/brain-slack-history.md`.
 *
 * Exported for the client's own tests: the source-id contract and the skip
 * rules are the two things a future webhook writer (M3) must match exactly,
 * and a test that can call this directly can pin them without a fake HTTP
 * layer in between.
 */
export function toEpisode(
  channelId: string,
  message: SlackHistoryMessage,
  grant: readonly string[],
  skips: ChannelSkips = { bot: 0, subtype: 0, emptyText: 0 },
): BrainEpisodeRecord | null {
  if (message.botId !== null) {
    skips.bot++;
    return null;
  }
  if (message.subtype !== null && SKIPPED_MESSAGE_SUBTYPES.has(message.subtype)) {
    skips.subtype++;
    return null;
  }
  if (message.text.trim() === "") {
    // `chk_brain_episodes_body_xor_locator` refuses `''` outright, so there is
    // nothing to store. This DOES drop attachment/blocks-only posts whose
    // content lives outside `text` — counted rather than silent, and richer
    // extraction is M3's (see docs/development/brain-slack-history.md).
    skips.emptyText++;
    return null;
  }

  const occurredMs = slackTsToMs(message.ts);
  return {
    sourceId: slackEpisodeSourceId(channelId, message.ts),
    sourceActor: message.user,
    body: message.text,
    occurredAt: occurredMs === null ? null : new Date(occurredMs),
    visibleTo: grant,
  };
}
