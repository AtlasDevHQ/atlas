/**
 * Thin Bot Connector API client using native fetch.
 *
 * Handles Azure AD OAuth2 client-credentials flow for obtaining access
 * tokens, and sending reply activities to the Bot Connector service.
 * No heavy SDK — native fetch with proper error handling.
 */

import type { AdaptiveCard } from "./format";
import type { PluginLogger } from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Azure AD token endpoint
// ---------------------------------------------------------------------------

const TOKEN_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Get an OAuth2 access token for the Bot Connector API.
 *
 * Uses the client credentials flow with the bot's appId and appPassword.
 * Tokens are cached and refreshed 60 seconds before expiry.
 */
export async function getAccessToken(
  appId: string,
  appPassword: string,
  log?: PluginLogger,
): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: appPassword,
        scope: BOT_FRAMEWORK_SCOPE,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      log?.error(
        { status: resp.status },
        "Azure AD token request failed",
      );
      throw new Error(`Azure AD token request failed: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
    };

    if (!data.access_token) {
      throw new Error("Azure AD token response missing access_token");
    }

    // Cache with 60-second buffer before expiry
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };

    return data.access_token;
  } catch (err) {
    log?.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to obtain Azure AD access token",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Bot Connector API
// ---------------------------------------------------------------------------

export interface ReplyActivity {
  type: "message";
  text?: string;
  attachments?: Array<{
    contentType: string;
    content: AdaptiveCard;
  }>;
}

/**
 * Send a reply activity to the Bot Connector API.
 *
 * Uses the service URL from the incoming activity and the conversation
 * context to post a reply in the correct thread.
 */
export async function sendReply(
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  activity: ReplyActivity,
  token: string,
  log?: PluginLogger,
): Promise<boolean> {
  // Ensure service URL ends without trailing slash
  const base = serviceUrl.replace(/\/+$/, "");
  const url = `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activity),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      log?.error(
        { status: resp.status, url },
        "Bot Connector reply failed",
      );
      return false;
    }

    return true;
  } catch (err) {
    log?.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Bot Connector reply request failed",
    );
    return false;
  }
}

/** Reset the token cache (for testing). */
export function resetTokenCache(): void {
  cachedToken = null;
}
