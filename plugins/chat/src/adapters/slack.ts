/**
 * Slack adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/slack`'s `createSlackAdapter()` for
 * import isolation. Passes through adapter credentials without modification.
 * The Chat SDK adapter handles Slack signature verification, event parsing,
 * and Block Kit formatting internally.
 */

import { createSlackAdapter as createChatSlackAdapter } from "@chat-adapter/slack";
import { DEFAULT_BOT_USER_NAME, type SlackAdapterConfig } from "../config";

/**
 * Create a Chat SDK Slack adapter from Atlas plugin config.
 *
 * The Chat SDK adapter auto-verifies incoming webhook signatures using
 * the signing secret, so no additional verification layer is needed.
 * OAuth credentials are passed through for multi-workspace support.
 */
export function createSlackAdapter(config: SlackAdapterConfig) {
  return createChatSlackAdapter({
    botToken: config.botToken,
    signingSecret: config.signingSecret,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // Without this the adapter defaults to the literal "bot" and, being
    // truthy, shadows `chat.userName` in `detectMention` — so @-mentions
    // that arrive as a plain `message` event (rather than `app_mention`)
    // are never recognised and fall through to the pattern handlers.
    // See DEFAULT_BOT_USER_NAME for the full chain (#4909).
    userName: config.userName ?? DEFAULT_BOT_USER_NAME,
    // Per-tenant AES-GCM envelope for installation bot tokens (#2634).
    // Pass-through when configured; the chat-adapter falls back to its
    // own `SLACK_ENCRYPTION_KEY` env lookup when undefined.
    encryptionKey: config.encryptionKey,
  });
}
