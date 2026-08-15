/**
 * The chat class's denominator enumeration (#5213, ADR-0041).
 *
 * Answers, for one workspace, per Slack channel: does it exist, is it inside the
 * ingest perimeter, has it actually produced evidence, and when did the SOURCE
 * last move. That is ADR-0041's `chat-channel-roster` denominator plus the two
 * timestamps a measured lag needs.
 *
 * ## Three reads, and each answers a question the others cannot
 *
 *   1. **`brain_slack_channel`** — the perimeter. `is_member AND excluded_at IS
 *      NULL` is the ingest scope (#5203), and an excluded row is a deliberate act
 *      that took a channel OUT of it. This read cannot see a channel nobody
 *      invited the bot to, which is exactly the population a denominator needs.
 *   2. **`conversations.list`** — the public roster: what the workspace CONTAINS,
 *      not what the bot is in. ADR-0041 state 2 lives here.
 *   3. **`conversations.history` with `limit: 1`** — the VENDOR's newest message
 *      timestamp, on a bounded rotation.
 *
 * ## Why (3) asks Slack rather than reading our own episodes
 *
 * "Stale means the source has moved since we last looked" (ADR-0041). Our newest
 * episode is the *"we last looked"* half; deriving the *"source has moved"* half
 * from the same table makes the lag structurally zero and the badge decorative.
 * A stalled ingest is precisely the case the measurement exists to catch, and it
 * is the case a self-referential reading cannot see. So the probe pays a Slack
 * call — bounded to {@link CHAT_ACTIVITY_PROBES_PER_CYCLE} per cycle,
 * oldest-reading-first, on `brain_slack_channel`'s health-rotation model where
 * the ORDER BY is the whole scheduler.
 *
 * ## The two ways this arm degrades, and why only one of them refuses
 *
 *   - **`missing_scope` on the public roster** is a stable fact about the map:
 *     these credentials cannot see beyond membership, and they will not be able
 *     to next cycle either. It degrades to the `chat-public-roster-unreadable`
 *     MARK and the perimeter half still enumerates — AC-2's "visibly, never
 *     silently". The denominator legitimately shrinks to what the credentials can
 *     see, which ADR-0041 states outright: "widening scopes grows the
 *     denominator, so connecting more can make a ratio go down."
 *   - **Anything else** — rate limits, transport failures, a malformed page — is
 *     "we could not look this cycle", and it REFUSES the whole enumeration so the
 *     previous dated roster stays in place. Writing the perimeter half alone
 *     would let the persistence sweep retire every state-2 channel because a
 *     Slack 429 landed, which is the flattering direction and exactly the loud
 *     understatement ADR-0041's fixture charter names.
 *
 * @see ../../coverage-enumeration.ts — the shape this produces and the write
 * @see ../../../slack/api.ts — `fetchConversationsListPage`, and why it exists
 *   beside `listChannels` and `fetchUserConversationsPage`
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  fetchConversationHistoryPage,
  fetchConversationsListPage,
} from "@atlas/api/lib/slack/api";
import { SLACK_SOURCE } from "@atlas/api/lib/brain/sources";
import {
  readActivityProbeRotation,
  type CoverageDegradedArm,
  type CoverageEnumeration,
  type EnumeratedSurveyUnit,
} from "@atlas/api/lib/brain/coverage-enumeration";
import { SLACK_CHANNEL_ID_PATTERN } from "./config";

const log = createLogger("brain.coverage.slack");

/**
 * Page bound on the public-channel roster. 20 × 200 = 4,000 public channels,
 * matching `MEMBERSHIP_MAX_PAGES` × `MEMBERSHIP_PAGE_LIMIT` so the two
 * enumerations in this subsystem have one bound to reason about.
 *
 * Hitting it emits the `chat-public-roster-truncated` MARK rather than refusing:
 * the roster we got is a stable prefix of Slack's own ordering, so the count
 * does not churn between cycles, and the mark is what stops it being read as the
 * whole map. "Any denominator that includes [the unenumerable] is fabricated" —
 * so the honest rendering is a count plus an edge, never an estimate.
 */
export const PUBLIC_ROSTER_MAX_PAGES = 20;
export const PUBLIC_ROSTER_PAGE_LIMIT = 200;

/**
 * Vendor-activity probes per cycle — `SLACK_CHANNEL_HEALTH_PROBES_PER_CYCLE`'s
 * bound and its argument: at most this many extra Slack calls regardless of
 * perimeter size, so a 400-channel workspace takes ~20 cycles to read every
 * channel's activity once. Right for a measurement whose subject is a lag
 * measured against a sync cadence rather than a per-minute reading.
 */
export const CHAT_ACTIVITY_PROBES_PER_CYCLE = 20;

/** Injection seam for the tests — the two Slack reads. */
export interface SlackCoverageDeps {
  readonly fetchConversationsListPage?: typeof fetchConversationsListPage;
  readonly fetchConversationHistoryPage?: typeof fetchConversationHistoryPage;
}

interface PerimeterRow extends Record<string, unknown> {
  channel_id: string;
  name: string | null;
  is_member: boolean;
  excluded_at: Date | null;
}

/**
 * The perimeter half. EVERY row, including excluded ones: an exclusion is a
 * deliberate act, so the channel stays nameable and stays in the denominator —
 * it moved out of the perimeter, it did not stop existing.
 */
const PERIMETER_SQL = `SELECT channel_id, name, is_member, excluded_at
     FROM brain_slack_channel
    WHERE workspace_id = $1
    ORDER BY channel_id ASC`;

/**
 * Our newest observed evidence, per channel.
 *
 * `split_part(source_id, ':', 1)` reverses `slackEpisodeSourceId`'s
 * `<channelId>:<ts>` — a channel id holds no colon (`SLACK_CHANNEL_ID_PATTERN`)
 * and the `ts` is always the second half, so the split is exact rather than
 * best-effort. Pinned by `brain/__tests__/coverage-snapshot-pg.test.ts`, which builds its fixture
 * episodes through `slackEpisodeSourceId` so a format change reddens here.
 */
const NEWEST_EVIDENCE_SQL = `SELECT split_part(source_id, ':', 1) AS channel_id,
          max(occurred_at) AS newest
     FROM brain_episodes
    WHERE workspace_id = $1 AND source = $2
    GROUP BY 1`;

/**
 * Enumerate the chat class's survey units for one workspace.
 *
 * Never throws for a vendor reason: a Slack failure becomes either a map-edge
 * mark or `{ ok: false }`, both of which the caller can persist. A DATABASE
 * failure propagates — the roster reads are the perimeter's ground truth, and a
 * caught one would hand back a unit list that reads as "this workspace has no
 * channels".
 */
export async function enumerateSlackCoverage(params: {
  readonly workspaceId: string;
  readonly token: string;
  readonly deps?: SlackCoverageDeps;
}): Promise<CoverageEnumeration> {
  const { workspaceId, token } = params;
  const listPage = params.deps?.fetchConversationsListPage ?? fetchConversationsListPage;
  const historyPage = params.deps?.fetchConversationHistoryPage ?? fetchConversationHistoryPage;
  const degraded: CoverageDegradedArm[] = [];

  const [perimeterRows, evidenceRows] = await Promise.all([
    internalQuery<PerimeterRow>(PERIMETER_SQL, [workspaceId]),
    internalQuery<{ channel_id: string; newest: Date | string | null }>(NEWEST_EVIDENCE_SQL, [
      workspaceId,
      SLACK_SOURCE,
    ]),
  ]);

  const newestEvidence = new Map<string, Date>();
  for (const row of evidenceRows) {
    const at = toDate(row.newest);
    if (at !== null) newestEvidence.set(row.channel_id, at);
  }

  // ── The public roster ────────────────────────────────────────────────────
  const membersPerVendor = new Set<string>();
  const publicRoster = await readPublicRoster({ token, listPage, workspaceId, membersPerVendor });
  if (publicRoster.kind === "refused") return { ok: false, error: publicRoster.error };
  if (publicRoster.kind === "unreadable") {
    degraded.push("chat-public-roster-unreadable");
    log.warn(
      { workspaceId },
      "brain coverage: this workspace's Slack token cannot list public channels — the chat denominator counts only what the bot is in, and the surface carries a map edge saying so",
    );
  } else if (publicRoster.truncated) {
    degraded.push("chat-public-roster-truncated");
  }
  const vendorPublic =
    publicRoster.kind === "roster" ? publicRoster.channels : new Map<string, string | null>();

  // ── The activity probe rotation ──────────────────────────────────────────
  // Read BEFORE the units are assembled, because the rotation orders on the
  // PREVIOUS cycle's readings — a rotation computed from this cycle's freshly
  // stamped rows would have no ordering at all.
  const due = await readActivityProbeRotation({
    workspaceId,
    sourceClass: "chat",
    limit: CHAT_ACTIVITY_PROBES_PER_CYCLE,
  });
  const probe = await probeActivity({ token, historyPage, channels: due, workspaceId });
  if (probe.unreadable) degraded.push("chat-activity-unreadable");

  // ── The union ────────────────────────────────────────────────────────────
  const units: EnumeratedSurveyUnit[] = [];
  const seen = new Set<string>();
  // ⚠️ COUNTED, not dropped quietly, in BOTH loops.
  //
  // `fetchConversationsListPage` refuses a whole page for one unusable entry
  // because "an understated page does not merely miss a channel, it RETIRES
  // one" — and this is that same sweep, one seam later. If Slack ever mints a
  // public-conversation id prefix this pattern does not admit, EVERY row fails
  // here, the roster empties, and `persistCoverageSnapshot` sweeps the lot under
  // a green success. A silent `continue` is how that arrives with no signal.
  let unrecognisedIds = 0;
  for (const row of perimeterRows) {
    if (!SLACK_CHANNEL_ID_PATTERN.test(row.channel_id)) {
      unrecognisedIds++;
      continue;
    }
    seen.add(row.channel_id);
    const inPerimeter = row.is_member === true && row.excluded_at === null;
    units.push({
      unitId: row.channel_id,
      label: row.name === null || row.name === "" ? null : row.name,
      inPerimeter,
      // Membership and exclusion are both on ADR-0041's deliberate-act list, so
      // every row of this table is nameable under clause 1 whatever the vendor
      // says. That is the clause that survives Slack changing what "public"
      // means, which is why `coverageLabelPolicy` prefers it.
      deliberateAct: true,
      // ⚠️ NOT `brain_slack_channel.is_private`. That column is DISPLAY ONLY and
      // may be stale (see its schema comment: a stale `false` would publish an
      // invite-only channel's contents org-wide). The vendor-public clause is
      // answered from the LIVE public roster or not at all — a channel absent
      // from it is treated as not-public, which is the fail-closed direction.
      vendorReportsPublic: vendorPublic.has(row.channel_id),
      newestEvidenceAt: newestEvidence.get(row.channel_id) ?? null,
      activity: probe.readings.get(row.channel_id) ?? { probed: false },
    });
  }
  for (const [channelId, name] of vendorPublic) {
    if (seen.has(channelId)) continue;
    if (!SLACK_CHANNEL_ID_PATTERN.test(channelId)) {
      unrecognisedIds++;
      continue;
    }
    units.push({
      unitId: channelId,
      label: name,
      // Nobody put it in the perimeter — ADR-0041 state 2, verbatim.
      inPerimeter: false,
      deliberateAct: false,
      vendorReportsPublic: true,
      // Structurally null rather than looked up: an episode can only exist for a
      // channel the bot was in, and a channel the bot was in has a
      // `brain_slack_channel` row, so it was handled above.
      newestEvidenceAt: null,
      // A history read for a channel the bot is not in is refused by Slack, so
      // there is nothing to probe and no gap in not probing it.
      activity: { probed: false },
    });
  }

  if (unrecognisedIds > 0) {
    // A MARK as well as a log, for `warehouse-entity-unreadable`'s reason: the
    // dropped units are gone from the denominator and swept by the write, so
    // without an edge the page renders a short count as a complete map.
    degraded.push("chat-unit-ids-unrecognised");
    log.error(
      { workspaceId, unrecognisedIds, kept: units.length },
      "brain coverage: Slack conversation ids this deploy does not recognise were dropped from the chat denominator — the count is lower than the truth",
    );
  }

  // The perimeter is what `brain_slack_channel` says, and this enumeration does
  // NOT widen it — a channel Slack calls a membership with no row here counts as
  // state 2, which is the understating and therefore safe direction. But it is
  // also what a broken membership sync looks like, and that fact had no detector
  // at all until this line: the ingest scope is the same table, so a channel
  // stuck outside it is a channel Atlas is not reading.
  const perimeterIds = new Set(perimeterRows.map((r) => r.channel_id));
  const unsynced = [...membersPerVendor].filter((id) => !perimeterIds.has(id));
  if (unsynced.length > 0) {
    log.warn(
      { workspaceId, unsynced: unsynced.length, example: unsynced[0] },
      "brain coverage: Slack reports the bot in channels this workspace has no membership row for — they count as enumerated, not surveyed, and the ingest scope is not reading them either",
    );
  }

  return { ok: true, units, degraded };
}

// ---------------------------------------------------------------------------
// The public roster
// ---------------------------------------------------------------------------

type PublicRosterResult =
  /**
   * Read completely, or up to the page bound. `channels` maps id → name, where
   * the name may be `null` — Slack sent none, and an id in its place would be a
   * label that is not one.
   */
  | {
      readonly kind: "roster";
      readonly channels: Map<string, string | null>;
      readonly truncated: boolean;
    }
  /** A stable capability fact: these credentials cannot list public channels. */
  | { readonly kind: "unreadable" }
  /** A transient failure. The caller refuses the whole cycle. */
  | { readonly kind: "refused"; readonly error: string };

async function readPublicRoster(params: {
  readonly token: string;
  readonly listPage: typeof fetchConversationsListPage;
  readonly workspaceId: string;
  /**
   * Channels the VENDOR says the bot is in, filled as a side effect.
   *
   * Only used to detect disagreement with `brain_slack_channel` — the perimeter
   * is what that table says, and this enumeration must not quietly widen it. A
   * channel Slack calls a membership that has no row is an understatement (the
   * safe direction) AND a broken membership sync, and without this the second
   * fact has no detector at all.
   */
  readonly membersPerVendor: Set<string>;
}): Promise<PublicRosterResult> {
  const { membersPerVendor } = params;
  const channels = new Map<string, string | null>();
  let privateEntries = 0;
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= PUBLIC_ROSTER_MAX_PAGES) {
      log.warn(
        { workspaceId: params.workspaceId, channels: channels.size },
        "brain coverage: Slack's public-channel roster is longer than this enumeration's page bound — the chat denominator carries a truncation mark",
      );
      reportPrivateEntries(params.workspaceId, privateEntries, channels.size);
      return { kind: "roster", channels, truncated: true };
    }
    const result = await params.listPage(params.token, {
      limit: PUBLIC_ROSTER_PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!result.ok) {
      // The one error that is a MAP FACT rather than an outage. See the module
      // header: a token without `channels:read` will not have it next cycle
      // either, so the honest answer is a smaller denominator plus an edge, not
      // an indefinite "unavailable".
      if (result.error === "missing_scope") return { kind: "unreadable" };
      return {
        kind: "refused",
        error: `Atlas could not list this workspace's Slack channels — the coverage denominator keeps its previous reading rather than shrinking to what one failed call returned, and it retries on the next cycle (${result.error})`,
      };
    }
    for (const channel of result.channels) {
      // A private channel cannot arrive here — the request asks for
      // `types=public_channel` — but the vendor-public clause is a DISCLOSURE
      // gate, so it is decided on what Slack said about the row rather than on
      // what we asked for. `fetchConversationsListPage` requires the flag to be
      // present for the same reason.
      if (channel.isPrivate) {
        // "Cannot arrive" — the request pins `types=public_channel`. Counted
        // anyway, because that is the class of assumption the same call refuses
        // to make about `is_private` itself: a vendor-semantics shift (converted
        // or shared channels) would shrink the denominator toward the flattering
        // side with nothing to say so.
        privateEntries++;
        continue;
      }
      channels.set(channel.id, channel.name);
      if (channel.isMember) membersPerVendor.add(channel.id);
    }
    if (result.nextCursor === null) {
      reportPrivateEntries(params.workspaceId, privateEntries, channels.size);
      return { kind: "roster", channels, truncated: false };
    }
    cursor = result.nextCursor;
  }
}

/** A `types=public_channel` request returning private rows is a vendor-contract change. */
function reportPrivateEntries(workspaceId: string, privateEntries: number, kept: number): void {
  if (privateEntries === 0) return;
  log.warn(
    { workspaceId, privateEntries, kept },
    "brain coverage: Slack returned PRIVATE channels to a public-channel roster request — they are dropped, so the chat denominator is lower than what the request asked for",
  );
}

// ---------------------------------------------------------------------------
// The vendor-activity probe
// ---------------------------------------------------------------------------

interface ProbeResult {
  readonly readings: Map<string, EnumeratedSurveyUnit["activity"]>;
  /** True when a probe failed for a reason other than "the bot is not in there". */
  readonly unreadable: boolean;
}

async function probeActivity(params: {
  readonly token: string;
  readonly historyPage: typeof fetchConversationHistoryPage;
  readonly channels: readonly string[];
  readonly workspaceId: string;
}): Promise<ProbeResult> {
  const readings = new Map<string, EnumeratedSurveyUnit["activity"]>();
  let unreadable = false;
  for (const channelId of params.channels) {
    const page = await params.historyPage(params.token, { channel: channelId, limit: 1 });
    if (!page.ok) {
      // `not_in_channel` is not a degradation: the bot left, membership has not
      // been refreshed yet, and the next scope refresh takes the channel out of
      // the perimeter. Marking the map edge for it would raise an edge that
      // resolves itself, which trains a reader to ignore edges.
      if (page.error !== "not_in_channel") {
        unreadable = true;
        log.warn(
          {
            workspaceId: params.workspaceId,
            channelId,
            err: page.error,
            retryAfterSeconds: page.retryAfterSeconds,
          },
          "brain coverage: could not read a channel's newest message from Slack — its staleness reads 'unverified since' rather than current",
        );
      }
      readings.set(channelId, { probed: false });
      // ⚠️ STOP on a 429 rather than working through the rest of the rotation.
      //
      // The mark is already raised and every remaining unit keeps its previous
      // reading through the write's COALESCE, so continuing buys nothing — and it
      // costs up to 19 more calls against a token the INGEST pipeline shares.
      // Degrading the pipeline whose staleness this measurement reports on is
      // the one cost this measurement must not impose.
      if (page.error === "ratelimited") {
        log.warn(
          { workspaceId: params.workspaceId, retryAfterSeconds: page.retryAfterSeconds },
          "brain coverage: Slack is rate limiting this workspace — the activity probe rotation stops here and resumes next cycle",
        );
        break;
      }
      continue;
    }
    // An EMPTY page is a real reading and must be `probed: true`: it says the
    // channel has never had a message, which is "quiet", and ADR-0041 is
    // explicit that quiet is not stale. Recording it as unprobed would leave the
    // unit reading "unverified since" forever, because nothing would ever fill
    // a value that does not exist.
    const newest = page.messages[0];
    const at = newest === undefined ? null : slackTsToDate(newest.ts);
    // ⚠️ A MESSAGE WE CANNOT PARSE IS NOT "QUIET", and folding it onto the empty
    // page was a FALSE ALL-CLEAR on the one axis this probe exists to measure.
    // `slackTsToDate` returns null for an unparseable or non-positive `ts`, and
    // that null used to reach the store as `{ at: NULL, checked_at: now }` —
    // which renders as "asked just now, this channel has never had a message",
    // i.e. never stale. Every probe still returned `ok`, so no arm was raised
    // and nothing was logged: a stalled ingest reading green, in the module
    // built to end exactly that.
    if (newest !== undefined && at === null) {
      unreadable = true;
      log.warn(
        { workspaceId: params.workspaceId, channelId, ts: newest.ts.slice(0, 32) },
        "brain coverage: Slack returned a message timestamp this deploy cannot parse — the channel keeps its previous reading and the map carries an activity edge",
      );
      readings.set(channelId, { probed: false });
      continue;
    }
    readings.set(channelId, { probed: true, at });
  }
  return { readings, unreadable };
}

/**
 * Slack's `ts` is `<unix seconds>.<microseconds>` as a string.
 *
 * `null` on anything unparseable rather than `new Date(NaN)`: an invalid Date
 * reaches the database as `Invalid Date` and the driver either throws or stores
 * garbage, and a garbage vendor reading would make a lag comparison produce a
 * verdict nobody measured.
 */
export function slackTsToDate(ts: string): Date | null {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at;
}

function toDate(value: Date | string | null): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
