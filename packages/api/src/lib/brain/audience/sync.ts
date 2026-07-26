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
import { getBotToken, getInstallationByOrg } from "@atlas/api/lib/slack/store";
import { parseGrant } from "@atlas/api/lib/brain/acl";
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

/** Per-cycle counters. Every arm is counted; nothing is a silent skip. */
export interface AudienceSyncCycleResult {
  readonly status: "success" | "failure";
  readonly workspacesInspected: number;
  readonly workspacesSkippedDisabled: number;
  readonly workspacesFailed: number;
  readonly audiencesReconciled: number;
  readonly audiencesSkippedPublic: number;
  readonly audiencesFailed: number;
  readonly membersAdded: number;
  readonly membersRevoked: number;
  readonly principalsUnresolved: number;
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
};

/** The vendor surface one workspace's sync needs — injectable for tests. */
export interface AudienceSyncApi {
  readonly getConversationInfo: typeof getConversationInfo;
  readonly fetchConversationMembersPage: typeof fetchConversationMembersPage;
  readonly fetchUsersListPage: typeof fetchUsersListPage;
}

export interface AudienceSyncDeps {
  readonly api?: AudienceSyncApi;
  readonly query?: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
  readonly resolveToken?: (workspaceId: string) => Promise<string>;
  readonly reconcile?: typeof reconcileAudienceMembership;
  readonly resolve?: typeof resolvePrincipals;
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
    default:
      return `Slack read failed (${err.error})`;
  }
}

/**
 * Read the workspace's whole Slack directory, or fail.
 *
 * Returns `null` on ANY fault — including hitting the page cap, which is a
 * truncation and therefore indistinguishable from a directory that ends there.
 * The caller skips the workspace; see the module header for why a partial
 * directory must never reach resolution.
 */
async function loadDirectory(
  api: AudienceSyncApi,
  token: string,
  workspaceId: string,
): Promise<Map<string, SlackDirectoryUser> | null> {
  const byId = new Map<string, SlackDirectoryUser>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page++) {
    const result = await api.fetchUsersListPage(token, {
      limit: PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!result.ok) {
      log.warn(
        { workspaceId, reason: describeSlackError(result, DIRECTORY_SCOPES) },
        "brain audience: could not read the Slack directory — skipping this workspace, membership unchanged",
      );
      return null;
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
      return null;
    }
    for (const user of result.users) byId.set(user.id, user);
    if (result.nextCursor === null) {
      // An EMPTY directory is not a workspace with no people — it is a read
      // that returned nothing usable, and it is the most dangerous shape in
      // this module: every roster member misses the lookup, resolves to
      // nobody, and the reconcile deletes the entire audience while the cycle
      // reports success. Checked BEFORE the email tripwire below, which cannot
      // fire on an empty set.
      if (byId.size === 0) {
        log.warn(
          { workspaceId },
          "brain audience: Slack returned an empty directory — treating as a read failure, not as a workspace with no members. Skipping this workspace, membership unchanged",
        );
        return null;
      }
      // A token with `users:read` but NOT `users:read.email` returns 200 with
      // every email absent. That is a scope problem wearing the costume of an
      // empty result: resolution would match nobody, the reconcile would revoke
      // every audience, and the cycle would report success. Detected here, and
      // treated as a read failure rather than as a directory of nulls.
      //
      // Computed over the population resolution actually CONSUMES — bots and
      // deactivated accounts are discarded before resolution, so counting them
      // would let one app user's address mask an otherwise email-less
      // directory and wave the mass revocation through.
      const humans = [...byId.values()].filter((u) => !u.deleted && !u.isBot);
      if (humans.length > 0 && humans.every((u) => u.email === null)) {
        log.warn(
          { workspaceId, directorySize: byId.size, humans: humans.length },
          "brain audience: Slack returned a directory with no email on any active member — the token is missing users:read.email; reconnect Slack under Admin → Integrations. Skipping this workspace, membership unchanged",
        );
        return null;
      }
      return byId;
    }
    cursor = result.nextCursor;
  }
  log.warn(
    { workspaceId, pages: MAX_DIRECTORY_PAGES, directorySize: byId.size },
    "brain audience: Slack directory exceeded the page cap — skipping this workspace rather than resolving against a partial directory",
  );
  return null;
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
): Promise<string[] | null> {
  const memberIds: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ROSTER_PAGES; page++) {
    const result = await api.fetchConversationMembersPage(token, {
      channel: channelId,
      limit: PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });
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
  deps: Required<Pick<AudienceSyncDeps, "api" | "resolveToken" | "reconcile" | "resolve">>,
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
  const directory = await loadDirectory(deps.api, token, workspaceId);
  if (directory === null) throw new Error("Slack directory unavailable");

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
  const humans = [...directory.values()].filter((u) => !u.deleted && !u.isBot);
  const resolution = await deps.resolve(
    workspaceId,
    humans.map((u) => ({ id: u.id, email: u.email })),
  );
  if (humans.length > 0 && resolution.resolved.size === 0) {
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

      const roster = await loadRoster(deps.api, token, workspaceId, channelId);
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
        if (known !== undefined && (known.deleted || known.isBot)) continue;
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
  };

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
    if (!isAudienceSyncEnabled(row.workspace_id)) {
      result = { ...result, workspacesSkippedDisabled: result.workspacesSkippedDisabled + 1 };
      continue;
    }
    result = { ...result, workspacesInspected: result.workspacesInspected + 1 };
    try {
      const out = await syncInstall(row, resolved);
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

  if (installs.length > 0) {
    log.info({ ...result }, "brain audience: membership sync cycle complete");
  }
  return { status: "success", ...result };
}
