/**
 * The Zoom transcript vendor client (#4965) — the thin half of #4963's seam. It
 * enumerates cloud recordings, derives each meeting's audience, downloads the
 * transcript, and converts it to a {@link BrainEpisodeRecord}. It owns NO
 * scheduling and NO backoff policy: cadence and 429 retry are the shared
 * engine's. It DOES own bounding its own fetch, because the engine hands it the
 * per-sync budget as `maxEpisodes` and refuses any batch that exceeds it.
 *
 * **The shared ingest ENGINE did not change to add this file** — `episode-sync.ts`,
 * `episodes.ts` and `ingest/types.ts` are all untouched. That is #4965's other
 * job: it is the first connector built ON #4963's seam rather than extracted
 * from one, so it is the proof the seam holds.
 *
 * The one shared file this connector does extend is `ingest/grant.ts`, which
 * gains the transcript class's deriver alongside the chat one — ADDITIVELY, as
 * a new function with no public arm, never by branching the existing deriver.
 * Stated precisely because "nothing outside `zoom/` changed" is the stronger
 * claim and it is not true.
 *
 * ## The window walk, and why it is date-granular
 *
 * Zoom's account-recordings endpoint takes `from`/`to` as DATES, caps the span
 * at ONE MONTH, and serves at most the last six months. So the walk is a
 * sequence of ≤30-day date windows from the cursor's frontier to today, and the
 * cursor stores a DATE rather than an instant.
 *
 * That coarseness costs a re-scan of the frontier day on every cycle, which is
 * a deduped no-op WRITE (the source-id dedupe absorbs it) and a handful of
 * vendor calls. The alternative — storing an instant and filtering client-side
 * — would buy nothing, because the vendor's own filter is the only one that
 * bounds what we PAGE through.
 *
 * The mark advances only to the last day covered CONTIGUOUSLY. A pass that runs
 * out of budget partway leaves the mark where it was, so the next cycle re-reads
 * the same window rather than jumping over the part it never fetched — the same
 * "absent and not-yet-fetched look identical in an append-only store" argument
 * `slack/client.ts` makes at length.
 *
 * ## The block-vs-flag split, made structural
 *
 * ADR-0036 §T6 puts grant-derivation failure on the BLOCK side and entity
 * resolution on the FLAG side, and a transcript produces plenty of the latter.
 * This client keeps them apart by construction rather than by rule:
 *
 *   - it resolves exactly ONE thing, the meeting AUDIENCE, and a meeting whose
 *     audience it cannot establish is SKIPPED — the meeting contributes no
 *     episode, the pass reports `coverageIncomplete`, a warning names it, and
 *     the mark is not advanced past it. There is no fallback grant;
 *   - it resolves NO entities. Speaker labels stay as text inside the body
 *     (`vtt.ts`), so "who is Sam" is decided by the extraction stage (#4771),
 *     where a failure flags the fact `provisional`. This client has no code
 *     path that could turn an unrecognised speaker into a block, because it has
 *     no code path that looks at speakers at all.
 *
 * ## Extraction stays async
 *
 * `BrainEpisodeRecord` has no `extractedAt`, so this client cannot stamp one
 * even by accident, and it calls nothing in `lib/brain/extract.ts`. Transcripts
 * land with `extracted_at IS NULL` and the extraction fiber drains them on its
 * own clock. There is no synchronous fast-path, and the type is what prevents
 * one.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import { AUDIENCE_PREFIX } from "@atlas/api/lib/brain/acl";
import { deriveMeetingParticipantGrant } from "../grant";
import type {
  BrainEpisodeRecord,
  BrainSourceChanges,
  BrainSourceFetchParams,
  BrainSourceVendorClient,
} from "../types";
import {
  fetchAccountRecordingsPage,
  fetchTranscriptText,
  type ZoomReadError,
  type ZoomRecordingMeeting,
} from "./api";
import { readMeetingRoster, reconcileMeetingAudience, type ZoomAudienceDeps } from "./audience";
import {
  ZOOM_TRANSCRIPT_SOURCE,
  isTranscriptFile,
  zoomEpisodeSourceId,
} from "./config";
import { vttToBody } from "./vtt";

const log = createLogger("brain.ingest.zoom.client");

/** Meetings per recordings page. Zoom's documented maximum is 300. */
export const RECORDINGS_PAGE_LIMIT = 300;

/** Hard bound on recordings pages per pass — one install can't hog the cycle. */
export const MAX_RECORDINGS_PAGES_PER_PASS = 60;

/** Zoom caps a recordings query's span at one month; 30 days is inside it. */
export const MAX_WINDOW_DAYS = 30;

/**
 * Largest transcript this connector will store, in bytes.
 *
 * An oversize transcript is SKIPPED WITH A WARNING, never truncated. Truncating
 * evidence is the one thing an evidence store must not do quietly: half a
 * meeting reads as a whole meeting to every downstream consumer, and the
 * extractor would produce confident facts from a conversation whose ending it
 * never saw. A skip is visible, counted, and repairable by raising this bound.
 */
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

/** The opaque cursor persisted in `knowledge_sync_state.sync_cursor`. */
export interface ZoomTranscriptCursor {
  readonly v: 1;
  /** The last DATE (YYYY-MM-DD) covered contiguously. */
  readonly coveredThrough: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A `Date` → Zoom's `YYYY-MM-DD`, in UTC. */
export function toZoomDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Add whole days to a `YYYY-MM-DD`, in UTC.
 *
 * Anchored at `T00:00:00Z` and stepped in whole days, so it never crosses a DST
 * boundary the way a local-time `setDate` would — the walk's windows must tile
 * exactly, and a 23-hour day would leave a one-day hole nothing re-reads.
 */
export function addDays(date: string, days: number): string {
  return toZoomDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));
}

/**
 * Parse the stored cursor. An unreadable cursor DEGRADES to "no mark" rather
 * than throwing — throwing would wedge the source permanently on one bad row
 * with no operator-reachable repair, whereas re-crawling from the backfill
 * floor is a deduped no-op write. Every degrade is logged, because the loss is
 * real when the lost mark was OLDER than the floor: that history is then never
 * fetched.
 */
export function parseZoomCursor(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Zoom transcript cursor is not valid JSON — restarting at the backfill floor",
    );
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn({}, "Zoom transcript cursor is not an object — restarting at the backfill floor");
    return null;
  }
  const outer = parsed as Record<string, unknown>;
  if (outer.v !== 1) {
    log.warn(
      { version: outer.v },
      "Zoom transcript cursor has an unrecognised version — restarting at the backfill floor",
    );
    return null;
  }
  const covered = outer.coveredThrough;
  if (typeof covered !== "string" || !ISO_DATE.test(covered)) {
    log.warn({}, "Zoom transcript cursor carries no usable date — restarting at the backfill floor");
    return null;
  }
  return covered;
}

export function serialiseZoomCursor(coveredThrough: string): string {
  return JSON.stringify({ v: 1, coveredThrough } satisfies ZoomTranscriptCursor);
}

/**
 * Turn a Zoom read failure into the shared throttle vocabulary, or a plain
 * `Error`. `ratelimited` becomes {@link ConnectorRateLimitError} so the
 * ENGINE's bounded backoff applies unchanged — a client that retried on its own
 * would be exactly the per-vendor backoff ADR-0030 forbids.
 *
 * The non-throttle sentences are admin-facing and name the repair, because they
 * land in `knowledge_sync_state.error` where an operator reads them.
 */
export function toZoomClientError(context: string, failure: ZoomReadError): Error {
  switch (failure.error) {
    case "ratelimited":
      return new ConnectorRateLimitError(
        `Zoom is rate limiting ${context}`,
        failure.retryAfterSeconds,
      );
    case "invalid_auth":
      return new Error(
        `The workspace's Zoom credential was rejected while reading ${context} — check the Server-to-Server OAuth app's client id and secret under Admin → Integrations, then sync again.`,
      );
    case "missing_scope":
      return new Error(
        `The Zoom app is missing the scopes needed to read ${context} (cloud_recording:read:admin and meeting:read:admin) — add them to the Server-to-Server OAuth app, reactivate it, then sync again.`,
      );
    case "plan_required":
      return new Error(
        `This Zoom account's plan does not include the API needed to read ${context} — cloud recording and past-meeting reports need a paid plan.`,
      );
    case "not_found":
      return new Error(
        `Zoom no longer recognises ${context} — the recording may have been deleted or moved to trash.`,
      );
    case "too_large":
      // Reachable only if a caller throws on this instead of skipping it (the
      // connector does not). The `default` arm's "Zoom rejected the request"
      // would be a lie — Atlas refused — and would name no cap and no repair.
      return new Error(
        `${context} is larger than the ${MAX_TRANSCRIPT_BYTES / 1_048_576}MB limit Atlas stores — it was not ingested. Nothing partial is stored.`,
      );
    default:
      return new Error(`Zoom rejected the request for ${context}: ${failure.error}`);
  }
}

/** Per-pass drop tally — every transcript seen but not stored, by reason. */
interface TranscriptSkips {
  /** Meetings blocked because their audience could not be established. */
  blockedAudience: number;
  /** Transcripts skipped as oversize. */
  oversize: number;
  /** Transcripts that parsed to no speech at all. */
  emptyBody: number;
  /** Files whose ids would not build a source-id. */
  unidentifiable: number;
}

export interface ZoomTranscriptClientOptions {
  readonly workspaceId: string;
  /** Resolves the Server-to-Server bearer token. Called once per pass. */
  readonly resolveToken: () => Promise<string>;
  readonly accountId: string;
  /** Empty means the whole account — see `config.ts`. */
  readonly hosts: readonly string[];
  /** How far back a never-synced install backfills. */
  readonly backfillWindowMs: number;
  /** Test-only injection. */
  readonly api?: {
    readonly fetchAccountRecordingsPage: typeof fetchAccountRecordingsPage;
    readonly fetchTranscriptText: typeof fetchTranscriptText;
  };
  /** Test-only injection for the audience half. */
  readonly audienceDeps?: ZoomAudienceDeps;
  /** Test-only clock. */
  readonly now?: () => Date;
}

export function createZoomTranscriptClient(
  options: ZoomTranscriptClientOptions,
): BrainSourceVendorClient {
  const api = options.api ?? { fetchAccountRecordingsPage, fetchTranscriptText };
  const now = options.now ?? (() => new Date());
  const audienceDeps = options.audienceDeps ?? {};

  /**
   * One meeting → its transcript episodes, plus whether it was BLOCKED.
   *
   * `blocked` is returned rather than left to the caller to infer from an empty
   * episode list, because the two empty cases mean opposite things and only one
   * of them may let the mark advance:
   *
   *   - out of scope, or no transcript file yet → nothing to ingest, the window
   *     IS covered, the mark may pass;
   *   - audience underivable → the window is NOT covered. The meeting must be
   *     retried, so the pass reports `coverageIncomplete` and the high-water
   *     mark stays put.
   *
   * Conflating them is how a blocked meeting gets skipped permanently: the pass
   * reports itself fully covered, the mark advances past the meeting, and no
   * later cycle ever looks at it again. (That is not hypothetical — the first
   * cut of this function returned a bare array and did exactly that.)
   *
   * The AUDIENCE is established FIRST, before a byte of transcript is fetched.
   * That ordering is the block arm: a meeting Atlas cannot grant must not have
   * its content downloaded at all, let alone stored — and doing the cheap,
   * decisive read first also stops a blocked meeting spending a large download.
   */
  async function runMeeting(
    token: string,
    meeting: ZoomRecordingMeeting,
    grantedHosts: ReadonlySet<string> | null,
    budget: { episodes: number },
    skips: TranscriptSkips,
    warnings: string[],
  ): Promise<{
    readonly episodes: readonly BrainEpisodeRecord[];
    readonly blocked: boolean;
    /** The episode budget ran out mid-meeting — its later segments are unread. */
    readonly truncated: boolean;
    /** A transcript file was not downloadable YET — the window must be re-read. */
    readonly notReady: boolean;
  }> {
    if (grantedHosts !== null && (meeting.hostId === null || !grantedHosts.has(meeting.hostId))) {
      // Outside the configured scope. Not a skip to report — the admin asked
      // for exactly these hosts — so it is not counted in `skips`, and the
      // window IS covered: there was nothing here to ingest.
      return { episodes: [], blocked: false, truncated: false, notReady: false };
    }
    const transcripts = meeting.files.filter(isTranscriptFile);
    // No transcript file YET is not a block. Zoom publishes the VTT minutes
    // after the recording, so this is the ordinary state of a just-finished
    // meeting. The mark may pass; the next poll re-reads the frontier day
    // anyway, which is what eventually picks the transcript up.
    //
    // ⚠️ The POLL is the only thing that picks it up. This comment used to say
    // #4967's `recording.transcript_completed` webhook did it "promptly" —
    // #4967 shipped Slack-only and there is no Zoom webhook, so a maintainer
    // reasoning about transcript latency from that line would be wrong by a
    // whole poll interval.
    if (transcripts.length === 0) return { episodes: [], blocked: false, truncated: false, notReady: false };

    // ── The BLOCK arm ─────────────────────────────────────────────────────
    // The roster is narrowed FIRST, before the grant is derived, so that
    // `roster.participants` below is control-flow narrowed and the reconcile
    // cannot be handed a `[]` fallback. The earlier shape passed
    // `rosterComplete: roster.complete` and then wrote `roster.complete ?
    // roster.participants : []` — dead today, but a mass revocation the moment
    // anything reordered these two guards, and TypeScript could not see it.
    const roster = await readMeetingRoster(token, meeting.uuid, audienceDeps);
    const grant = roster.complete
      ? deriveMeetingParticipantGrant({
          source: ZOOM_TRANSCRIPT_SOURCE,
          meetingId: meeting.uuid,
          rosterComplete: true,
        })
      : null;
    if (grant === null || !roster.complete) {
      // ADR-0036 §T6: grant-derivation failure BLOCKS and LOGS. Nothing from
      // this meeting is ingested, and there is no wider-grant fallback — `[org]`
      // would publish a meeting whose audience Atlas failed to establish.
      skips.blockedAudience++;
      const reason = roster.complete
        ? "its meeting id could not be used to build an audience"
        : roster.reason;
      warnings.push(
        `Meeting ${meeting.uuid} was NOT ingested — ${reason}. Nothing from it is stored; it is retried next cycle.`,
      );
      log.warn(
        { workspaceId: options.workspaceId, meetingUuid: meeting.uuid, reason },
        "Zoom meeting blocked — no access grant could be derived, so nothing was ingested from it",
      );
      return { episodes: [], blocked: true, truncated: false, notReady: false };
    }

    // Membership BEFORE episodes — see `audience.ts` for why the two failure
    // orders are not symmetric. A throw here is caught by the caller and blocks
    // the meeting, which is correct: an audience we could not write is an
    // audience nobody is in.
    const audienceId = grant[0].slice(AUDIENCE_PREFIX.length);
    const reconciled = await reconcileMeetingAudience(
      { workspaceId: options.workspaceId, audienceId, participants: roster.participants },
      audienceDeps,
    );

    const episodes: BrainEpisodeRecord[] = [];
    let truncated = false;
    /** A transcript Zoom has not finished publishing — retry, do not skip. */
    let notReady = false;
    for (const file of transcripts) {
      if (episodes.length >= budget.episodes) {
        // A stop/restart recording legitimately has several transcript files.
        // Dropping the later ones silently would mark the meeting covered with
        // part of it unread, so the caller must hear about it.
        truncated = true;
        break;
      }
      if (file.downloadUrl === null) {
        // Zoom omits `download_url` while a recording file is still
        // PROCESSING, so this is transient. Bucketing it with permanently
        // unusable ids let the cursor advance past a transcript that would have
        // been downloadable minutes later, and it was never re-read.
        notReady = true;
        continue;
      }
      let sourceId: string;
      try {
        sourceId = zoomEpisodeSourceId(meeting.uuid, file.id);
      } catch (err) {
        // A malformed id is this meeting's problem, never the pass's — the
        // source-id builder throws so a bad key can't reach storage silently.
        skips.unidentifiable++;
        warnings.push(
          `Meeting ${meeting.uuid} has a recording file whose id could not be used: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (file.fileSize !== null && file.fileSize > MAX_TRANSCRIPT_BYTES) {
        skips.oversize++;
        warnings.push(
          `Meeting ${meeting.uuid} has a ${Math.round(file.fileSize / 1_048_576)}MB transcript, over the ${MAX_TRANSCRIPT_BYTES / 1_048_576}MB limit — it was skipped rather than truncated, so no partial transcript is stored as if it were whole.`,
        );
        continue;
      }

      const downloaded = await api.fetchTranscriptText(token, file.downloadUrl, MAX_TRANSCRIPT_BYTES);
      if (!downloaded.ok) {
        if (downloaded.error === "too_large") {
          // A SKIP, never a throw. Throwing routed a PERMANENT condition (the
          // file is over cap tomorrow too) through the per-meeting catch, which
          // froze the cursor every pass — and ~30 days later the frozen cursor
          // fell below the backfill floor and wedged the source outright. The
          // post-buffer check below always did the right thing; the pre-buffer
          // one added in round 1 did the opposite, which is how a size guard
          // became an outage.
          skips.oversize++;
          warnings.push(
            `Meeting ${meeting.uuid} has a transcript over the ${MAX_TRANSCRIPT_BYTES / 1_048_576}MB limit — it was skipped rather than truncated, so no partial transcript is stored as if it were whole.`,
          );
          continue;
        }
        if (downloaded.error === "unusable_url") {
          // Same shape as `too_large` above, and permanent for the same reason:
          // the `download_url` on a STORED recording is the same string next
          // pass, so an unparseable / non-HTTPS / non-Zoom one fails identically
          // every cycle. Throwing would set `walkIncomplete`, freeze
          // `coveredThrough` at the prior window forever, and ~30 days later
          // drop the cursor below the backfill floor and wedge the source — the
          // outage `too_large` was split out of, reached by a different route.
          //
          // Counted as unidentifiable rather than oversize: nothing is wrong
          // with the transcript's SIZE, the address for it is unusable.
          skips.unidentifiable++;
          warnings.push(
            `Meeting ${meeting.uuid} has a recording whose download URL Zoom returned in an unusable form — it was skipped. It is not retried: a stored recording's URL does not change.`,
          );
          continue;
        }
        throw toZoomClientError(`the transcript for meeting ${meeting.uuid}`, downloaded);
      }
      if (Buffer.byteLength(downloaded.text, "utf8") > MAX_TRANSCRIPT_BYTES) {
        // Zoom's `file_size` is advisory and occasionally absent; this is the
        // check that actually bounds what is stored.
        //
        // `Buffer.byteLength`, not `String.length`: the latter counts UTF-16
        // code units, so a non-Latin transcript would pass at up to ~3× the
        // stated bound — and the `file_size` gate above genuinely is bytes, so
        // the two checks would disagree about what "4MB" means.
        skips.oversize++;
        warnings.push(
          `Meeting ${meeting.uuid} downloaded a transcript over the ${MAX_TRANSCRIPT_BYTES / 1_048_576}MB limit — it was skipped rather than truncated.`,
        );
        continue;
      }

      const body = vttToBody(downloaded.text);
      if (body.trim() === "") {
        // `chk_brain_episodes_body_xor_locator` refuses `''` outright, so there
        // is nothing to store. Counted, because "a silent meeting" and "the VTT
        // did not parse" must not look the same to an operator.
        skips.emptyBody++;
        continue;
      }
      episodes.push({
        sourceId,
        // The HOST, not a speaker. A transcript has many speakers and they stay
        // inside the body for the extractor to attribute; `sourceActor` is the
        // source-side principal who owns the recording, which is the one
        // identity Zoom states unambiguously.
        sourceActor: meeting.hostId,
        body,
        occurredAt: meeting.startTime === null ? null : parseDate(meeting.startTime),
        visibleTo: grant,
      });
    }

    if (reconciled.unresolved > 0) {
      log.info(
        {
          workspaceId: options.workspaceId,
          meetingUuid: meeting.uuid,
          unresolved: reconciled.unresolved,
          granted: reconciled.added,
        },
        "Zoom meeting audience reconciled — some participants matched no Atlas user and were not granted",
      );
    }
    return { episodes, blocked: false, truncated, notReady };
  }

  return {
    async fetchEpisodes(params: BrainSourceFetchParams): Promise<BrainSourceChanges> {
      const token = await options.resolveToken();
      const today = toZoomDate(now());
      const floor = toZoomDate(new Date(now().getTime() - options.backfillWindowMs));
      const covered = parseZoomCursor(params.cursor);
      // The cursor is re-read from the FRONTIER DAY, not the day after: a
      // recording published late on the frontier day would otherwise be skipped
      // forever. The re-read is a deduped no-op.
      const start = covered === null || covered < floor ? floor : covered;

      const grantedHosts = options.hosts.length === 0 ? null : new Set(options.hosts);
      const episodes: BrainEpisodeRecord[] = [];
      const warnings: string[] = [];
      const skips: TranscriptSkips = {
        blockedAudience: 0,
        oversize: 0,
        emptyBody: 0,
        unidentifiable: 0,
      };
      // TWO flags, not one, and conflating them was a regression the round-2
      // review caught by execution.
      //
      //   `walkIncomplete`   — work INSIDE the walked range was left undone.
      //                        This is the only thing that may freeze the
      //                        resume point.
      //   `historyTruncated` — history OLDER than the backfill floor is
      //                        unreachable. A statement about the past, and
      //                        report-only: the floor IS the new start, so
      //                        there is nothing for a frozen cursor to retry.
      //
      // Gating the cursor on the union wedged the connector permanently. The
      // sync cadence is daily and the floor advances a day with it, so the mark
      // written by pass N is always a day older than the floor computed by pass
      // N+1: the stale branch re-fired forever, the cursor never left the floor,
      // and every pass re-walked the whole backfill. Once that backlog exceeded
      // `maxEpisodes` the walk broke before reaching today and recent meetings
      // stopped being ingested at all. Both flags still surface as
      // `coverageIncomplete` to the engine — that half was right.
      let walkIncomplete = false;
      let historyTruncated = false;
      let remainingPages = MAX_RECORDINGS_PAGES_PER_PASS;
      let remainingEpisodes = params.maxEpisodes;
      /** The last day covered end to end — what the mark may advance to. */
      let coveredThrough = start;

      if (covered !== null && covered < floor) {
        // Report-only. NOT `walkIncomplete`: the walk starts at the floor and
        // covers everything from there, so freezing the resume point would
        // re-walk that same range next pass and every pass after it.
        historyTruncated = true;
        warnings.push(
          `The stored sync mark (${covered}) was older than the ${Math.round(options.backfillWindowMs / 86_400_000)}-day backfill window, so this source restarts at ${floor}. Anything older is not ingested.`,
        );
      }

      windows: for (let from = start; from <= today; from = addDays(from, MAX_WINDOW_DAYS)) {
        const to = min(addDays(from, MAX_WINDOW_DAYS - 1), today);
        let nextPageToken: string | undefined;

        for (;;) {
          if (remainingPages <= 0 || remainingEpisodes <= 0) {
            walkIncomplete = true;
            warnings.push(
              remainingEpisodes <= 0
                ? `The per-sync record budget (${params.maxEpisodes}) was reached at ${from} — the rest of the backlog continues next cycle.`
                : `The per-pass Zoom page budget (${MAX_RECORDINGS_PAGES_PER_PASS}) was spent at ${from} — the rest of the backlog continues next cycle.`,
            );
            break windows;
          }
          const page = await api.fetchAccountRecordingsPage(token, {
            accountId: options.accountId,
            from,
            to,
            pageSize: RECORDINGS_PAGE_LIMIT,
            ...(nextPageToken !== undefined ? { nextPageToken } : {}),
          });
          if (!page.ok) throw toZoomClientError(`recordings between ${from} and ${to}`, page);
          remainingPages--;

          if (page.dropped > 0) {
            // Entries with no usable identity sit INSIDE the window this pass is
            // about to mark covered, so advancing past them would be a silent
            // skip. Truncating re-reads them next cycle — a visible stall, never
            // a silent loss.
            walkIncomplete = true;
            warnings.push(
              `Zoom returned ${page.dropped} recording entr${page.dropped === 1 ? "y" : "ies"} with no usable identity between ${from} and ${to} — that window was not marked covered and is re-read next cycle.`,
            );
            break windows;
          }

          for (const meeting of page.meetings) {
            if (remainingEpisodes <= 0) {
              // `break` (not `break windows`) was a silent skip: on the LAST
              // page of the LAST window the loops simply ran out, the window
              // was marked covered, and every unread meeting on that page was
              // gone forever with `coverageIncomplete: false` and no warning.
              // The top-of-page check above only fires when there IS a
              // subsequent page or window.
              walkIncomplete = true;
              warnings.push(
                `The per-sync record budget (${params.maxEpisodes}) was reached inside the window starting ${from} — the unread meetings in it resume next cycle.`,
              );
              break windows;
            }
            try {
              const produced = await runMeeting(
                token,
                meeting,
                grantedHosts,
                { episodes: remainingEpisodes },
                skips,
                warnings,
              );
              episodes.push(...produced.episodes);
              remainingEpisodes -= produced.episodes.length;
              // A blocked meeting leaves its window UNCOVERED. Without this the
              // pass would report itself fully covered, the high-water mark
              // would advance past the meeting, and no later cycle would ever
              // look at it again — a permanent silent skip on the SAFETY arm,
              // which is the worst place to have one.
              if (produced.blocked || produced.truncated || produced.notReady) {
                walkIncomplete = true;
              }
              if (produced.notReady) {
                warnings.push(
                  `Meeting ${meeting.uuid} has a transcript Zoom has not finished publishing — that window is re-read next cycle.`,
                );
              }
            } catch (err) {
              // Per-meeting isolation, matching the engine's per-collection
              // posture. A rate limit is the one failure that also stops the
              // PASS — Zoom is telling us to stop talking — but the pass still
              // RETURNS rather than throwing once anything has been banked,
              // because throwing would discard the episodes already earned and
              // the same prefix would be re-walked and re-lost every cycle.
              // Only a pass with nothing to bank rethrows, so the ENGINE's
              // backoff still owns the retry.
              const throttled = err instanceof ConnectorRateLimitError;
              if (throttled && episodes.length === 0) throw err;
              walkIncomplete = true;
              const message = err instanceof Error ? err.message : String(err);
              warnings.push(
                throttled
                  ? `Meeting ${meeting.uuid} and any after it were not read — Zoom is rate limiting this account. They resume next cycle.`
                  : `Meeting ${meeting.uuid} was skipped: ${message}`,
              );
              log.warn(
                { workspaceId: options.workspaceId, meetingUuid: meeting.uuid, err: message, throttled },
                throttled
                  ? "Zoom rate limit mid-pass — banking the meetings already read and stopping"
                  : "Zoom meeting pass failed — continuing with the remaining meetings",
              );
              if (throttled) break windows;
            }
          }

          if (page.nextPageToken === null || page.nextPageToken === "") break;
          nextPageToken = page.nextPageToken;
        }
        // The window may advance the resume point ONLY if nothing in the pass
        // so far left work undone.
        //
        // This gate is the whole correctness of the block arm, and it was
        // missing: the flag nulled the high-water mark, but this
        // connector never READS the high-water mark — `params.since` is unused
        // and `params.cursor` is the sole resume point. So a blocked meeting
        // set the flag, the mark went null (costing nothing), and the CURSOR
        // still advanced past the meeting's date. `episode-sync.ts` persists a
        // non-null cursor on any `ok` attempt and `connector-sync.ts` COALESCEs
        // it forward, so the meeting was never re-read — a permanent silent
        // skip on the SAFETY arm, while the pass loudly reported
        // `coverageIncomplete: true` the entire time.
        //
        // Gating on the flag rather than on a per-window boolean is deliberate:
        // the walk is in date order and the flag is monotonic, so the FIRST
        // window that leaves anything undone freezes the resume point for the
        // whole pass. A per-window flag would let a later clean window carry
        // the cursor over an earlier dirty one.
        if (!walkIncomplete) coveredThrough = to;
      }

      if (skips.blockedAudience > 0) {
        // Surfaced at WARN and separately from the other skips: every other
        // entry in this tally is a quality loss, this one is a SAFETY refusal,
        // and an operator seeing meetings vanish needs to know which.
        log.warn(
          { workspaceId: options.workspaceId, blocked: skips.blockedAudience },
          "Zoom pass blocked meetings whose audience could not be established — nothing was ingested from them, and nothing was granted more widely",
        );
      }
      if (skips.oversize + skips.emptyBody + skips.unidentifiable > 0) {
        log.info(
          { workspaceId: options.workspaceId, kept: episodes.length, ...skips },
          "Zoom transcript pass complete — transcripts read but not stored, by reason",
        );
      }

      return {
        episodes,
        // Honest by the same rule `slack/client.ts` follows: `null` whenever
        // coverage was incomplete, because a high-water mark must cover only the
        // CONTIGUOUS part of the window. The state upsert COALESCEs the previous
        // mark forward, so null loses nothing.
        highWaterMark: walkIncomplete || historyTruncated ? null : `${coveredThrough}T23:59:59.999Z`,
        cursor: serialiseZoomCursor(coveredThrough),
        coverageIncomplete: walkIncomplete || historyTruncated,
        warnings,
      };
    },
  };
}

/** `YYYY-MM-DD` comparison — lexicographic IS chronological for this format. */
function min(a: string, b: string): string {
  return a < b ? a : b;
}

/** A Zoom `start_time` → `Date`, or null when it does not parse. */
function parseDate(raw: string): Date | null {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}
