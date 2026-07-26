/**
 * The audience-membership sync cycle (#4801, ADR-0036 §Access control &
 * residency) — the periodic fiber that keeps a private chat channel's
 * `audience:` grant resolving to real people.
 *
 * `deriveChatChannelGrant` (#4770) mints `audience:chat-channel:<source>:<id>`
 * for a private channel and `reconcile.ts` (#4771) inherits it onto every fact.
 * Neither populates `fact_audience_member`, so before this module the audience
 * resolved to NOBODY: a private channel's episodes and facts were stored,
 * gated, and invisible to every reader. Fail-closed, and repairable by writing
 * membership rows alone — which is what this does.
 *
 * ## Why the audience comes from the GRANT, not from a second derivation
 *
 * The cycle passes `conversations.info`'s visibility bit — the same value
 * `slack/client.ts` passes at ingest — to `deriveChatChannelGrant`, then reads
 * the answer out of `parseGrant`. It calls neither `chatChannelAudienceId` nor
 * any `isPrivate` branch of its own; `resolveChannelAudience` is the whole of
 * its dealings with visibility.
 *
 * That is the difference between a sync that populates *an* audience and one
 * that populates *the audience the facts were granted to*. Two independent
 * derivations agree until one of them changes — a namespace edit, a new
 * visibility arm, a vendor whose "private" is conditional — and on that day the
 * sync writes membership for an audience no fact names, so every private fact
 * silently returns to invisible while the cycle reports success. Routing both
 * the id AND the public/private decision through the deriver makes the two
 * unable to disagree: whatever it decides is what gets synced, including its
 * `null` (blocked) and its `[org]` (public → no audience → nothing to sync).
 *
 * ## Completeness is what licenses the DELETE
 *
 * Revocation means `membership.ts` deletes everyone not in the roster it is
 * handed. A truncated Slack read would therefore REVOKE the members it failed
 * to fetch, and — because episodes are gated, not deleted — the damage looks
 * exactly like correct fail-closed behaviour from every surface. So both vendor
 * reads here are complete-or-abort:
 *
 *   - The DIRECTORY (`users.list`) is per workspace. Incomplete → the whole
 *     workspace is skipped, because every channel's resolution depends on it.
 *   - The ROSTER (`conversations.members`) is per channel. Incomplete → that
 *     one audience is skipped; the workspace's other channels still sync.
 *
 * Aborting touches nothing, so the previous membership stands. That is the only
 * safe direction: it neither grants nor revokes on a fault, and the next cycle
 * retries. ADR-0036 §T6's block-vs-flag asymmetry, applied to membership.
 *
 * Two later amendments bound how long that can go on for, because "the previous
 * membership stands" with no time limit means a channel Atlas was removed from
 * keeps granting access forever:
 *
 *   - #4809 gives both reads a bounded `Retry-After` backoff, so a workspace
 *     large enough to 429 on every cycle can still finish a read. Exhausting
 *     the retries STILL ABORTS — retrying buys more chances to complete the
 *     read, never permission to settle for less of one.
 *   - #4808 stamps `synced_at` on every successful reconcile (including the
 *     no-op case — "unchanged" is still "verified") and never on an abort, so
 *     `acl.ts` can stop expanding an audience nobody has verified within
 *     `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`. Abort is still the safe
 *     direction; it is simply no longer an indefinite one.
 *
 * ## Why this is its own fiber
 *
 * Not folded into the history pass, which would only re-read a roster when a
 * channel had new messages. A quiet channel is exactly where a stale roster
 * survives longest — someone leaves, nobody posts, and their access never
 * expires. Membership freshness has to be driven by the clock, not by traffic.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  fetchConversationMembersPage,
  fetchUsersListPage,
  getConversationInfo,
  type SlackDirectoryUser,
  type SlackReadError,
} from "@atlas/api/lib/slack/api";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import { withRateLimitBackoff } from "@atlas/api/lib/knowledge/connector-sync";
import { getBotToken, getInstallationByOrg } from "@atlas/api/lib/slack/store";
import {
  DEFAULT_AUDIENCE_MAX_STALENESS_HOURS,
  getAudienceMaxStalenessSeconds,
  parseGrant,
} from "@atlas/api/lib/brain/acl";
import {
  deriveChatChannelGrant,
  type ChatChannelVisibility,
} from "@atlas/api/lib/brain/ingest/grant";
import {
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_SOURCE,
  parseSlackHistoryConfig,
} from "@atlas/api/lib/brain/ingest/slack/config";
import { resolveSlackHistoryToken } from "@atlas/api/lib/brain/ingest/slack/connector";
import { reconcileAudienceMembership } from "./membership";
import { resolvePrincipals } from "./resolver";

const log = createLogger("brain.audience.sync");

/** Slack's recommended page size for both paginated reads. */
const PAGE_LIMIT = 200;

/** Hard bound on directory pages per workspace per cycle (~40k users). */
export const MAX_DIRECTORY_PAGES = 200;

/** Hard bound on roster pages per channel per cycle (~40k members). */
export const MAX_ROSTER_PAGES = 200;

/**
 * The directory members resolution actually consumes.
 *
 * ONE definition, because every completeness guard in this module keys off it
 * and their agreement is load-bearing. Written twice, it produced exactly the
 * failure this module argues against elsewhere: the first cut inlined
 * `!deleted && !isBot` in two places and gated its guards on
 * `humans.length > 0`, so a directory of only bots and deactivated accounts
 * slipped past all of them and reconciled every audience to empty — the same
 * mass revocation, through a third door.
 *
 * A bot has no Atlas account to resolve to, and a deactivated Slack user is
 * someone the workspace already revoked at the source; carrying either into an
 * audience would make Atlas the one system that kept their access.
 */
function isLiveHuman(user: SlackDirectoryUser): boolean {
  return !user.deleted && !user.isBot;
}

function liveHumans(
  directory: ReadonlyMap<string, SlackDirectoryUser>,
): readonly SlackDirectoryUser[] {
  return [...directory.values()].filter(isLiveHuman);
}

// ---------------------------------------------------------------------------
// Rate-limit backoff (#4809) — an ADAPTER onto the engine's, not a second one
// ---------------------------------------------------------------------------

/** Injectable sleep, so the backoff tests do not actually wait. */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Per-cycle throttle tally.
 *
 * Lives at CYCLE level rather than inside `syncInstall`, because the case worth
 * seeing is the one where the directory read exhausts its retries and
 * `syncInstall` throws — a tally owned by the frame that dies with it would be
 * lost in exactly the "this workspace 429s on every cycle and never
 * reconciles" scenario #4809 is about.
 *
 * Mutable by design: it is an accumulator threaded through two paginated loops
 * and one throw, and the alternative (reshaping three return types to carry
 * counters through an abort path) buys nothing.
 */
interface ThrottleTally {
  /** Reads that hit at least one 429 and then SUCCEEDED — recovered, not lost. */
  throttled: number;
  /** Reads that exhausted the bounded retries and aborted their scope. */
  exhausted: number;
}

/**
 * Run one paginated Slack read under the shared bounded backoff.
 *
 * The seam that makes reuse possible: `withRateLimitBackoff` catches a THROWN
 * {@link ConnectorRateLimitError}, but these two read methods RETURN
 * `{ ok: false, error: "ratelimited", retryAfterSeconds }` instead. So the
 * conversion happens here, in the same direction
 * `brain/ingest/slack/client.ts::toClientError` already converts for the
 * sibling history reads on this same vendor — one backoff implementation for
 * the whole codebase, per ADR-0030's rejection of per-vendor scheduling.
 *
 * ## Exhaustion still ABORTS
 *
 * On exhaustion this hands back the SAME `ratelimited` shape the caller already
 * had, so every completeness guard downstream is untouched: the directory read
 * skips the workspace, the roster read skips the audience, and membership is
 * left alone. That is not a detail — the DELETE in `membership.ts` is licensed
 * ONLY by a complete read, and a retry loop that ended by proceeding with a
 * partial page would be the mass revocation this subsystem has already produced
 * three times. Retrying buys more chances to complete the read; it must never
 * buy permission to settle for less of one.
 */
async function readPageWithBackoff<T extends { readonly ok: true }>(
  fetchPage: () => Promise<T | SlackReadError>,
  context: string,
  tally: ThrottleTally,
  sleep?: Sleep,
): Promise<T | SlackReadError> {
  let throttledHere = false;
  try {
    const result = await withRateLimitBackoff(
      async () => {
        const page = await fetchPage();
        if (!page.ok && page.error === "ratelimited") {
          throttledHere = true;
          throw new ConnectorRateLimitError(
            `Slack is rate limiting ${context}`,
            page.retryAfterSeconds,
          );
        }
        return page;
      },
      { ...(sleep !== undefined ? { sleep } : {}) },
    );
    // Reached only by a page that did NOT end in `ratelimited`, so a true flag
    // here means "backed off, then got through".
    if (throttledHere) tally.throttled++;
    return result;
  } catch (err) {
    if (err instanceof ConnectorRateLimitError) {
      tally.exhausted++;
      log.warn(
        { context, retryAfterSeconds: err.retryAfterSeconds },
        "brain audience: Slack rate limit survived the bounded backoff — aborting this read rather than reconciling against a partial one",
      );
      return { ok: false, error: "ratelimited", retryAfterSeconds: err.retryAfterSeconds };
    }
    throw err;
  }
}

/** Scopes the directory read needs — new in #4801, so the likeliest failure. */
const DIRECTORY_SCOPES = "users:read / users:read.email";

/** Scopes the channel-visibility and roster reads need — long-held. */
const CHANNEL_SCOPES = "channels:read / groups:read";

/** Default cadence: every 30 minutes. */
export const DEFAULT_AUDIENCE_SYNC_INTERVAL_MS = 30 * 60_000;

/**
 * Is audience sync switched on for this scope?
 *
 * Called with no `workspaceId` it reads the PLATFORM value — the fiber's own
 * gate, so an operator can stop the cycle process-wide. Called with one it
 * reads the workspace override, which is the tenant's decision about whether
 * Atlas may resolve their Slack roster to accounts at all.
 *
 * Default ON: a workspace that has connected Slack, installed the history
 * source, and granted the scopes has already made every decision this would
 * re-ask, and leaving it off by default would mean private-channel ingest keeps
 * producing facts nobody can see — the exact failure #4801 exists to end.
 */
export function isAudienceSyncEnabled(workspaceId?: string): boolean {
  return getSettingAuto("ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED", workspaceId) !== "false";
}

/** Cadence knob, in ms. Non-positive / unparseable values fall back with a warn. */
export function getAudienceSyncIntervalMs(): number {
  const raw = getSettingAuto("ATLAS_BRAIN_AUDIENCE_SYNC_INTERVAL_MINUTES");
  if (raw === undefined || raw === "") return DEFAULT_AUDIENCE_SYNC_INTERVAL_MS;
  const minutes = Number.parseFloat(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    log.warn(
      { raw },
      "ATLAS_BRAIN_AUDIENCE_SYNC_INTERVAL_MINUTES is non-positive or unparseable — using the default",
    );
    return DEFAULT_AUDIENCE_SYNC_INTERVAL_MS;
  }
  return minutes * 60_000;
}

/**
 * Every enabled, non-archived Slack chat-history install.
 *
 * Deliberately mirrors `SYNC_CYCLE_INSTALLS_SQL`'s filter (`knowledge` pillar,
 * enabled, non-archived) so this cycle and the ingest cycle agree about which
 * installs should be syncing. NOTHING ENFORCES THAT AGREEMENT — it is a
 * hand-kept copy, not a shared constant; if you change that predicate, change
 * this one. Exported so the real-Postgres test runs this exact string against
 * the live schema.
 */
export const AUDIENCE_SYNC_INSTALLS_SQL = `SELECT workspace_id, install_id, config
         FROM workspace_plugins
        WHERE catalog_id = $1 AND pillar = 'knowledge'
          AND enabled = true AND status <> 'archived'
        ORDER BY workspace_id ASC, install_id ASC`;

interface InstallRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly install_id: string;
  readonly config: Record<string, unknown> | null;
}

/**
 * Per-cycle counters. Every arm is counted; nothing is a silent skip.
 *
 * `status` has three arms, not two. `failure` means the cycle did no work (the
 * install scan itself threw); `degraded` means it ran and something in it
 * failed. Collapsing degraded into `success` made the span self-contradictory —
 * `status: "success"` alongside `workspacesFailed: 3` — and left an operator
 * alerting on `status` unable to fire on the condition that matters here, which
 * is a workspace whose membership silently stopped being reconciled.
 */
export interface AudienceSyncCycleResult {
  readonly status: "success" | "degraded" | "failure";
  readonly workspacesInspected: number;
  readonly workspacesSkippedDisabled: number;
  readonly workspacesFailed: number;
  readonly audiencesReconciled: number;
  readonly audiencesSkippedPublic: number;
  readonly audiencesFailed: number;
  readonly membersAdded: number;
  readonly membersRevoked: number;
  readonly principalsUnresolved: number;
  /**
   * Paginated reads that hit a 429, backed off, and then SUCCEEDED (#4809).
   *
   * The point of separating this from {@link readsThrottleExhausted}: a cycle
   * that backed off and recovered is healthy — Slack throttled us and the
   * bounded retry absorbed it — while one that exhausted is the beginning of
   * "this workspace never reconciles". Before #4809 both looked identical from
   * the span, because there was no retry and every 429 was simply an abort.
   */
  readonly readsThrottled: number;
  /** Reads that exhausted the bounded retries and aborted their scope. */
  readonly readsThrottleExhausted: number;
  /**
   * Audiences whose membership has not been verified within the staleness
   * bound (#4808), across every workspace — `null` if the sweep itself failed.
   *
   * `null` rather than `0` on failure, deliberately: a sweep that could not run
   * must not report the all-clear that a healthy deployment reports.
   */
  readonly staleAudiences: number | null;
  /** Distinct workspaces holding at least one stale audience; `null` as above. */
  readonly staleWorkspaces: number | null;
  /**
   * Age of the LEAST recently verified audience in the deployment, in seconds.
   *
   * The number that turns "some roster read is failing" into "and it has been
   * failing for eleven days" — i.e. into a thing with a deadline, since past
   * the bound those grants stop being served.
   */
  readonly oldestVerifiedAgeSeconds: number | null;
  readonly error?: string;
}

const ZERO: Omit<AudienceSyncCycleResult, "status"> = {
  workspacesInspected: 0,
  workspacesSkippedDisabled: 0,
  workspacesFailed: 0,
  audiencesReconciled: 0,
  audiencesSkippedPublic: 0,
  audiencesFailed: 0,
  membersAdded: 0,
  membersRevoked: 0,
  principalsUnresolved: 0,
  readsThrottled: 0,
  readsThrottleExhausted: 0,
  staleAudiences: null,
  staleWorkspaces: null,
  oldestVerifiedAgeSeconds: null,
};

/**
 * The staleness sweep behind the span's `stale_*` attributes (#4808).
 *
 * `min(synced_at)` per audience is the conservative reading — an audience is as
 * verified as its least recently verified row — and matches what `acl.ts`'s
 * read-time bound tests, so the alert and the enforcement cannot disagree about
 * which audiences are stale.
 *
 * Deployment-wide rather than per-workspace: span attributes are scalars, and
 * `workspace_id` is unbounded cardinality. The counts say HOW MUCH and the log
 * line that follows names the worst offenders.
 *
 * Exported so the real-Postgres test runs this exact string against the live
 * schema — the aggregate shape is easy to get subtly wrong (a `WHERE` on
 * `synced_at` instead of a `HAVING` on the grouped minimum would silently
 * count rows rather than audiences).
 */
export const AUDIENCE_STALENESS_SQL = `
  WITH audience AS (
    SELECT workspace_id, audience_id, min(synced_at) AS verified_at
      FROM fact_audience_member
     GROUP BY workspace_id, audience_id
  )
  SELECT count(*)::int AS stale_audiences,
         count(DISTINCT workspace_id)::int AS stale_workspaces,
         COALESCE(EXTRACT(EPOCH FROM (now() - min(verified_at)))::bigint, 0) AS oldest_age_seconds
    FROM audience
   WHERE verified_at < now() - make_interval(secs => $1::double precision)`;

interface StalenessRow extends Record<string, unknown> {
  readonly stale_audiences: number;
  readonly stale_workspaces: number;
  readonly oldest_age_seconds: string | number;
}

/** What the staleness sweep found. All-`null` means it could not run. */
interface StalenessReport {
  readonly staleAudiences: number | null;
  readonly staleWorkspaces: number | null;
  readonly oldestVerifiedAgeSeconds: number | null;
}

const NO_STALENESS_REPORT: StalenessReport = {
  staleAudiences: null,
  staleWorkspaces: null,
  oldestVerifiedAgeSeconds: null,
};

/**
 * Count audiences past the staleness bound, for the span.
 *
 * Never throws: a failed sweep degrades the OBSERVABILITY of the cycle, and
 * failing the cycle over it would take the reconcile down with the dashboard.
 * It reports `null` instead — see {@link AudienceSyncCycleResult.staleAudiences}
 * for why not `0`.
 *
 * When enforcement is switched OFF (`ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`
 * = 0) the sweep falls back to the DEFAULT bound rather than reporting nothing.
 * An operator who disabled enforcement to survive an incident is precisely the
 * one who still needs to see how stale things are getting — losing the alert
 * along with the enforcement would leave them flying blind on the condition
 * they just chose to tolerate.
 */
async function sweepStaleness(
  query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
): Promise<StalenessReport> {
  const configured = getAudienceMaxStalenessSeconds();
  const boundSeconds = configured > 0 ? configured : DEFAULT_AUDIENCE_MAX_STALENESS_HOURS * 3600;
  try {
    const rows = await query<StalenessRow>(AUDIENCE_STALENESS_SQL, [boundSeconds]);
    const row = rows[0];
    if (row === undefined) return NO_STALENESS_REPORT;
    // The counts are VALIDATED, not trusted. An aggregate whose shape drifted
    // would otherwise put `undefined` on the span, which renders as "no data" —
    // indistinguishable from a healthy deployment, and hiding precisely the
    // number this sweep exists to show. `null` + a warn says "we do not know".
    if (typeof row.stale_audiences !== "number" || typeof row.stale_workspaces !== "number") {
      log.warn(
        { row },
        "brain audience: staleness sweep returned an unexpected row shape — its counters are unavailable",
      );
      return NO_STALENESS_REPORT;
    }
    // `count(*)` is `::int` so pg hands back a number, but `EXTRACT(...)::bigint`
    // comes back as a STRING (pg maps int8 to string to preserve precision).
    const oldest = Number(row.oldest_age_seconds);
    return {
      staleAudiences: row.stale_audiences,
      staleWorkspaces: row.stale_workspaces,
      oldestVerifiedAgeSeconds: Number.isFinite(oldest) ? oldest : null,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "brain audience: staleness sweep failed — the cycle ran, but its staleness counters are unavailable",
    );
    return NO_STALENESS_REPORT;
  }
}

/** The vendor surface one workspace's sync needs — injectable for tests. */
export interface AudienceSyncApi {
  readonly getConversationInfo: typeof getConversationInfo;
  readonly fetchConversationMembersPage: typeof fetchConversationMembersPage;
  readonly fetchUsersListPage: typeof fetchUsersListPage;
}

export interface AudienceSyncDeps {
  readonly api?: AudienceSyncApi;
  /**
   * Per-workspace enablement, injectable so the tenant opt-out is testable.
   *
   * It is a CONSENT decision ("may Atlas match our Slack members' emails to
   * Atlas accounts?"), which makes it the one gate here worth pinning against
   * an inverted predicate or a typo'd key — neither of which any other
   * assertion in this module would catch, since both fail in the permissive
   * direction and the cycle then reports success.
   */
  readonly isEnabled?: (workspaceId: string) => boolean;
  readonly query?: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
  readonly resolveToken?: (workspaceId: string) => Promise<string>;
  readonly reconcile?: typeof reconcileAudienceMembership;
  readonly resolve?: typeof resolvePrincipals;
  /** Test-only backoff sleep, so the #4809 retry tests do not actually wait. */
  readonly sleep?: Sleep;
}

/**
 * Human-readable, operator-actionable rendering of a Slack read failure.
 *
 * `scopes` names the pair THIS read needs, because `missing_scope` means
 * different things at the three call sites: the directory read wants
 * `users:read`/`users:read.email` (new in #4801), while the channel and roster
 * reads want `channels:read`/`groups:read` (long-held). A single hardcoded hint
 * would send an operator hitting a roster failure to re-consent for the wrong
 * pair and watch it not help.
 */
function describeSlackError(err: SlackReadError, scopes: string): string {
  switch (err.error) {
    case "missing_scope":
      return `the workspace's Slack token lacks ${scopes} — reconnect Slack under Admin → Integrations to grant them`;
    case "invalid_auth":
    case "token_revoked":
    case "account_inactive":
      return "the workspace's Slack credential is no longer valid — reconnect Slack under Admin → Integrations";
    case "ratelimited":
      return "Slack rate-limited the read — the next cycle retries";
    case "not_in_channel":
      return "the Atlas bot is not in this channel — re-invite it";
    case "channel_not_found":
      return "Slack does not recognise this channel id";
    case "malformed_members_page":
    case "malformed_users_page":
      // Named explicitly because the generic arm renders an opaque code for the
      // one failure class an operator most needs to read as a REFUSAL rather
      // than as a small result.
      return "Slack returned a structurally invalid page — refused rather than read as an empty result; see the slack.api log for the entry counts";
    default:
      return `Slack read failed (${err.error})`;
  }
}

/**
 * Read the workspace's whole Slack directory, or fail.
 *
 * Fails on ANY fault — including hitting the page cap, which is a truncation
 * and therefore indistinguishable from a directory that ends there. The caller
 * skips the workspace; see the module header for why a partial directory must
 * never reach resolution.
 *
 * NOTE what is and is not load-bearing here. The truncation/lossy-page arms are
 * the real protection — nothing downstream can reconstruct what they dropped.
 * The unresolvable-directory arm below is NOT: `syncInstall`'s workspace-level
 * collapse check catches the same inputs, because a directory nobody can be
 * resolved from resolves to nobody. It is kept as an EARLY exit with a precise
 * diagnostic (and one fewer DB round trip), not as the guard. Mutating it away
 * changes the log line, not the outcome — which is exactly what the tests
 * assert, via the resolve call count rather than a bare `workspacesFailed`.
 *
 * The failure arm carries the operator-actionable `reason` rather than only
 * logging it, so the workspace-failure line the caller emits is self-contained.
 * A bare `null` put "reconnect Slack to grant users:read.email" and "Slack
 * directory unavailable" on two lines an operator had to correlate by hand.
 */
type DirectoryResult =
  | { readonly ok: true; readonly directory: Map<string, SlackDirectoryUser> }
  | { readonly ok: false; readonly reason: string };

async function loadDirectory(
  api: AudienceSyncApi,
  token: string,
  workspaceId: string,
  tally: ThrottleTally,
  sleep?: Sleep,
): Promise<DirectoryResult> {
  const byId = new Map<string, SlackDirectoryUser>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page++) {
    const result = await readPageWithBackoff(
      () =>
        api.fetchUsersListPage(token, {
          limit: PAGE_LIMIT,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      `the Slack directory for workspace ${workspaceId}`,
      tally,
      sleep,
    );
    if (!result.ok) {
      const reason = describeSlackError(result, DIRECTORY_SCOPES);
      log.warn(
        { workspaceId, reason },
        "brain audience: could not read the Slack directory — skipping this workspace, membership unchanged",
      );
      return { ok: false, reason };
    }
    // An entry Slack sent that Atlas could not identify is a roster member it
    // will fail to resolve — and an unresolved member is REVOKED. So a lossy
    // page is a read fault, exactly as a lossy roster page is, rather than a
    // smaller directory.
    if (result.dropped > 0) {
      log.warn(
        { workspaceId, dropped: result.dropped },
        "brain audience: Slack directory page had entries with no usable identity — skipping this workspace rather than revoking the members it could not identify",
      );
      return { ok: false, reason: "Slack returned directory entries Atlas could not identify" };
    }
    for (const user of result.users) byId.set(user.id, user);
    if (result.nextCursor === null) {
      // A directory with no LIVE HUMANS in it is not a workspace nobody works
      // at — it is a read that returned nothing resolution can use, and it is
      // the most dangerous shape in this module: every roster member misses the
      // lookup, resolves to nobody, and the reconcile deletes every audience
      // while the cycle reports success.
      //
      // Keyed on `liveHumans`, NOT on `byId.size`, and that distinction is the
      // whole finding. A size check passes a directory of only bots and
      // deactivated accounts — which is the same catastrophe, reachable from
      // any drift in the `deleted`/`is_bot` mapping in `slack/api.ts`. Checked
      // BEFORE the email tripwire, which cannot fire on an empty set.
      // ONE condition, TWO diagnostics: no directory member can be resolved,
      // either because there are no live humans in it or because none of them
      // carries an address.
      //
      // Both are read failures, and the fused test is deliberate. Written as
      // two sequential guards, the emptiness arm is dead — `[].every(…)` is
      // vacuously true, so the email arm already catches it — and a dead guard
      // that looks load-bearing is worse than none: the next person to touch
      // this reads a protection that isn't there. What the split genuinely buys
      // is the MESSAGE, so that is all it decides.
      //
      // Why either shape is a fault rather than a small directory: every roster
      // member then misses the lookup, resolves to nobody, and the reconcile
      // deletes every audience in the workspace while the cycle reports
      // success. The all-null-email case is a `users:read` token WITHOUT
      // `users:read.email` — Slack returns 200 with the field simply absent,
      // a scope problem wearing the costume of an empty result. The no-humans
      // case is reachable from any drift in the `deleted`/`is_bot` mapping in
      // `slack/api.ts`.
      //
      // Computed over `liveHumans` — the population resolution CONSUMES — so
      // one app user's address cannot mask an otherwise email-less directory.
      const humans = liveHumans(byId);
      if (humans.length === 0 || humans.every((u) => u.email === null)) {
        const reason =
          humans.length === 0
            ? "Slack returned a directory with no live human members"
            : `the workspace's Slack token lacks ${DIRECTORY_SCOPES} — reconnect Slack under Admin → Integrations`;
        log.warn(
          { workspaceId, directorySize: byId.size, humans: humans.length },
          `brain audience: no directory member can be resolved (${reason}) — treating as a read failure. Skipping this workspace, membership unchanged`,
        );
        return { ok: false, reason };
      }
      return { ok: true, directory: byId };
    }
    cursor = result.nextCursor;
  }
  log.warn(
    { workspaceId, pages: MAX_DIRECTORY_PAGES, directorySize: byId.size },
    "brain audience: Slack directory exceeded the page cap — skipping this workspace rather than resolving against a partial directory",
  );
  return { ok: false, reason: `the Slack directory exceeded ${MAX_DIRECTORY_PAGES} pages` };
}

/**
 * Read one channel's full roster, or fail. `null` means "do not reconcile this
 * audience" — never "the channel is empty".
 */
async function loadRoster(
  api: AudienceSyncApi,
  token: string,
  workspaceId: string,
  channelId: string,
  tally: ThrottleTally,
  sleep?: Sleep,
): Promise<string[] | null> {
  const memberIds: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ROSTER_PAGES; page++) {
    const result = await readPageWithBackoff(
      () =>
        api.fetchConversationMembersPage(token, {
          channel: channelId,
          limit: PAGE_LIMIT,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      `the roster of channel ${channelId}`,
      tally,
      sleep,
    );
    if (!result.ok) {
      log.warn(
        { workspaceId, channelId, reason: describeSlackError(result, CHANNEL_SCOPES) },
        "brain audience: could not read the channel roster — skipping this audience, membership unchanged",
      );
      return null;
    }
    memberIds.push(...result.memberIds);
    if (result.nextCursor === null) return memberIds;
    cursor = result.nextCursor;
  }
  log.warn(
    { workspaceId, channelId, pages: MAX_ROSTER_PAGES, fetched: memberIds.length },
    "brain audience: channel roster exceeded the page cap — skipping this audience rather than revoking the members it did not read",
  );
  return null;
}

/**
 * What this channel's grant says there is to sync.
 *
 * A discriminated union rather than a nullable id, so the caller's two counters
 * (`audiencesSkippedPublic` vs `audiencesFailed`) are exhaustive by
 * construction instead of by remembering to branch in the right order.
 */
type ChannelAudience =
  | { readonly kind: "audience"; readonly audienceId: string }
  | { readonly kind: "public" }
  | { readonly kind: "blocked" };

/**
 * Resolve what to sync for one channel, THROUGH the production grant deriver.
 *
 * The visibility bit is passed in from `conversations.info` — the same value
 * `slack/client.ts` hands `deriveChatChannelGrant` at ingest — rather than
 * being re-decided here. That is what makes the module header's claim literally
 * true: this module makes NO visibility judgement of its own, so a new arm in
 * `deriveChatChannelGrant` (a Slack Connect channel, a "private but
 * org-readable" case, a vendor whose `isPrivate` is conditional) changes what
 * the sync does without an edit here. An earlier cut passed `isPrivate: true`
 * literally and filtered public channels in the caller — which worked, and
 * quietly duplicated the one decision this module is supposed to delegate.
 *
 * `public` means the grant is `[org]`: everyone can read it at the source, so
 * there is no audience and nothing to reconcile. `blocked` means derivation
 * refused (a blank source or channel id) or produced no audience principal —
 * a fault, counted as one.
 */
function resolveChannelAudience(visibility: ChatChannelVisibility): ChannelAudience {
  const grant = deriveChatChannelGrant(visibility);
  if (grant === null) return { kind: "blocked" };
  const parsed = parseGrant(grant).principals;
  const audience = parsed.find((p) => p.kind === "audience");
  if (audience !== undefined) return { kind: "audience", audienceId: audience.audienceId };
  // No audience principal. `[org]` is the expected shape here and means public;
  // anything else parsed to principals but named no audience, which is a
  // derivation fault rather than a public channel and must not be counted as
  // one — miscounting it would report a leak-shaped bug as a routine skip.
  return parsed.some((p) => p.kind === "org") ? { kind: "public" } : { kind: "blocked" };
}

interface WorkspaceOutcome {
  readonly audiencesReconciled: number;
  readonly audiencesSkippedPublic: number;
  readonly audiencesFailed: number;
  readonly membersAdded: number;
  readonly membersRevoked: number;
  readonly principalsUnresolved: number;
}

const ZERO_WORKSPACE: WorkspaceOutcome = {
  audiencesReconciled: 0,
  audiencesSkippedPublic: 0,
  audiencesFailed: 0,
  membersAdded: 0,
  membersRevoked: 0,
  principalsUnresolved: 0,
};

/**
 * Sync every private channel on one install. Throws only on a fault that makes
 * the whole install unworkable (no Slack connection, unusable config); per-
 * channel faults are isolated and counted.
 */
async function syncInstall(
  row: InstallRow,
  deps: Required<Pick<AudienceSyncDeps, "api" | "resolveToken" | "reconcile" | "resolve">> & {
    readonly sleep?: Sleep;
  },
  tally: ThrottleTally,
): Promise<WorkspaceOutcome> {
  const workspaceId = row.workspace_id;
  const parsed = parseSlackHistoryConfig(row.config);
  if (!parsed.ok) {
    // The ingest cycle surfaces this same condition per sync; here it means the
    // install has no channel scope to sync membership for. Counted as a
    // workspace failure by the caller, never as "zero channels, all good".
    throw new Error(parsed.error);
  }

  const token = await deps.resolveToken(workspaceId);
  const loaded = await loadDirectory(deps.api, token, workspaceId, tally, deps.sleep);
  if (!loaded.ok) throw new Error(`Slack directory unavailable — ${loaded.reason}`);
  const directory = loaded.directory;

  // Resolve the WHOLE directory once, then intersect each roster against the
  // result. Two reasons, and the second is the load-bearing one:
  //
  //   1. Cost. The directory is workspace-scoped, so a per-channel resolve
  //      would re-run the same query once per configured channel for identical
  //      data.
  //   2. RESOLUTION COLLAPSE IS A WORKSPACE-LEVEL CONDITION, and can only be
  //      detected at workspace level. A per-audience check ("nobody in this
  //      channel resolved") cannot tell the failure from the legitimate case
  //      where the last Atlas user simply left a channel — and blocking THAT
  //      would preserve exactly the stale access this subsystem exists to
  //      drop. Whereas if not one person in the entire directory resolves,
  //      that is not an org that stopped using Atlas; it is a verified SSO
  //      domain of `acme.com` against emails at `eng.acme.com`, a domain row
  //      stored as `@acme.com`, or an SSO provider added AFTER membership was
  //      populated — an unrelated admin action that would otherwise revoke
  //      every audience in the workspace on the next cycle.
  // `liveHumans` is non-empty by `loadDirectory`'s contract — it refuses a
  // directory without one — so the collapse check below needs no emptiness
  // guard of its own. That was the bug in the first cut: guarding it on
  // `humans.length > 0` made a bot-only directory skip the check entirely.
  const humans = liveHumans(directory);
  const resolution = await deps.resolve(
    workspaceId,
    humans.map((u) => ({ id: u.id, email: u.email })),
  );
  if (resolution.resolved.size === 0) {
    throw new Error(
      "no Slack workspace member resolved to an Atlas user — check the workspace's verified SSO domain against member email domains, or invite these people to Atlas",
    );
  }

  let out = { ...ZERO_WORKSPACE };
  for (const channelId of parsed.channels) {
    try {
      const info = await deps.api.getConversationInfo(token, channelId);
      if (!info.ok) {
        log.warn(
          { workspaceId, channelId, reason: describeSlackError(info, CHANNEL_SCOPES) },
          "brain audience: could not read channel visibility — skipping this audience, membership unchanged",
        );
        out = { ...out, audiencesFailed: out.audiencesFailed + 1 };
        continue;
      }
      // The visibility bit goes to the GRANT DERIVER, which decides. This
      // module never branches on `isPrivate` itself — see
      // `resolveChannelAudience`.
      const target = resolveChannelAudience({
        source: SLACK_HISTORY_SOURCE,
        channelId,
        isPrivate: info.channel.isPrivate,
      });
      if (target.kind === "public") {
        // Counted rather than silently passed over, so "12 channels, 0
        // audiences" reads as "they are all public" instead of as a broken
        // cycle.
        out = { ...out, audiencesSkippedPublic: out.audiencesSkippedPublic + 1 };
        continue;
      }
      if (target.kind === "blocked") {
        log.warn(
          { workspaceId, channelId },
          "brain audience: grant derivation yielded no audience for this channel — skipping, membership unchanged",
        );
        out = { ...out, audiencesFailed: out.audiencesFailed + 1 };
        continue;
      }
      const audienceId = target.audienceId;

      const roster = await loadRoster(
        deps.api,
        token,
        workspaceId,
        channelId,
        tally,
        deps.sleep,
      );
      if (roster === null) {
        out = { ...out, audiencesFailed: out.audiencesFailed + 1 };
        continue;
      }

      // Intersect the roster with the workspace-wide resolution.
      //
      // Bots and deactivated accounts never become audience members: a bot has
      // no Atlas account to resolve to, and a deactivated Slack user is someone
      // the workspace has already revoked at the source — carrying them into
      // the audience would make Atlas the one system that kept their access.
      // Both are absent from `resolution` by construction (they were filtered
      // out of the directory before it was resolved), so the miss below covers
      // them, and `unresolvedInChannel` deliberately does NOT count them: a bot
      // is not an unresolved person, and counting it would inflate the metric
      // in every channel Atlas is invited to.
      const userIds: string[] = [];
      let unresolvedInChannel = 0;
      for (const memberId of roster) {
        const resolvedUserId = resolution.resolved.get(memberId);
        if (resolvedUserId !== undefined) {
          userIds.push(resolvedUserId);
          continue;
        }
        const known = directory.get(memberId);
        // `isLiveHuman`, not an inverted copy of it — one definition, per this
        // module's own argument about duplicated derivations. Drift here could
        // not revoke anyone (membership comes entirely from `resolution`), but
        // it would silently miscount `principalsUnresolved`.
        if (known !== undefined && !isLiveHuman(known)) continue;
        // Either a live human with no Atlas account, or a member absent from
        // the directory entirely — a Slack Connect guest from another
        // workspace, or a race between the two reads. Counted, never guessed.
        unresolvedInChannel++;
      }

      const changed = await deps.reconcile({
        workspaceId,
        audienceId,
        source: SLACK_HISTORY_SOURCE,
        userIds,
      });
      out = {
        ...out,
        audiencesReconciled: out.audiencesReconciled + 1,
        membersAdded: out.membersAdded + changed.added,
        membersRevoked: out.membersRevoked + changed.revoked,
        principalsUnresolved: out.principalsUnresolved + unresolvedInChannel,
      };
    } catch (err) {
      log.warn(
        { workspaceId, channelId, err: err instanceof Error ? err.message : String(err) },
        "brain audience: audience sync failed — membership unchanged, retrying next cycle",
      );
      out = { ...out, audiencesFailed: out.audiencesFailed + 1 };
    }
  }
  return out;
}

/**
 * Run one audience-membership sync cycle. Never throws: a scan failure is
 * `status: "failure"`, per-workspace failures are isolated and counted.
 */
export async function runAudienceSyncCycle(
  deps: AudienceSyncDeps = {},
): Promise<AudienceSyncCycleResult> {
  if (!hasInternalDB()) return { status: "success", ...ZERO };

  const query = deps.query ?? internalQuery;
  const resolved = {
    api: deps.api ?? {
      getConversationInfo,
      fetchConversationMembersPage,
      fetchUsersListPage,
    },
    resolveToken:
      deps.resolveToken ??
      ((workspaceId: string) =>
        resolveSlackHistoryToken({ getInstallationByOrg, getBotToken }, workspaceId)),
    reconcile: deps.reconcile ?? reconcileAudienceMembership,
    resolve: deps.resolve ?? resolvePrincipals,
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
  };
  // One tally for the whole cycle — see {@link ThrottleTally} for why it is not
  // owned by `syncInstall`, whose frame dies on an exhausted directory read.
  const tally: ThrottleTally = { throttled: 0, exhausted: 0 };
  const isEnabled = deps.isEnabled ?? isAudienceSyncEnabled;

  let installs: InstallRow[];
  try {
    installs = await query<InstallRow>(AUDIENCE_SYNC_INSTALLS_SQL, [SLACK_HISTORY_CATALOG_ID]);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err: error }, "brain audience: install scan failed — no membership was reconciled");
    return { status: "failure", ...ZERO, error };
  }

  let result = { ...ZERO };
  for (const row of installs) {
    if (!isEnabled(row.workspace_id)) {
      result = { ...result, workspacesSkippedDisabled: result.workspacesSkippedDisabled + 1 };
      continue;
    }
    result = { ...result, workspacesInspected: result.workspacesInspected + 1 };
    try {
      const out = await syncInstall(row, resolved, tally);
      result = {
        ...result,
        audiencesReconciled: result.audiencesReconciled + out.audiencesReconciled,
        audiencesSkippedPublic: result.audiencesSkippedPublic + out.audiencesSkippedPublic,
        audiencesFailed: result.audiencesFailed + out.audiencesFailed,
        membersAdded: result.membersAdded + out.membersAdded,
        membersRevoked: result.membersRevoked + out.membersRevoked,
        principalsUnresolved: result.principalsUnresolved + out.principalsUnresolved,
      };
    } catch (err) {
      log.warn(
        {
          workspaceId: row.workspace_id,
          installId: row.install_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "brain audience: workspace sync failed — membership unchanged, retrying next cycle",
      );
      result = { ...result, workspacesFailed: result.workspacesFailed + 1 };
    }
  }

  // Swept unconditionally, including when there are no installs left to sync.
  // An install that was disabled or archived stops being reconciled but its
  // membership rows stay — and stay stale — so "no installs" is one of the ways
  // an audience quietly ages past the bound. A sweep gated on `installs.length`
  // would go silent in exactly that case.
  const staleness = await sweepStaleness(query);
  result = {
    ...result,
    readsThrottled: tally.throttled,
    readsThrottleExhausted: tally.exhausted,
    ...staleness,
  };

  if (installs.length > 0) {
    log.info({ ...result }, "brain audience: membership sync cycle complete");
  }
  if (staleness.staleAudiences !== null && staleness.staleAudiences > 0) {
    log.warn(
      { ...staleness, maxStalenessSeconds: getAudienceMaxStalenessSeconds() },
      "brain audience: audiences past the staleness bound — their grants are being suppressed at read time until a sync succeeds. Look for a failing roster read or a disabled install in these workspaces",
    );
  }
  // `status` stays a statement about THIS CYCLE's work, so staleness does not
  // feed it: an audience left behind by an install someone archived last month
  // is a real condition to alert on, but it is not this cycle failing at
  // anything, and folding it in would make `degraded` permanent and therefore
  // ignorable. It gets its own counters and its own log line instead.
  const degraded = result.workspacesFailed > 0 || result.audiencesFailed > 0;
  return { status: degraded ? "degraded" : "success", ...result };
}
