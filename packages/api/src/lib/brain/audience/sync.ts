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
 * ## Why the audience id comes from the GRANT, not from a second derivation
 *
 * The cycle calls `deriveChatChannelGrant` with the same visibility the ingest
 * client passes, then reads the audience id out of `parseGrant`. It does NOT
 * call `chatChannelAudienceId` itself.
 *
 * That is the difference between a sync that populates *an* audience and one
 * that populates *the audience the facts were granted to*. Two independent
 * derivations of the same id agree until one of them changes — a namespace
 * edit, a new visibility arm, a vendor whose "private" is conditional — and on
 * that day the sync writes membership for an audience no fact names, so every
 * private fact silently returns to invisible while the cycle reports success.
 * Deriving through the grant makes the two unable to disagree: whatever
 * `deriveChatChannelGrant` decides is what gets synced, including its `null`
 * (block) and its `[org]` (public → no audience → nothing to sync).
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
import { deriveChatChannelGrant } from "@atlas/api/lib/brain/ingest/grant";
import {
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_SOURCE,
  parseSlackHistoryConfig,
} from "@atlas/api/lib/brain/ingest/slack/config";
import { resolveSlackHistoryToken } from "@atlas/api/lib/brain/ingest/slack/connector";
import { reconcileAudienceMembership } from "./membership";
import { resolvePrincipals, type SourcePrincipal } from "./resolver";

const log = createLogger("brain.audience.sync");

/** Slack's recommended page size for both paginated reads. */
const PAGE_LIMIT = 200;

/** Hard bound on directory pages per workspace per cycle (~40k users). */
export const MAX_DIRECTORY_PAGES = 200;

/** Hard bound on roster pages per channel per cycle (~40k members). */
export const MAX_ROSTER_PAGES = 200;

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
 * Mirrors `SYNC_CYCLE_INSTALLS_SQL`'s filter (`knowledge` pillar, enabled,
 * non-archived) so this cycle's idea of "an install that should be syncing"
 * cannot drift from the ingest cycle's. Exported for the real-Postgres test.
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

/** Human-readable, operator-actionable rendering of a Slack read failure. */
function describeSlackError(err: SlackReadError): string {
  switch (err.error) {
    case "missing_scope":
      return "the workspace's Slack token lacks users:read / users:read.email — reconnect Slack under Admin → Integrations to grant them";
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
        { workspaceId, reason: describeSlackError(result) },
        "brain audience: could not read the Slack directory — skipping this workspace, membership unchanged",
      );
      return null;
    }
    for (const user of result.users) byId.set(user.id, user);
    if (result.nextCursor === null) {
      // A token with `users:read` but NOT `users:read.email` returns 200 with
      // every email absent. That is a scope problem wearing the costume of an
      // empty result: resolution would match nobody, the reconcile would revoke
      // every audience, and the cycle would report success. Detected here, and
      // treated as a read failure rather than as a directory of nulls.
      const withEmail = [...byId.values()].filter((u) => u.email !== null).length;
      if (byId.size > 0 && withEmail === 0) {
        log.warn(
          { workspaceId, directorySize: byId.size },
          "brain audience: Slack returned a directory with no email on any member — the token is missing users:read.email; reconnect Slack under Admin → Integrations. Skipping this workspace, membership unchanged",
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
        { workspaceId, channelId, reason: describeSlackError(result) },
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
 * The audience id this channel's facts are actually granted to, or `null` when
 * there is nothing to sync.
 *
 * `null` covers two different, both-correct cases: a PUBLIC channel (the grant
 * is `[org]`, which needs no membership) and a channel whose grant derivation
 * blocked. They are distinguished by the caller for counting, via `isPrivate`.
 */
function audienceIdForChannel(channelId: string): string | null {
  const grant = deriveChatChannelGrant({
    source: SLACK_HISTORY_SOURCE,
    channelId,
    isPrivate: true,
  });
  if (grant === null) return null;
  const audience = parseGrant(grant).principals.find((p) => p.kind === "audience");
  return audience?.audienceId ?? null;
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

  let out = { ...ZERO_WORKSPACE };
  for (const channelId of parsed.channels) {
    try {
      const info = await deps.api.getConversationInfo(token, channelId);
      if (!info.ok) {
        log.warn(
          { workspaceId, channelId, reason: describeSlackError(info) },
          "brain audience: could not read channel visibility — skipping this audience, membership unchanged",
        );
        out = { ...out, audiencesFailed: out.audiencesFailed + 1 };
        continue;
      }
      // A public channel's grant is `[org]`: everyone in the workspace can read
      // it at the source, so there is no audience and nothing to reconcile.
      // Counted rather than silently passed over, so "12 channels, 0 audiences"
      // reads as "they are all public" instead of as a broken cycle.
      if (!info.channel.isPrivate) {
        out = { ...out, audiencesSkippedPublic: out.audiencesSkippedPublic + 1 };
        continue;
      }

      const audienceId = audienceIdForChannel(channelId);
      if (audienceId === null) {
        log.warn(
          { workspaceId, channelId },
          "brain audience: grant derivation yielded no audience for a private channel — skipping, membership unchanged",
        );
        out = { ...out, audiencesFailed: out.audiencesFailed + 1 };
        continue;
      }

      const roster = await loadRoster(deps.api, token, workspaceId, channelId);
      if (roster === null) {
        out = { ...out, audiencesFailed: out.audiencesFailed + 1 };
        continue;
      }

      // Bots and deactivated accounts never become audience members. A bot has
      // no Atlas account to resolve to, and a deactivated Slack user is someone
      // the workspace has already revoked at the source — carrying them into
      // the audience would make Atlas the one system that kept their access.
      const principals: SourcePrincipal[] = [];
      for (const memberId of roster) {
        const user = directory.get(memberId);
        if (user === undefined) {
          // In the roster but not the directory: a shared-channel member from
          // another Slack workspace, or a race between the two reads. Not
          // resolvable, and counted with the rest by `resolvePrincipals`.
          principals.push({ id: memberId, email: null });
          continue;
        }
        if (user.deleted || user.isBot) continue;
        principals.push({ id: user.id, email: user.email });
      }

      const resolution = await deps.resolve(workspaceId, principals);
      const changed = await deps.reconcile({
        workspaceId,
        audienceId,
        source: SLACK_HISTORY_SOURCE,
        userIds: [...resolution.resolved.values()],
      });
      out = {
        ...out,
        audiencesReconciled: out.audiencesReconciled + 1,
        membersAdded: out.membersAdded + changed.added,
        membersRevoked: out.membersRevoked + changed.revoked,
        principalsUnresolved: out.principalsUnresolved + resolution.unresolvedCount,
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
