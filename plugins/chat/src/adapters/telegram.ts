/**
 * Telegram adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/telegram`'s `createTelegramAdapter()` for
 * import isolation. Maps Atlas config fields to Chat SDK adapter config.
 * The Chat SDK adapter handles Telegram Bot API communication, webhook
 * secret token verification, and message formatting internally.
 */

import { createTelegramAdapter as createChatTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapterConfig } from "../config";

/**
 * Create a Chat SDK Telegram adapter from Atlas plugin config.
 *
 * The Chat SDK adapter communicates with the Telegram Bot API using the
 * provided bot token. When `secretToken` is configured, incoming webhook
 * requests are verified against the `x-telegram-bot-api-secret-token` header.
 */
export function createTelegramAdapter(config: TelegramAdapterConfig) {
  return createChatTelegramAdapter({
    botToken: config.botToken,
    secretToken: config.secretToken,
    mode: "webhook",
  });
}
