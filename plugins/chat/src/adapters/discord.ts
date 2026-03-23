/**
 * Discord adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/discord`'s `createDiscordAdapter()` for
 * import isolation. Passes through adapter credentials without modification.
 * The Chat SDK adapter handles Ed25519 signature verification, interaction
 * parsing, and Discord Embed formatting internally.
 */

import { createDiscordAdapter as createChatDiscordAdapter } from "@chat-adapter/discord";
import type { DiscordAdapterConfig } from "../config";

/**
 * Create a Chat SDK Discord adapter from Atlas plugin config.
 *
 * The Chat SDK adapter auto-verifies incoming webhook signatures using
 * Ed25519 (Discord public key), so no additional verification layer is needed.
 * Mention role IDs are passed through for extended mention handling.
 */
export function createDiscordAdapter(config: DiscordAdapterConfig) {
  return createChatDiscordAdapter({
    botToken: config.botToken,
    applicationId: config.applicationId,
    publicKey: config.publicKey,
    mentionRoleIds: config.mentionRoleIds,
  });
}
