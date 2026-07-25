/**
 * The Slack chat-history {@link BrainSourceConnector} (#4770, ADR-0036
 * §Ingestion & connectors) — the catalog-id-keyed adapter the shared sync
 * cycle dispatches on. It owns only the factory contract: bind the stored
 * channel scope + the workspace's EXISTING Slack OAuth install into a vendor
 * client. Scheduling, backoff, caps, and the episode ingest are elsewhere.
 *
 * ## Credentials: reuse, never register
 *
 * This follows ADR-0030's amendment #4397 (Salesforce Knowledge) exactly: no
 * `knowledge_sync_credentials` row, no new secret path, no new OAuth app.
 * `createClient` resolves the workspace's Slack bot token from the same
 * `chat_cache` install the chat adapter uses (`lib/slack/store.ts`), so
 * "Slack is live" — which is true of the chat ADAPTER — is what makes this
 * connector installable at all. Disconnecting Slack breaks this source's sync,
 * surfaced per cycle as an actionable error outcome, never a silent no-op.
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
import { getBotToken, getInstallationByOrg } from "@atlas/api/lib/slack/store";
import { createSlackHistoryClient } from "./client";
import {
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_SOURCE,
  parseSlackHistoryConfig,
} from "./config";
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
}

/** Build the Slack chat-history brain source. `deps` is test-only injection. */
export function createSlackHistoryConnector(
  deps: SlackHistoryConnectorDeps = {},
): BrainSourceConnector {
  const store: SlackInstallationReader = deps.store ?? { getInstallationByOrg, getBotToken };
  return {
    catalogId: SLACK_HISTORY_CATALOG_ID,
    source: SLACK_HISTORY_SOURCE,
    async createClient(ctx: BrainSourceInstallContext): Promise<BrainSourceVendorClient> {
      const parsed = parseSlackHistoryConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);
      const token = await resolveSlackHistoryToken(store, ctx.workspaceId);
      return createSlackHistoryClient({
        token,
        channels: parsed.channels,
        backfillWindowMs: getChatBackfillWindowMs(),
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
