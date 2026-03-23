/**
 * Slack adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/slack`'s `createSlackAdapter()` for
 * import isolation. Passes through adapter credentials without modification.
 * The Chat SDK adapter handles Slack signature verification, event parsing,
 * and Block Kit formatting internally.
 */

import { createSlackAdapter as createChatSlackAdapter } from "@chat-adapter/slack";
import type { SlackAdapterConfig } from "../config";

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
  });
}
