/**
 * The Slack chat-history {@link BrainSourceConnector} (#4770, ADR-0036
 * §Ingestion & connectors; retired its second install in #5203) — the adapter
 * the shared sync cycle dispatches on. It owns only the factory contract:
 * resolve the workspace's ingest scope + its EXISTING Slack OAuth install into
 * a vendor client. Scheduling, backoff, caps, and the episode ingest are
 * elsewhere.
 *
 * ## Credentials: reuse, never register — and #5203 is where that led
 *
 * This follows ADR-0030's amendment #4397 (Salesforce Knowledge) exactly: no
 * `knowledge_sync_credentials` row, no new secret path, no new OAuth app.
 * `createClient` resolves the workspace's Slack bot token from the same
 * `chat_cache` install the chat adapter uses (`lib/slack/store.ts`), so
 * "Slack is live" — which is true of the chat ADAPTER — is what makes this
 * connector runnable at all. Disconnecting Slack breaks this source's sync,
 * surfaced per cycle as an actionable error outcome, never a silent no-op.
 *
 * ⚠️ That reuse is exactly why the source's own install had to go. An install
 * that establishes no connection can only carry configuration — and #4770's did
 * carry only a channel list — so it was a second act with no credential behind
 * it, which nobody performed. Scope now comes from the bot's channel membership
 * (`scope.ts`) and dispatch from the chat install itself.
 *
 * Token resolution is DB-only, per CLAUDE.md's per-tenant credential rule: the
 * store's `SLACK_BOT_TOKEN` env fallback is for single-workspace deploys with
 * no internal DB, and this connector cannot run without an internal DB anyway
 * (the episodes it writes live there).
 *
 * ## Scopes are a STAGING-FIRST change
 *
 * Reading history needs `channels:history` (public) and `groups:history`
 * (private) on top of the scopes the chat adapter already requested. #4770 adds
 * both to `SLACK_SCOPES` in `slack-oauth-handler.ts` — that string IS the OAuth
 * `scope=` param, so without the edit no reconnect could ever grant them and
 * the source would be uninstallable everywhere.
 *
 * Per CLAUDE.md's operational rule the matching Slack APP MANIFEST change lands
 * on STAGING first and soaks there; until an app's manifest carries the scopes,
 * Slack refuses the consent screen for the whole install, not just this source.
 * A workspace whose token predates them fails `missing_scope` — surfaced at
 * install as a field error and at sync time as "reconnect Slack to grant them",
 * and reconnecting is what actually grants them. See
 * `docs/development/brain-slack-history.md`.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  getBotToken,
  getInstallationByOrg,
  listSlackInstalledOrgIds,
} from "@atlas/api/lib/slack/store";
import { createSlackHistoryClient } from "./client";
import { SLACK_HISTORY_CATALOG_ID, SLACK_HISTORY_SOURCE } from "./config";
import {
  SLACK_EPISODE_SYNC_ID,
  refreshSlackIngestScope,
  resolveSlackPollScope,
} from "./scope";
import {
  getBrainSourceConnector,
  registerBrainSourceConnector,
  type BrainSourceConnector,
  type BrainSourceInstallContext,
  type BrainSourceVendorClient,
} from "../types";

const log = createLogger("brain.ingest.slack.connector");

/** Default backfill window for a channel with no stored mark: one week. */
export const DEFAULT_CHAT_BACKFILL_DAYS = 7;

/**
 * How far back a never-synced channel reads (ms), from the settings-registry
 * knob `ATLAS_BRAIN_CHAT_BACKFILL_DAYS`.
 *
 * A knob rather than a constant because it is the operator's lever when a first
 * sync reports that a channel has more history than one cycle can read — the
 * truncation warning names it. Fractional days are legal (soak-testing);
 * non-positive / unparseable values fall back to the default WITH A WARN rather
 * than backfilling nothing, because a zero window would produce a sync that
 * succeeds, finds no history, and reports itself green forever.
 */
export function getChatBackfillWindowMs(): number {
  const raw = getSettingAuto("ATLAS_BRAIN_CHAT_BACKFILL_DAYS");
  if (raw === undefined || raw === "") return DEFAULT_CHAT_BACKFILL_DAYS * 86_400_000;
  const days = Number.parseFloat(raw);
  if (!Number.isFinite(days) || days <= 0) {
    log.warn(
      { raw },
      "ATLAS_BRAIN_CHAT_BACKFILL_DAYS is non-positive or unparseable — using the default",
    );
    return DEFAULT_CHAT_BACKFILL_DAYS * 86_400_000;
  }
  return days * 86_400_000;
}

/** The store slice the connector needs — injectable for tests. */
export interface SlackInstallationReader {
  getInstallationByOrg: typeof getInstallationByOrg;
  getBotToken: typeof getBotToken;
}

/**
 * Resolve the workspace's Slack bot token, mapping absence to an actionable,
 * admin-facing error (it lands in the sync state row). Exported so the install
 * handler runs the SAME resolution as its loud pre-write verification —
 * install-time and sync-time must not be able to disagree about whether Slack
 * is connected.
 */
export async function resolveSlackHistoryToken(
  store: SlackInstallationReader,
  workspaceId: string,
): Promise<string> {
  const installation = await store.getInstallationByOrg(workspaceId);
  if (installation === null) {
    throw new Error(
      "This workspace has no Slack connection — connect Slack under Admin → Integrations, then sync again.",
    );
  }
  const token = await store.getBotToken(installation.team_id);
  if (token === null || token === "") {
    // Reached when the ORG lookup found an install but the per-team lookup no
    // longer resolves a token — the row was removed or expired between the two
    // reads, or the stored token decrypts to empty. (An undecryptable row is
    // hidden from BOTH lookups by `decryptOrHide`, so it surfaces as the
    // no-connection arm above, not here.) Re-running the OAuth flow is the
    // repair either way; re-inviting the bot is not.
    throw new Error(
      "The workspace's Slack credential could not be read — reconnect Slack under Admin → Integrations, then sync again.",
    );
  }
  return token;
}

export interface SlackHistoryConnectorDeps {
  /** Injected installation store for tests; defaults to the real one. */
  readonly store?: SlackInstallationReader;
  /** Injected workspace listing for tests; defaults to the real one. */
  readonly listWorkspaces?: () => Promise<readonly string[]>;
  /** Injected scope machinery for tests. */
  readonly refreshScope?: typeof refreshSlackIngestScope;
  readonly resolvePollScope?: typeof resolveSlackPollScope;
}

/** Build the Slack chat-history brain source. `deps` is test-only injection. */
export function createSlackHistoryConnector(
  deps: SlackHistoryConnectorDeps = {},
): BrainSourceConnector<typeof SLACK_HISTORY_SOURCE> {
  const store: SlackInstallationReader = deps.store ?? { getInstallationByOrg, getBotToken };
  const listWorkspaces = deps.listWorkspaces ?? listSlackInstalledOrgIds;
  const refreshScope = deps.refreshScope ?? refreshSlackIngestScope;
  const pollScope = deps.resolvePollScope ?? resolveSlackPollScope;
  return {
    catalogId: SLACK_HISTORY_CATALOG_ID,
    source: SLACK_HISTORY_SOURCE,
    // ⚠️ PER-WORKSPACE, and this declaration is the whole of #5203 (grill #5200
    // T3).
    //
    // This source used to be `per-install` over `catalog:slack-history` — a
    // SECOND Slack install that collected no secret, registered no app, and
    // carried a channel list and nothing else. Because nothing about connecting
    // Slack suggested it was load-bearing, Atlas's own Slack ran live as a chat
    // platform in three prod regions with extraction on while the brain ingested
    // nothing for four days, every surface green.
    //
    // Dispatching over the workspaces that installed the CHAT PILLAR removes the
    // second act: `listSlackInstalledOrgIds` reads the same `chat_cache` rows the
    // adapter resolves tokens from, so "Slack is connected" and "the brain reads
    // Slack" are now ONE fact rather than two that could disagree.
    scope: {
      kind: "per-workspace",
      syncId: SLACK_EPISODE_SYNC_ID,
      listWorkspaces,
    },
    // Slack's grants are CHANNEL-scoped, and `audience/sync.ts` reconciles them
    // by walking channel rosters — a pass driven off the workspace's resolved
    // ingest scope rather than from the re-verifier registry. So this source
    // deliberately registers no re-verifier, and says so rather than leaving the
    // question open.
    audience: { kind: "externally-synced" },
    async createClient(ctx: BrainSourceInstallContext): Promise<BrainSourceVendorClient> {
      const token = await resolveSlackHistoryToken(store, ctx.workspaceId);

      // The membership refresh runs HERE — inside the connector's client factory
      // — deliberately. `episode-sync.ts` already wraps this call and turns a
      // throw into a recorded `status: "error"` attempt, which is exactly the
      // handling a failed scope resolution needs: a cycle that could not read the
      // bot's channel membership must NOT go on to poll whatever membership was
      // last observed and then report itself green. That is M1's failure shape,
      // and resolving scope anywhere the engine's error path did not cover would
      // rebuild it.
      const refreshed = await refreshScope({ workspaceId: ctx.workspaceId, token });
      const scope = await pollScope(ctx.workspaceId);

      log.info(
        {
          workspaceId: ctx.workspaceId,
          mode: scope.mode,
          channels: scope.channels.length,
          observed: refreshed.observed,
          excluded: scope.excludedInMembership,
          reconciledExclusions: refreshed.reconciledExclusions,
          unhealthy: refreshed.unhealthy,
        },
        "Slack brain source: resolved ingest scope from bot channel membership",
      );

      return createSlackHistoryClient({
        token,
        channels: scope.channels,
        backfillWindowMs: getChatBackfillWindowMs(),
        scopeWarnings: refreshed.warnings,
      });
    },
  };
}

/**
 * Register the Slack chat-history source idempotently — called from the boot
 * seam that also registers install handlers, and from tests.
 * `registerBrainSourceConnector` throws on a duplicate catalog id, so gate on
 * the registry first.
 */
export function registerSlackHistoryConnector(): void {
  if (getBrainSourceConnector(SLACK_HISTORY_CATALOG_ID) !== undefined) return;
  registerBrainSourceConnector(createSlackHistoryConnector());
  log.info({ catalogId: SLACK_HISTORY_CATALOG_ID }, "Registered Slack chat-history brain source");
}
