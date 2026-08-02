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
  selectReverifyCandidates,
  ZERO_REVERIFY,
  type AudienceReverifier,
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
 * A bound with teeth: past this many audiences the scan's ORDER decides which
 * ones are reached THIS cycle, so the ordering is load-bearing rather than
 * cosmetic. The tail is reached on LATER cycles — but only because the ordering
 * rotates on attempt; under the shipped one it was never reached at all.
 *
 * That ordering no longer lives here. It is {@link selectReverifyCandidates}'s,
 * shared with every other source (#4971), and the reason it had to move is worth
 * carrying at the cap it bounds.
 *
 * A naive stalest-first scan STARVES the audiences that matter, in two ways that
 * both end with `acl.ts` suppressing a grant while the cycle looks healthy:
 *
 *   1. an audience resolving to no Atlas users never gets a
 *      `fact_audience_member` row, so a `MIN(synced_at)` ordering sees NULL
 *      forever and sorts it first on every single cycle;
 *   2. an audience that ABORTS every cycle never advances `synced_at` either —
 *      Zoom's past-meeting participant report ages out of its retention window,
 *      so every sufficiently old meeting is one of these.
 *
 * Past this many of either, the deterministic scan returns the identical rows
 * every cycle and nothing behind them is ever re-verified. Ordering on ATTEMPT
 * rather than on success is what fixes both; raising this number is not, because
 * it moves the threshold and leaves the ordering that produced it.
 */
export const MAX_REVERIFY_AUDIENCES_PER_WORKSPACE = 200;

/**
 * The `visible_to` token prefix this source's audiences carry.
 *
 * NAMESPACE-wide rather than vendor-wide — `meeting:`, not `meeting:zoom:` — so
 * a token naming another vendor's meeting still comes back from the scan and
 * hits the parse check below, which logs it. Narrowing this would turn that
 * diagnostic into a silent skip.
 */
const MEETING_AUDIENCE_TOKEN_PREFIX = `${AUDIENCE_PREFIX}meeting:` as const;

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
    // Index-suffixed UNCONDITIONALLY. The earlier form only reached the index
    // when both `userId` and `email` were null — but Zoom emits one entry per
    // JOIN, so a participant who dropped and rejoined appears twice with the
    // SAME `user_id`. `resolvePrincipals` keys its map by id, so the duplicate
    // collapsed and `unresolvedCount = principals.length - resolved.size`
    // counted it as unresolved: every recurring meeting where anyone
    // reconnected over-reported "participants matched no Atlas user".
    // The id is a LOG subject here, never a join key, so suffixing costs nothing.
    id: `${participant.userId ?? participant.email ?? "participant"}-${index}`,
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
  // The internal-DB guard applies only to the REAL query path. An injected
  // `query` means the caller supplied the database, so gating on the process's
  // ambient one would make this function untestable without a live Postgres —
  // and, worse, would make it silently return "nothing to do" in a test that
  // believed it was exercising the scan. Same shape as `sync.ts`'s guard,
  // narrowed to the case it is actually about: a self-hosted deploy with no
  // internal DB has no episodes and no audiences to re-verify.
  if (deps.query === undefined && !hasInternalDB()) return ZERO_REVERIFY;
  const query = deps.query ?? internalQuery;
  const isEnabled = deps.isEnabled ?? isAudienceSyncEnabled;
  const resolveToken = deps.resolveToken;
  if (resolveToken === undefined) {
    // Unreachable in production — the connector literal in
    // `createZoomTranscriptConnector` binds one. NOT
    // `createZoomAudienceReverifier`, which forwards whatever deps it is handed
    // (`resolveToken` is optional on `ZoomAudienceDeps`, and test fixtures do
    // build it without one).
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
    if (!isEnabled(install.workspace_id)) {
      // NOT a silent skip, matching `outlook/audience.ts`'s twin. Ingest mints
      // `audience:` grants regardless of this flag, so a workspace with audience
      // sync switched off keeps accumulating meeting audiences that age past the
      // staleness bound and stop granting a week later — with this cycle
      // reporting clean. `sync.ts` counts the same condition as
      // `workspacesSkippedDisabled` for exactly this reason. No rotation is
      // consumed either: nothing is scanned, so nothing is stamped.
      log.warn(
        { workspaceId: install.workspace_id },
        "brain audience: audience sync is disabled for this workspace — its Zoom meeting audiences are NOT re-verified and will stop granting once they pass ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS",
      );
      continue;
    }
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

  // Scans AND stamps the attempt in one call, so this pass cannot consume a
  // slot without rotating the audience out of the front of the next scan
  // (#4971). Throws if either half fails, and the caller counts the workspace.
  const candidates = await selectReverifyCandidates(
    {
      workspaceId,
      source: ZOOM_TRANSCRIPT_SOURCE,
      tokenPrefix: MEETING_AUDIENCE_TOKEN_PREFIX,
      limit: MAX_REVERIFY_AUDIENCES_PER_WORKSPACE,
    },
    { query },
  );
  if (candidates.length === 0) return ZERO_REVERIFY;
  if (candidates.length >= MAX_REVERIFY_AUDIENCES_PER_WORKSPACE) {
    // The cap bounded this pass, so some audiences were NOT looked at. Silent
    // truncation here reads as "everything is fresh" when it is the opposite —
    // and the deferred tail is exactly what ages past the staleness bound.
    log.warn(
      { workspaceId, cap: MAX_REVERIFY_AUDIENCES_PER_WORKSPACE },
      "brain audience: this workspace has at least as many Zoom meeting audiences as the per-cycle cap — the tail is deferred to the next cycles, which now reach it because the scan rotates on attempt rather than on success. Check the failed count alongside this line: a tail that keeps growing means audiences are being attempted faster than they can be verified",
    );
  }

  // Resolved ONCE per workspace, outside the per-audience loop: a token call per
  // meeting would multiply the auth endpoint's load by the audience count for no
  // gain, and the token outlives a whole pass.
  //
  // AFTER the scan, deliberately — and this ordering was tried the other way and
  // reverted, so it is a decision rather than an accident. Hoisting it looks
  // tidier: the scan STAMPS every candidate, so a workspace whose credential is
  // revoked "consumes" a page of rotation without making one vendor call. But
  // that cosmetic complaint costs two real things. An enabled install with ZERO
  // live audiences would resolve a token it never uses on every cycle — and
  // `resolveZoomToken` is a credential decrypt plus a live token exchange, with
  // no cache — and if that credential is broken the workspace reports
  // `failed: 1` forever, so the cycle stands permanently `degraded` over a
  // workspace with nothing to verify.
  //
  // And the fairness it was meant to buy is not real: a token failure hits every
  // audience in the workspace equally, so stamping them all is the CORRECT
  // rotation outcome, not a lie. Nothing is starved either way.
  const token = await resolveToken(workspaceId, install.install_id, install.config);

  let total = ZERO_REVERIFY;
  for (const candidate of candidates) {
    const audienceId = candidate.audienceId;
    const parts = parseMeetingAudienceId(audienceId);
    if (parts === null || parts.source !== ZOOM_TRANSCRIPT_SOURCE) {
      // The scan's prefix is coarser than the parser: a token that starts
      // `audience:meeting:` but does not parse, or names another vendor's
      // meeting, is not this re-verifier's to touch. Not counted as a failure —
      // nothing failed — but logged, because the only ways to get here are a
      // format change or a stored token no minter would have produced.
      //
      // It HAS been attempt-stamped by now, which is correct rather than a leak:
      // it consumed a slot, and a token that never stamped would sit on NULL
      // forever and pin the front of every future scan — #4971's starvation,
      // rebuilt out of the one case nothing can ever reconcile.
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
      // A past meeting's roster CANNOT shrink — nobody un-attends a meeting.
      // So an empty roster for an audience that currently has members is not a
      // legitimate transition; it is an unreadable report (Zoom's past-meeting
      // data ages out of its retention window) wearing the shape of a mass
      // removal. Reconciling it would revoke everyone, and from `/admin` that
      // is indistinguishable from correct fail-closed behaviour.
      //
      // Note this guard belongs ONLY here, not at ingest: at ingest an empty
      // roster is the FLAG side working (an all-external meeting grants nobody
      // and repairs itself later), and there is no prior membership to protect.
      if (roster.participants.length === 0 && candidate.hasMembers) {
        log.error(
          { workspaceId, meetingId: parts.meetingId },
          "brain audience: Zoom returned an EMPTY roster for a meeting whose audience has members — a past meeting's roster cannot shrink, so this is treated as an unreadable report. Membership unchanged; check Zoom's past-meeting report retention for this account",
        );
        total = { ...total, failed: total.failed + 1 };
        continue;
      }
      // ⚠️ ACCEPTED RISK, recorded so it is not rediscovered as a hole: this
      // guard defends the EMPTY case, not the WRONG one. Outlook's audience id
      // embeds a digest of the participant set (`grant.ts`), so a complete-looking
      // but substituted recipient list hashes differently and is refused —
      // a shrunken set is not a representable input to its reconcile. A meeting
      // id embeds only the meeting uuid, so any complete-looking roster Zoom
      // returns for that uuid is reconciled, and whoever is not in it is revoked.
      //
      // NOT fixed, deliberately. A past meeting's roster is as frozen as an
      // email's headers, so the digest is constructible — but the audience id is
      // already minted onto APPEND-ONLY episode rows (0180: no `updated_at`, no
      // upsert), so changing its shape means migrating every stored
      // `audience:meeting:zoom:…` grant with no update path, to defend against
      // Zoom returning another meeting's roster for a uuid it owns. That is a
      // vendor bug, not an attack, and the migration is riskier than the risk.
      // Revisit if Zoom's per-instance uuids ever stop being per-instance.
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
 * Build the Zoom re-verifier. It is the `audience` half of the Zoom connector
 * value (`connector.ts`), so a deployment can never have one without the other —
 * an ingest path that mints audiences with no re-verifier is the silent-expiry
 * bug this module exists to prevent.
 *
 * Returns rather than registers (#4985): the registration is
 * `registerBrainSourceConnector`'s single all-or-nothing write, and a second
 * function that also wrote to the re-verifier registry would be exactly the loose
 * half a caller can commit on its own.
 */
export function createZoomAudienceReverifier(deps: ZoomAudienceDeps): AudienceReverifier {
  return () => reverifyZoomMeetingAudiences(deps);
}
