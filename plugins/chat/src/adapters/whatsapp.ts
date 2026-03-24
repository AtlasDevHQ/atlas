/**
 * WhatsApp adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/whatsapp`'s `createWhatsAppAdapter()` for
 * import isolation. Passes through adapter credentials (access token, app
 * secret, phone number ID, verify token). The Chat SDK adapter handles
 * WhatsApp Business Cloud API communication, webhook signature verification
 * (HMAC-SHA256), and message formatting internally.
 */

import { createWhatsAppAdapter as createChatWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { WhatsAppAdapterConfig } from "../config";

/**
 * Create a Chat SDK WhatsApp adapter from Atlas plugin config.
 *
 * The Chat SDK adapter communicates with the WhatsApp Business Cloud API
 * (Meta Graph API) using the provided access token. Incoming webhook requests
 * are verified via HMAC-SHA256 using the app secret.
 */
export function createWhatsAppAdapter(config: WhatsAppAdapterConfig) {
  return createChatWhatsAppAdapter({
    accessToken: config.accessToken,
    appSecret: config.appSecret,
    phoneNumberId: config.phoneNumberId,
    verifyToken: config.verifyToken,
    userName: config.userName,
    apiVersion: config.apiVersion,
  });
}
