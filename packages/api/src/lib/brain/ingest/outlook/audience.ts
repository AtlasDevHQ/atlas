/**
 * Mail-message audience membership (#4966) — the LIVE half of an email grant.
 *
 * `deriveEmailRecipientGrant` mints
 * `audience:email-message:outlook:<mailboxId>:<messageId>` and `reconcile.ts`
 * inherits it onto every fact extracted from that message. Neither populates
 * `fact_audience_member`, so without this module the audience resolves to NOBODY
 * and every email fact is stored, gated, and invisible — the state #4801 found
 * the chat side in, and the state `zoom/audience.ts` exists to prevent for
 * meetings.
 *
 * ## Two entry points, one reconcile
 *
 * {@link reconcileEmailAudience} is the shared core, called from two places that
 * differ only in WHERE the header set came from:
 *
 *   1. **At ingest** (`client.ts`), from the headers the pass just read to
 *      license the grant. Doing it here rather than deferring to the fiber
 *      avoids a second identical vendor read and closes the window in which a
 *      freshly-ingested message's facts exist with an audience nobody is in.
 *
 *      ⚠️ ORDER: membership is written BEFORE the episodes are handed back for
 *      ingest, never after. The failure modes are not symmetric. Membership
 *      without episodes is an audience nothing references — inert. Episodes
 *      without membership is a message whose facts are invisible to the people
 *      it was addressed to, for as long as it takes the re-verifier to come
 *      round. One is a no-op, the other is a silent outage.
 *
 *   2. **On the clock** ({@link reverifyOutlookMessageAudiences}), from a fresh
 *      header read, registered through `audience/reverify.ts`.
 *
 * ## Why a FROZEN header set still needs re-verification
 *
 * The same argument `zoom/audience.ts` makes for a frozen participant list, and
 * it is stronger here rather than weaker. A meeting's roster at least cannot be
 * re-read wrongly; an email's `To`/`Cc` headers are literally immutable — they
 * were written once by the sending system and no API can change them.
 *
 * What changes is the RESOLUTION of those addresses to Atlas users:
 *
 *   - someone leaves the org → their `member` row goes → `resolvePrincipals`
 *     stops matching them → the reconcile REVOKES. That is the revocation path
 *     ADR-0036 built `audience:` for, and freezing `user:` tokens at ingest
 *     would not have it;
 *   - someone joins Atlas after the message → they now match → the reconcile
 *     GRANTS. An email to five external customers becomes visible to the one who
 *     later got an account, with no re-ingest and no rewrite of a stored row.
 *
 * And underneath both, `acl.ts` (#4808) suppresses any audience whose
 * `synced_at` is older than `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`
 * (default 168h). An audience written once at ingest and never touched again
 * stops granting a week later — silently, with the facts still stored and every
 * sync still green.
 *
 * ⚠️ REGISTRATION IS NOT EXECUTION. `connector.ts` guarantees this re-verifier
 * EXISTS whenever the connector does, by registering both in one call. It does
 * not guarantee the fiber RUNS: `effect/layers.ts` gates the whole periodic
 * audience cycle on `ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED` (platform), and
 * {@link reverifyOutlookMessageAudiences} re-checks it per workspace. An admin
 * who switches that off gets precisely the silent expiry above — which is why
 * the per-workspace skip below is logged rather than passed over, and why that
 * setting's description names this source rather than only Slack.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ██  THE GRAIN PROBLEM — read before changing the cap
 * ══════════════════════════════════════════════════════════════════════
 *
 * Every source before this one mints audiences per CONTAINER: one per Slack
 * channel, one per meeting. Their audience count grows with how much a company
 * is set up, and it plateaus.
 *
 * **This source mints one audience per MESSAGE**, because that is the grain the
 * grant has to be at (`config.ts` §Granularity: a thread-grained audience
 * over-grants to whoever was added on a later reply, and `grant.ts` puts
 * over-granting on the leak side). So the audience count grows with EPISODE
 * count, without bound, and re-verification capacity is fixed:
 *
 *     200 audiences/workspace/cycle × 48 cycles/day (30-min default cadence)
 *       = 9,600 re-verifications/day
 *     × 7 days (the 168h staleness bound)
 *       ≈ 67,000 audiences that can be kept fresh in one workspace
 *
 * Past that, the tail ages beyond the bound and `acl.ts` suppresses it. The
 * consequence is fail-CLOSED — email facts become INVISIBLE, never
 * over-visible — which is the right direction and is still a real degradation
 * that reports nothing louder than the cap warning below. Raising the cap moves
 * the number; it does not change the shape, and it spends proportionally more
 * Graph calls per cycle.
 *
 * ⚠️ INHERITED FROM #4971, AND WORSE HERE THAN FOR ZOOM. That issue is OPEN and
 * has NOT landed on `milestone/brain-m3` as this connector ships: the scan below
 * orders on `MIN(synced_at)`, which only a SUCCESSFUL reconcile advances, so an
 * audience that fails every cycle never rotates out of the front of the scan and
 * starves everything behind it. This connector deliberately does NOT carry a
 * second copy of the fix — #4971's acceptance criteria put it behind
 * `audience/reverify.ts` precisely so both sources inherit one implementation —
 * and it will inherit the fix when that lands.
 *
 * Email makes the starvation likelier than Zoom did, for a reason specific to
 * Graph: mailbox access is revocable at any time (an ApplicationAccessPolicy
 * edit, a licence change, a deleted user), and a revoked mailbox fails EVERY one
 * of its audiences on EVERY cycle. Zoom's equivalent — a past-meeting report
 * ageing out of retention — arrives gradually. This one arrives all at once, for
 * every audience minted from that mailbox, the moment an Exchange admin makes a
 * change Atlas cannot see.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { AUDIENCE_PREFIX } from "@atlas/api/lib/brain/acl";
import {
  emailParticipantsDigest,
  parseEmailMessageAudienceId,
} from "@atlas/api/lib/brain/ingest/grant";
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
import { fetchMessageByInternetMessageId, type OutlookMessage } from "./api";
import {
  OUTLOOK_MAIL_SOURCE,
  OUTLOOK_MAIL_CATALOG_ID,
  parseOutlookMailConfig,
} from "./config";

const log = createLogger("brain.ingest.outlook.audience");

/**
 * Message audiences re-verified per workspace per cycle.
 *
 * ⚠️ Read the module header's GRAIN PROBLEM section before changing this. Unlike
 * the Zoom constant it mirrors, this cap is not merely a fairness bound on a
 * plateauing set — it is the ceiling on how many email audiences a workspace can
 * keep inside the staleness bound at all, and the set it bounds grows with every
 * message ingested.
 *
 * The same starvation caveat applies as for Zoom and applies harder: a
 * permanently-failing audience never rotates out of the front of the scan
 * (#4971, open and not landed).
 */
export const MAX_REVERIFY_AUDIENCES_PER_WORKSPACE = 200;

/**
 * Hard bound on participants per message.
 *
 * A message addressed to a 5,000-entry distribution list has a perfectly
 * well-established audience — this is not a safety refusal — but reconciling it
 * writes one `fact_audience_member` row per resolved recipient, per message, and
 * a mailbox full of all-hands mail would spend the whole cycle on one thread.
 *
 * Over the bound the message is SKIPPED and COUNTED, and the walk still advances
 * past it. Not blocked-and-retried: the recipient count of a stored message is a
 * PERMANENT fact, so retrying would freeze the cursor forever — the failure
 * `zoom/client.ts`'s `too_large` comment describes, where a size guard became an
 * outage. Raising this bound re-admits previously skipped mail on the next
 * backfill rather than repairing it in place, which is stated because it is the
 * operator's actual question.
 */
export const MAX_MESSAGE_PARTICIPANTS = 500;

/**
 * The workspace's Outlook message audiences, STALEST FIRST.
 *
 * Sourced from `brain_episodes.visible_to` rather than from
 * `fact_audience_member`, deliberately: membership is the thing being repaired,
 * so an audience with NO members — the message addressed entirely to external
 * customers — has no row there and would be invisible to a scan of it. That is
 * exactly the audience the "someone joined Atlas later" repair exists for.
 *
 * Reading `visible_to` also means only LIVE audiences are scanned. That matters
 * more here than for Zoom, because this connector genuinely mints audiences that
 * no episode ends up naming, by two routes:
 *
 *   - the Message-ID dedupe collapses one mail across every recipient mailbox to
 *     ONE episode, so the second mailbox to see it writes membership for an
 *     audience whose episode insert then no-ops;
 *   - every SKIP that lands AFTER the membership write does the same — an HTML
 *     body, an oversize body, a compose that came out empty. `client.ts` writes
 *     membership before those checks because the audience must be established
 *     before any content decision, and the cost is these orphans.
 *
 * They are inert (nothing references them) and this scan never spends a cycle on
 * them, but they are rows: on a 50-mailbox install an all-internal thread can
 * write up to 50× the `fact_audience_member` rows it needs, with no TTL and no
 * sweeper. Worth knowing before raising the mailbox cap.
 *
 * ## The ordering, which is two keys and not one
 *
 * Identical to `zoom/audience.ts`'s and load-bearing for the same reason: a
 * naive `MIN(synced_at) ASC NULLS FIRST` alone STARVES the audiences that
 * matter. An audience resolving to no Atlas users never gets a
 * `fact_audience_member` row, so its `MIN(synced_at)` is NULL forever and it
 * sorts first on every cycle; past the cap, the deterministic scan returns the
 * identical rows every time and no member-BEARING audience is re-verified again.
 *
 * So the primary key is `has_members DESC`: audiences whose suppression would
 * actually cost somebody access go first, and a successful reconcile advances
 * their `synced_at` (`TOUCH_AUDIENCE_MEMBERS_SQL` stamps even the no-op case) so
 * they rotate to the back. Member-less audiences take whatever cap remains.
 *
 * Within each group it is `MIN(synced_at)` — an audience is as verified as its
 * LEAST recently verified row, matching `acl.ts`'s own `min(synced_at)` reading.
 *
 * Exported so a caller can execute this exact string rather than a paraphrase.
 * NOTE there is no `-pg` test behind it yet — the same gap `zoom/audience.ts`
 * declares. Until one exists, a `visible_to` or `fact_audience_member` shape
 * change breaks this at runtime, not in CI.
 */
export const OUTLOOK_MESSAGE_AUDIENCES_SQL = `
  SELECT t.token AS token,
         MIN(m.synced_at) AS synced_at,
         count(m.user_id) > 0 AS has_members
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
   ORDER BY (count(m.user_id) > 0) DESC, MIN(m.synced_at) ASC NULLS FIRST, t.token ASC
   LIMIT $5
` as const;

/** The DB + vendor surface this module needs — injectable so tests need no HTTP. */
export interface OutlookAudienceDeps {
  readonly query?: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
  readonly fetchMessage?: typeof fetchMessageByInternetMessageId;
  readonly reconcile?: typeof reconcileAudienceMembership;
  readonly resolve?: typeof resolvePrincipals;
  /**
   * Resolve the workspace's Graph bearer token. Injected by the connector.
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

/** One addressed participant, with a NON-identifying id for logs. */
export interface EmailParticipant {
  /**
   * A positional label — `from`, `to:0`, `cc:3` — never the address.
   *
   * `resolvePrincipals` logs a SAMPLE of unresolved principal ids, and its
   * docstring commits to those ids never being emails ("a log line is not a
   * place to put a directory dump of addresses"). Slack and Zoom satisfy that
   * for free because their vendors issue opaque user ids; email has no
   * non-address identifier at all, so one is synthesised here.
   *
   * Positional rather than hashed so it is at least READABLE as a header slot.
   *
   * ⚠️ Be honest about what that does NOT buy. `resolvePrincipals` logs its
   * unresolved sample with `workspaceId` alone — no audience id, no mailbox, no
   * Message-ID — so `cc:3` on its own does not let an operator reach the
   * message. The correlating line is `client.ts`'s reconcile log, which now
   * carries the audience id for that purpose; the two still have to be joined by
   * hand. The property that holds unconditionally is the PRIVACY one: no address
   * reaches the log. Do not read this label as an investigation tool it is not.
   */
  readonly id: string;
  readonly address: string;
}

/**
 * The participant set of one message: sender, To, Cc — deduped, in header order.
 *
 * **Bcc is not read, and this function could not read it if it wanted to**:
 * `OutlookMessage` carries no bcc field and `$select` does not request one. That
 * is the email class's ACL posture made structural rather than merely intended,
 * and `grant.ts`'s {@link deriveEmailRecipientGrant} carries the full argument —
 * the short version is that honouring BCC would make the derived grant depend on
 * which mailbox copy the dedupe happened to keep.
 *
 * Deduped case-insensitively by address: the same person on To and Cc is one
 * participant, and counting them twice would inflate `unresolvedCount` into a
 * metric nobody can act on.
 */
export function messageParticipants(message: OutlookMessage): readonly EmailParticipant[] {
  const seen = new Set<string>();
  const participants: EmailParticipant[] = [];
  const push = (address: string | null, id: string): void => {
    if (address === null) return;
    const normalized = address.trim().toLowerCase();
    if (normalized === "" || seen.has(normalized)) return;
    seen.add(normalized);
    participants.push({ id, address: normalized });
  };
  push(message.from?.address ?? null, "from");
  message.toRecipients.forEach((recipient, index) => push(recipient.address, `to:${index}`));
  message.ccRecipients.forEach((recipient, index) => push(recipient.address, `cc:${index}`));
  return participants;
}

/** What one audience reconcile concluded. */
export interface EmailAudienceResult {
  readonly added: number;
  readonly revoked: number;
  readonly unresolved: number;
}

/**
 * Resolve a complete participant set to Atlas users and reconcile the audience.
 *
 * THROWS on a resolution or DB fault, and does not catch: the caller counts the
 * audience as failed and leaves the previous membership in place, which is the
 * only direction that neither grants nor revokes on a fault. Swallowing here
 * would hand the reconcile an empty set — indistinguishable from "everyone was
 * removed" — and revoke the whole audience during an incident.
 *
 * A participant set that resolves to NOBODY is reconciled to empty, not skipped.
 * That is the FLAG side of ADR-0036 §T6's asymmetry: a mail to five external
 * customers has a well-established audience that currently contains no Atlas
 * users, and the faithful result is an empty audience that repairs itself the
 * moment one of them gets an account. Skipping the reconcile to "protect" the
 * rows would preserve exactly the stale access this table exists to drop.
 */
export async function reconcileEmailAudience(
  input: {
    readonly workspaceId: string;
    /** Audience id WITHOUT the `audience:` prefix. */
    readonly audienceId: string;
    readonly participants: readonly EmailParticipant[];
  },
  deps: OutlookAudienceDeps = {},
): Promise<EmailAudienceResult> {
  const resolve = deps.resolve ?? resolvePrincipals;
  const reconcile = deps.reconcile ?? reconcileAudienceMembership;

  const resolution = await resolve(
    input.workspaceId,
    input.participants.map((participant) => ({
      id: participant.id,
      email: participant.address,
    })),
  );
  const userIds = [...new Set(resolution.resolved.values())];

  const changed = await reconcile({
    workspaceId: input.workspaceId,
    audienceId: input.audienceId,
    source: OUTLOOK_MAIL_SOURCE,
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
  readonly has_members: boolean;
}

interface InstallRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly install_id: string;
  readonly config: Record<string, unknown> | null;
}

/**
 * Re-verify every workspace's Outlook message audiences — the clock-driven half.
 *
 * NEVER throws: it is drained by `runRegisteredAudienceReverifiers`, and a throw
 * there costs the other sources their pass. Every fault is isolated to the
 * narrowest scope that owns it — a workspace, then an audience — and counted, so
 * a re-verification that stopped working shows up as `failed > 0` (which makes
 * the cycle report `degraded`) rather than as silence.
 */
export async function reverifyOutlookMessageAudiences(
  deps: OutlookAudienceDeps = {},
): Promise<AudienceReverifyResult> {
  // The internal-DB guard applies only to the REAL query path. An injected
  // `query` means the caller supplied the database, so gating on the process's
  // ambient one would make this function untestable without a live Postgres —
  // and, worse, would make it silently return "nothing to do" in a test that
  // believed it was exercising the scan.
  if (deps.query === undefined && !hasInternalDB()) return ZERO_REVERIFY;
  const query = deps.query ?? internalQuery;
  const isEnabled = deps.isEnabled ?? isAudienceSyncEnabled;
  const resolveToken = deps.resolveToken;
  if (resolveToken === undefined) {
    // Unreachable in production — `registerOutlookMailConnector` binds one.
    // Loud rather than a silent no-op: a re-verifier that quietly does nothing
    // lets every message audience age past the staleness bound while the cycle
    // reports success, which is the exact failure this module exists to prevent.
    log.error({}, "brain audience: Outlook re-verifier has no token resolver — skipping the pass");
    return { ...ZERO_REVERIFY, failed: 1 };
  }

  let installs: InstallRow[];
  try {
    installs = await query<InstallRow>(AUDIENCE_SYNC_INSTALLS_SQL, [OUTLOOK_MAIL_CATALOG_ID]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "brain audience: Outlook install scan failed — no message audience was re-verified this cycle",
    );
    return { ...ZERO_REVERIFY, failed: 1 };
  }

  let total = ZERO_REVERIFY;
  for (const install of installs) {
    if (!isEnabled(install.workspace_id)) {
      // NOT a silent skip. Ingest mints `audience:` grants regardless of this
      // flag, so a workspace with audience sync switched off keeps accumulating
      // email audiences that age past the staleness bound and stop granting a
      // week later — with this cycle reporting clean. `sync.ts` counts the same
      // condition as `workspacesSkippedDisabled` for exactly this reason.
      log.warn(
        { workspaceId: install.workspace_id },
        "brain audience: audience sync is disabled for this workspace — its Outlook message audiences are NOT re-verified and will stop granting once they pass ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS",
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
        "brain audience: Outlook workspace re-verification failed — membership unchanged, retrying next cycle",
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
  query: NonNullable<OutlookAudienceDeps["query"]>,
  resolveToken: NonNullable<OutlookAudienceDeps["resolveToken"]>,
  deps: OutlookAudienceDeps,
): Promise<AudienceReverifyResult> {
  const workspaceId = install.workspace_id;
  const parsed = parseOutlookMailConfig(install.config);
  if (!parsed.ok) {
    log.warn(
      { workspaceId, error: parsed.error },
      "brain audience: Outlook install config is unreadable — its message audiences were not re-verified",
    );
    return { ...ZERO_REVERIFY, failed: 1 };
  }

  const rows = await query<AudienceRow>(OUTLOOK_MESSAGE_AUDIENCES_SQL, [
    workspaceId,
    OUTLOOK_MAIL_SOURCE,
    `${AUDIENCE_PREFIX}email-message:%`,
    AUDIENCE_PREFIX,
    MAX_REVERIFY_AUDIENCES_PER_WORKSPACE,
  ]);
  if (rows.length === 0) return ZERO_REVERIFY;
  if (rows.length >= MAX_REVERIFY_AUDIENCES_PER_WORKSPACE) {
    // The cap bounded this pass, so some audiences were NOT looked at. Silent
    // truncation reads as "everything is fresh" when it is the opposite — and
    // the deferred tail is exactly what ages past the staleness bound. For this
    // source the warning is expected rather than exceptional once a workspace
    // has more than a few tens of thousands of messages, which the module
    // header's GRAIN PROBLEM section quantifies.
    log.warn(
      { workspaceId, cap: MAX_REVERIFY_AUDIENCES_PER_WORKSPACE },
      "brain audience: this workspace has at least as many Outlook message audiences as the per-cycle cap — the tail is deferred. This source mints one audience per MESSAGE, so the set grows without bound; check the failed count alongside this line, because an audience that FAILS every cycle never rotates out of the front (#4971)",
    );
  }

  const token = await resolveToken(workspaceId, install.install_id, install.config);
  const fetchMessage = deps.fetchMessage ?? fetchMessageByInternetMessageId;

  let total = ZERO_REVERIFY;
  for (const row of rows) {
    const audienceId = row.token.slice(AUDIENCE_PREFIX.length);
    const parts = parseEmailMessageAudienceId(audienceId);
    if (parts === null || parts.source !== OUTLOOK_MAIL_SOURCE) {
      // The scan's `LIKE` is coarser than the parser: a token that starts
      // `audience:email-message:` but does not parse, or names another vendor's
      // message, is not this re-verifier's to touch. Not counted as a failure —
      // nothing failed — but logged, because the only ways to get here are a
      // format change or a stored token no minter would have produced.
      log.warn(
        { workspaceId, audienceId },
        "brain audience: a message audience token did not parse as this source's — skipping it",
      );
      continue;
    }
    try {
      const found = await fetchMessage(token, parts.mailboxId, parts.messageId);
      if (!found.ok) {
        // Complete-or-abort. Aborting touches nothing, so the previous
        // membership stands and the next cycle retries — the only direction
        // that neither grants nor revokes on a fault.
        log.warn(
          { workspaceId, mailboxId: parts.mailboxId, error: found.error },
          "brain audience: Outlook message read failed — membership unchanged for this message",
        );
        total = { ...total, failed: total.failed + 1 };
        continue;
      }
      if (found.message === null) {
        // Graph answered cleanly and the mailbox does not contain the message —
        // it was deleted, or moved to a mailbox this app can no longer read.
        // That is an UNREADABLE header set, NOT a message with no recipients:
        // an email's headers cannot change, so "no participants now" is never a
        // legitimate transition for an audience that was minted from some. The
        // distinction is the whole point, because reconciling the absent case
        // would revoke everyone, and from `/admin` that is indistinguishable
        // from correct fail-closed behaviour.
        log.warn(
          { workspaceId, mailboxId: parts.mailboxId },
          "brain audience: Outlook no longer returns this message — treating it as unreadable rather than as an empty audience. Membership unchanged; the message may have been deleted or the mailbox's access revoked",
        );
        total = { ...total, failed: total.failed + 1 };
        continue;
      }
      if (!found.message.headersComplete) {
        // The participant fields did not all come back. Same abort: a partial
        // header set reaching the reconcile revokes whoever it dropped.
        log.warn(
          { workspaceId, mailboxId: parts.mailboxId },
          "brain audience: Outlook returned a message with incomplete participant headers — membership unchanged",
        );
        total = { ...total, failed: total.failed + 1 };
        continue;
      }
      const participants = messageParticipants(found.message);
      if (
        participants.length > 0 &&
        emailParticipantsDigest(participants.map((p) => p.address)) !== parts.participantsDigest
      ) {
        // ⭐ The token says which participant set this audience was minted from,
        // and the message we just re-read describes a different one. For an
        // email that is not a legitimate transition — headers are immutable — so
        // one of two things happened: the mailbox now holds a DIFFERENT message
        // claiming the same Message-ID (a forged header; see `grant.ts`), or the
        // vendor returned something other than what was ingested.
        //
        // Either way the only safe move is to touch nothing. Reconciling would
        // hand `reconcileAudienceMembership` a set the audience was never named
        // for, and it deletes everyone outside the set it is handed — so this is
        // the exact line between "membership repaired" and "membership
        // rewritten by whoever chose the Message-ID".
        log.error(
          { workspaceId, mailboxId: parts.mailboxId },
          "brain audience: the re-read message's participants do not match the set this audience was minted from — refusing to reconcile. A Message-ID is chosen by the sending system, so a mismatch can mean a forged duplicate; membership is unchanged",
        );
        total = { ...total, failed: total.failed + 1 };
        continue;
      }
      if (participants.length === 0) {
        // Headers complete and yet nobody in them. Not a legitimate transition
        // for an audience that exists — it was minted from at least one
        // participant — so it is unreadable data wearing the shape of a mass
        // removal.
        //
        // STRICTER than `zoom/audience.ts`'s empty-roster guard, which fires
        // only when `row.has_members`. The divergence is deliberate and the
        // reason is the class, not the connector: a Zoom roster can legitimately
        // be empty at ingest (an all-external meeting), so Zoom needs the
        // prior-membership condition to tell a legal empty from an unreadable
        // one. An email's headers are IMMUTABLE, so no zero-participant read is
        // ever legal for an audience that was minted from some — which is why
        // this scan selects `has_members` and never reads it.
        log.error(
          { workspaceId, mailboxId: parts.mailboxId },
          "brain audience: Outlook returned a message with NO participants for an audience that was minted from some — treating it as unreadable. Membership unchanged",
        );
        total = { ...total, failed: total.failed + 1 };
        continue;
      }
      const changed = await reconcileEmailAudience({ workspaceId, audienceId, participants }, deps);
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
          mailboxId: parts.mailboxId,
          err: err instanceof Error ? err.message : String(err),
        },
        "brain audience: Outlook message audience re-verification failed — membership unchanged",
      );
      total = { ...total, failed: total.failed + 1 };
    }
  }
  return total;
}

/**
 * Register the Outlook re-verifier. Called from the same wiring seam that
 * registers the connector, so a deployment can never have one without the other
 * — an ingest path that mints audiences with no re-verifier is the silent-expiry
 * bug this module exists to prevent.
 */
export function registerOutlookAudienceReverifier(deps: OutlookAudienceDeps): void {
  registerAudienceReverifier(OUTLOOK_MAIL_SOURCE, () => reverifyOutlookMessageAudiences(deps));
}
