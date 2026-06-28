/**
 * Slack implementation of the proactive channel-directory port (#3463).
 *
 * Wraps the resolution chain the admin route used to inline: workspace
 * org id → Slack installation → bot token → `conversations.list`. The
 * port boundary keeps `api/routes/admin-proactive.ts` free of Slack
 * imports; this module is the only place that knows the directory is
 * Slack-backed.
 *
 * Error mapping:
 * - no installation / unreadable token → `no_chat_installation`
 * - `missing_scope` from Slack         → `missing_scope` (#3466 — by the
 *   time this surfaces, `listChannels` has already retried public-only
 *   (#3462), so the token lacks even `channels:read` and the only fix
 *   is re-running the OAuth consent flow)
 * - anything else                      → `platform_error`
 */

import { getInstallationByOrg, getBotToken } from "@atlas/api/lib/slack/store";
import { listChannels } from "@atlas/api/lib/slack/api";
import type {
  ChannelDirectoryProvider,
  ChannelDirectoryResult,
} from "@atlas/api/lib/proactive/types";

export const slackChannelDirectoryProvider: ChannelDirectoryProvider = {
  async listWorkspaceChannels(workspaceId: string): Promise<ChannelDirectoryResult> {
    // Token resolution is DB-only per the workspace-credential rule —
    // callers (admin routes) already guarantee an internal DB exists.
    const installation = await getInstallationByOrg(workspaceId);
    const token = installation ? await getBotToken(installation.team_id) : null;
    if (!token) {
      return { ok: false, reason: "no_chat_installation" };
    }

    const result = await listChannels(token);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.error === "missing_scope" ? "missing_scope" : "platform_error",
        detail: result.error,
      };
    }
    return { ok: true, channels: result.channels };
  },
};
