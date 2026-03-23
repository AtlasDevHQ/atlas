/**
 * Slack adapter configuration for the Chat SDK bridge.
 *
 * Wraps `@chat-adapter/slack`'s `createSlackAdapter()` with Atlas-specific
 * credential wiring. The adapter handles Slack signature verification,
 * event parsing, and Block Kit formatting internally.
 */

import { createSlackAdapter as createChatSlackAdapter } from "@chat-adapter/slack";
import type { SlackAdapterConfig } from "../config";

/**
 * Create a Chat SDK Slack adapter from Atlas plugin config.
 *
 * The Chat SDK adapter auto-verifies incoming webhook signatures using
 * the signing secret, so no additional verification layer is needed.
 */
export function createSlackAdapter(config: SlackAdapterConfig) {
  return createChatSlackAdapter({
    botToken: config.botToken,
    signingSecret: config.signingSecret,
  });
}
