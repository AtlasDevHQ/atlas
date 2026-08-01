/**
 * Meeting-audience membership (#4965) — the LIVE half of a transcript grant.
 *
 * `deriveMeetingParticipantGrant` mints `audience:meeting:zoom:<uuid>` and
 * `reconcile.ts` inherits it onto every fact extracted from that meeting.
 * Neither populates `fact_audience_member`, so without this module the audience
 * resolves to NOBODY and every transcript fact is stored, gated, and invisible
 * — the exact state #4801 found the chat side in.
 *
 * ## Two entry points, one reconcile
 *
 * {@link reconcileMeetingAudience} is the shared core. It is called from two
 * places and the difference between them is only WHERE the roster came from:
 *
 *   1. **At ingest** (`client.ts`), from the roster the pass just fetched to
 *      license the grant. Doing it here rather than deferring to the fiber
 *      avoids a second identical vendor read, and — more importantly — closes
 *      the window in which a freshly-ingested meeting's facts exist with an
 *      audience nobody is in.
 *
 *      ⚠️ ORDER: membership is written BEFORE the episodes are handed back for
 *      ingest, never after. The failure modes are not symmetric. Membership
 *      without episodes is an audience nothing references — inert, and cleaned
 *      up by the next reconcile. Episodes without membership is a meeting whose
 *      facts are invisible to the people who were in it, for as long as it takes
 *      the re-verifier to come round. One is a no-op, the other is a silent
 *      outage.
 *
 *   2. **On the clock** ({@link reverifyZoomMeetingAudiences}), from a fresh
 *      roster read, registered through `audience/reverify.ts`.
 *
 * ## Why a FROZEN participant list still needs re-verification
 *
 * This is the part that reads as redundant and is not. A meeting's participant
 * list cannot change — nobody joins a past meeting — so re-reading it from Zoom
 * yields the same humans every time. What changes is the RESOLUTION of those
 * humans to Atlas users in this workspace:
 *
 *   - someone leaves the org → their `member` row goes → `resolvePrincipals`
 *     stops matching them → the reconcile REVOKES. That is the revocation path
 *     ADR-0036 built `audience:` for, and freezing `user:` tokens at ingest
 *     would not have it.
 *   - someone joins Atlas after the meeting → they now match → the reconcile
 *     GRANTS. A meeting whose whole roster was external at ingest becomes
 *     visible to the one participant who later got an account, with no
 *     re-ingest and no rewrite of a stored row.
 *
 * And underneath both, `acl.ts` (#4808) suppresses any audience whose
 * `synced_at` is older than `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`
 * (default 168h). An audience written once at ingest and never touched again
 * stops granting a week later — silently, with the facts still stored and every
 * sync still green. Re-verification is what keeps that from happening, which is
 * why it is not an enhancement to this connector but part of it.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { AUDIENCE_PREFIX } from "@atlas/api/lib/brain/acl";
import { parseMeetingAudienceId } from "@atlas/api/lib/brain/ingest/grant";
import { reconcileAudienceMembership } from "@atlas/api/lib/brain/audience/membership";
import { resolvePrincipals } from "@atlas/api/lib/brain/audience/resolver";
import {
  AUDIENCE_SYNC_INSTALLS_SQL,
  isAudienceSyncEnabled,
} from "@atlas/api/lib/brain/audience/sync";
import {
  registerAudienceReverifier,
  ZERO_REVERIFY,
  type AudienceReverifyResult,
} from "@atlas/api/lib/brain/audience/reverify";
import { fetchMeetingParticipantsPage, type ZoomParticipant } from "./api";
import {
  ZOOM_TRANSCRIPT_SOURCE,
  ZOOM_TRANSCRIPTS_CATALOG_ID,
  parseZoomTranscriptsConfig,
} from "./config";

const log = createLogger("brain.ingest.zoom.audience");

/** Participants per page. Zoom's documented maximum for this endpoint. */
export const PARTICIPANTS_PAGE_SIZE = 300;

/**
 * Hard bound on roster pages per meeting. ~90k participants — far past any real
 * meeting, so hitting it means paging is not terminating, and the pass must
 * report the roster INCOMPLETE rather than reconcile against a truncated one.
 */
export const MAX_PARTICIPANT_PAGES = 300;

/**
 * Meeting audiences re-verified per workspace per cycle.
 *
 * A bound, and one with teeth: with more audiences than this, the ORDER of the
 * scan is what decides whether the tail is ever reached. The scan is therefore
 * ordered STALEST-FIRST, so the cap delays a re-verification but cannot starve
 * one — an unordered scan with a cap would re-verify the same first N forever
 * and let every other audience age past the bound permanently.
 */
export const MAX_REVERIFY_AUDIENCES_PER_WORKSPACE = 200;

/**
 * The workspace's Zoom meeting audiences, STALEST FIRST.
 *
 * Sourced from `brain_episodes.visible_to` rather than from
 * `fact_audience_member`, and that direction is deliberate. Membership is the
 * thing being repaired, so an audience with NO members — the meeting whose
 * roster was entirely external at ingest — has no row there at all and would be
 * invisible to a scan of it. It is exactly the audience the "someone joined
 * Atlas later" repair exists for, so the scan has to see it.
 *
 * `MIN(synced_at)` with `NULLS FIRST` puts never-verified audiences at the
 * front, then the oldest. An audience is as verified as its LEAST recently
 * verified row, matching `acl.ts`'s own `min(synced_at)` reading.
 *
 * Exported so the real-Postgres test runs this exact string against the live
 * schema rather than a paraphrase of it.
 */
export const ZOOM_MEETING_AUDIENCES_SQL = `
  SELECT t.token AS token, MIN(m.synced_at) AS synced_at
    FROM (
      SELECT DISTINCT tok AS token
        FROM brain_episodes e, unnest(e.visible_to) AS tok
       WHERE e.workspace_id = $1
         AND e.source = $2
         AND tok LIKE $3
    ) t
    LEFT JOIN fact_audience_member m
      ON m.workspace_id = $1
     AND m.audience_id = substr(t.token, length($4) + 1)
   GROUP BY t.token
   ORDER BY MIN(m.synced_at) ASC NULLS FIRST, t.token ASC
   LIMIT $5
` as const;

/** The DB + vendor surface this module needs — injectable so tests need no HTTP. */
export interface ZoomAudienceDeps {
  readonly query?: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
  readonly fetchParticipantsPage?: typeof fetchMeetingParticipantsPage;
  readonly reconcile?: typeof reconcileAudienceMembership;
  readonly resolve?: typeof resolvePrincipals;
  /**
   * Resolve the workspace's Zoom bearer token. Injected by the connector.
   *
   * Takes the install id as well as the config because the credential is keyed
   * `(workspace_id, collection_id)` and the install id IS the collection id —
   * it is not derivable from the config, which carries only non-secret scope.
   */
  readonly resolveToken?: (
    workspaceId: string,
    installId: string,
    config: Record<string, unknown> | null,
  ) => Promise<string>;
  readonly isEnabled?: (workspaceId: string) => boolean;
}

/** A complete-or-abort roster read. There is deliberately no partial arm. */
export type RosterRead =
  | { readonly complete: true; readonly participants: readonly ZoomParticipant[] }
  | { readonly complete: false; readonly reason: string };

/**
 * Enumerate a meeting's participants, COMPLETELY or not at all.
 *
 * The return type has no "here is some of it" arm on purpose. A partial roster
 * is not a degraded input to the reconcile — it is a MASS REVOCATION, because
 * `reconcileAudienceMembership` deletes everyone outside the set it is handed.
 * Making the partial state unrepresentable is cheaper than remembering to check
 * a flag at both call sites.
 */
export async function readMeetingRoster(
  token: string,
  meetingUuid: string,
  deps: ZoomAudienceDeps = {},
): Promise<RosterRead> {
  const fetchPage = deps.fetchParticipantsPage ?? fetchMeetingParticipantsPage;
  const participants: ZoomParticipant[] = [];
  let nextPageToken: string | undefined;

  for (let page = 0; page < MAX_PARTICIPANT_PAGES; page++) {
    const result = await fetchPage(token, meetingUuid, {
      pageSize: PARTICIPANTS_PAGE_SIZE,
      ...(nextPageToken !== undefined ? { nextPageToken } : {}),
    });
    if (!result.ok) {
      return {
        complete: false,
        reason: `the participant list could not be read (${result.error})`,
      };
    }
    participants.push(...result.participants);
    if (result.nextPageToken === null || result.nextPageToken === "") {
      return { complete: true, participants };
    }
    nextPageToken = result.nextPageToken;
  }
  // Paging did not terminate. Reporting this as complete would reconcile
  // against a truncated roster and revoke the tail.
  return {
    complete: false,
    reason: `the participant list did not finish paging within ${MAX_PARTICIPANT_PAGES} pages`,
  };
}

/** What one audience reconcile concluded. */
export interface MeetingAudienceResult {
  readonly added: number;
  readonly revoked: number;
  readonly unresolved: number;
}

/**
 * Resolve a complete roster to Atlas users and reconcile the audience.
 *
 * THROWS on a resolution or DB fault, and does not catch: the caller counts the
 * audience as failed and leaves the previous membership in place, which is the
 * only direction that neither grants nor revokes on a fault. Swallowing here
 * would hand the reconcile an empty set — indistinguishable from "everyone
 * left" — and revoke the whole audience during an incident.
 *
 * A roster that resolves to NOBODY is reconciled to empty, not skipped. That is
 * the FLAG side of the asymmetry: a meeting of five external guests has a
 * well-established audience that currently contains no Atlas users, and the
 * faithful result is an empty audience that repairs itself the moment one of
 * them gets an account. Skipping the reconcile to "protect" the rows would
 * preserve exactly the stale access this table exists to drop.
 */
export async function reconcileMeetingAudience(
  input: {
    readonly workspaceId: string;
    /** Audience id WITHOUT the `audience:` prefix. */
    readonly audienceId: string;
    readonly participants: readonly ZoomParticipant[];
  },
  deps: ZoomAudienceDeps = {},
): Promise<MeetingAudienceResult> {
  const resolve = deps.resolve ?? resolvePrincipals;
  const reconcile = deps.reconcile ?? reconcileAudienceMembership;

  // A Zoom participant may appear several times in one meeting (they dropped
  // and rejoined), and dial-in guests have no email at all. Both are handled by
  // the resolver — it counts the email-less as unresolved and dedupes by
  // address — but the `id` must still be unique per entry or the resolution map
  // silently keeps one of them. Index-suffixing the id is enough: the id is a
  // LOG subject here, never a join key.
  const principals = input.participants.map((participant, index) => ({
    id: participant.userId ?? participant.email ?? `participant-${index}`,
    email: participant.email,
  }));

  const resolution = await resolve(input.workspaceId, principals);
  const userIds = [...new Set(resolution.resolved.values())];

  const changed = await reconcile({
    workspaceId: input.workspaceId,
    audienceId: input.audienceId,
    source: ZOOM_TRANSCRIPT_SOURCE,
    userIds,
  });
  return {
    added: changed.added,
    revoked: changed.revoked,
    unresolved: resolution.unresolvedCount,
  };
}

interface AudienceRow extends Record<string, unknown> {
  readonly token: string;
  readonly synced_at: string | null;
}

interface InstallRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly install_id: string;
  readonly config: Record<string, unknown> | null;
}

/**
 * Re-verify every workspace's Zoom meeting audiences — the clock-driven half.
 *
 * NEVER throws: it is drained by `runRegisteredAudienceReverifiers`, and a
 * throw there costs the other sources their pass. Every fault is isolated to
 * the narrowest scope that owns it — a workspace, then an audience — and
 * counted, so a re-verification that stopped working shows up as `failed > 0`
 * (which makes the cycle report `degraded`) rather than as silence.
 */
export async function reverifyZoomMeetingAudiences(
  deps: ZoomAudienceDeps = {},
): Promise<AudienceReverifyResult> {
  if (!hasInternalDB()) return ZERO_REVERIFY;
  const query = deps.query ?? internalQuery;
  const isEnabled = deps.isEnabled ?? isAudienceSyncEnabled;
  const resolveToken = deps.resolveToken;
  if (resolveToken === undefined) {
    // Unreachable in production — `registerZoomAudienceReverifier` binds one.
    // Loud rather than a silent no-op: a re-verifier that quietly does nothing
    // lets every meeting audience age past the staleness bound while the cycle
    // reports success, which is the exact failure this module exists to prevent.
    log.error({}, "brain audience: Zoom re-verifier has no token resolver — skipping the pass");
    return { ...ZERO_REVERIFY, failed: 1 };
  }

  let installs: InstallRow[];
  try {
    installs = await query<InstallRow>(AUDIENCE_SYNC_INSTALLS_SQL, [ZOOM_TRANSCRIPTS_CATALOG_ID]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "brain audience: Zoom install scan failed — no meeting audience was re-verified this cycle",
    );
    return { ...ZERO_REVERIFY, failed: 1 };
  }

  let total = ZERO_REVERIFY;
  for (const install of installs) {
    if (!isEnabled(install.workspace_id)) continue;
    try {
      total = sum(total, await reverifyWorkspace(install, query, resolveToken, deps));
    } catch (err) {
      log.warn(
        {
          workspaceId: install.workspace_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "brain audience: Zoom workspace re-verification failed — membership unchanged, retrying next cycle",
      );
      total = { ...total, failed: total.failed + 1 };
    }
  }
  return total;
}

function sum(a: AudienceReverifyResult, b: AudienceReverifyResult): AudienceReverifyResult {
  return {
    reconciled: a.reconciled + b.reconciled,
    failed: a.failed + b.failed,
    membersAdded: a.membersAdded + b.membersAdded,
    membersRevoked: a.membersRevoked + b.membersRevoked,
    principalsUnresolved: a.principalsUnresolved + b.principalsUnresolved,
  };
}

async function reverifyWorkspace(
  install: InstallRow,
  query: NonNullable<ZoomAudienceDeps["query"]>,
  resolveToken: NonNullable<ZoomAudienceDeps["resolveToken"]>,
  deps: ZoomAudienceDeps,
): Promise<AudienceReverifyResult> {
  const workspaceId = install.workspace_id;
  const parsed = parseZoomTranscriptsConfig(install.config);
  if (!parsed.ok) {
    log.warn(
      { workspaceId, error: parsed.error },
      "brain audience: Zoom install config is unreadable — its meeting audiences were not re-verified",
    );
    return { ...ZERO_REVERIFY, failed: 1 };
  }

  const rows = await query<AudienceRow>(ZOOM_MEETING_AUDIENCES_SQL, [
    workspaceId,
    ZOOM_TRANSCRIPT_SOURCE,
    `${AUDIENCE_PREFIX}meeting:%`,
    AUDIENCE_PREFIX,
    MAX_REVERIFY_AUDIENCES_PER_WORKSPACE,
  ]);
  if (rows.length === 0) return ZERO_REVERIFY;

  // Resolved ONCE per workspace, outside the per-audience loop: a token call per
  // meeting would multiply the auth endpoint's load by the audience count for no
  // gain, and the token outlives a whole pass.
  const token = await resolveToken(workspaceId, install.install_id, install.config);

  let total = ZERO_REVERIFY;
  for (const row of rows) {
    const audienceId = row.token.slice(AUDIENCE_PREFIX.length);
    const parts = parseMeetingAudienceId(audienceId);
    if (parts === null || parts.source !== ZOOM_TRANSCRIPT_SOURCE) {
      // The scan's `LIKE` is coarser than the parser: a token that starts
      // `audience:meeting:` but does not parse, or names another vendor's
      // meeting, is not this re-verifier's to touch. Not counted as a failure —
      // nothing failed — but logged, because the only ways to get here are a
      // format change or a stored token no minter would have produced.
      log.warn(
        { workspaceId, audienceId },
        "brain audience: a meeting audience token did not parse as this source's — skipping it",
      );
      continue;
    }
    try {
      const roster = await readMeetingRoster(token, parts.meetingId, deps);
      if (!roster.complete) {
        // Complete-or-abort. Aborting touches nothing, so the previous
        // membership stands and the next cycle retries — the only direction
        // that neither grants nor revokes on a fault.
        log.warn(
          { workspaceId, meetingId: parts.meetingId, reason: roster.reason },
          "brain audience: Zoom roster read was incomplete — membership unchanged for this meeting",
        );
        total = { ...total, failed: total.failed + 1 };
        continue;
      }
      const changed = await reconcileMeetingAudience(
        { workspaceId, audienceId, participants: roster.participants },
        deps,
      );
      total = sum(total, {
        reconciled: 1,
        failed: 0,
        membersAdded: changed.added,
        membersRevoked: changed.revoked,
        principalsUnresolved: changed.unresolved,
      });
    } catch (err) {
      log.warn(
        {
          workspaceId,
          meetingId: parts.meetingId,
          err: err instanceof Error ? err.message : String(err),
        },
        "brain audience: Zoom meeting audience re-verification failed — membership unchanged",
      );
      total = { ...total, failed: total.failed + 1 };
    }
  }
  return total;
}

/**
 * Register the Zoom re-verifier. Called from the same wiring seam that registers
 * the connector, so a deployment can never have one without the other — an
 * ingest path that mints audiences with no re-verifier is the silent-expiry bug
 * this module exists to prevent.
 */
export function registerZoomAudienceReverifier(deps: ZoomAudienceDeps): void {
  registerAudienceReverifier(ZOOM_TRANSCRIPT_SOURCE, () => reverifyZoomMeetingAudiences(deps));
}
