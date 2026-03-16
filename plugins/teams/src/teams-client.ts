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
// Service URL validation — prevent SSRF via crafted serviceUrl
// ---------------------------------------------------------------------------

const ALLOWED_SERVICE_URL_PATTERNS = [
  /^https:\/\/[^/]*\.botframework\.com(\/|$)/,
  /^https:\/\/[^/]*\.trafficmanager\.net(\/|$)/,
];

/**
 * Validate that a service URL is a known Microsoft Bot Connector endpoint.
 * Prevents SSRF by rejecting arbitrary URLs in the activity's serviceUrl field.
 */
export function isValidServiceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_SERVICE_URL_PATTERNS.some((p) => p.test(url));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token cache — keyed by appId for multi-instance safety
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get an OAuth2 access token for the Bot Connector API.
 *
 * Uses the client credentials flow with the bot's appId and appPassword.
 * Tokens are cached per appId and refreshed before expiry.
 */
export async function getAccessToken(
  appId: string,
  appPassword: string,
  log?: PluginLogger,
): Promise<string> {
  const cached = tokenCache.get(appId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

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
    throw new Error(`Azure AD token request failed: HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };

  if (!data.access_token) {
    throw new Error("Azure AD token response missing access_token");
  }

  // Validate expires_in and enforce minimum cache duration
  const expiresIn =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? data.expires_in
      : 300;
  const bufferSeconds = Math.min(60, Math.floor(expiresIn / 2));

  tokenCache.set(appId, {
    token: data.access_token,
    expiresAt: Date.now() + (expiresIn - bufferSeconds) * 1000,
  });

  return data.access_token;
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
  tokenCache.clear();
}
