/**
 * Linear adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/linear`'s `createLinearAdapter()` for
 * import isolation. Passes through adapter credentials (API key, OAuth token,
 * or OAuth app client credentials). The Chat SDK adapter handles Linear API
 * communication, webhook signature verification, and markdown formatting
 * internally.
 */

import { createLinearAdapter as createChatLinearAdapter } from "@chat-adapter/linear";
import type { LinearAdapterConfig } from "../config";

/**
 * Create a Chat SDK Linear adapter from Atlas plugin config.
 *
 * Maps from the Atlas discriminated union config to the upstream
 * `@chat-adapter/linear` config. The three auth modes correspond to:
 * - API Key: `{ apiKey }` — personal bots or testing
 * - OAuth token: `{ accessToken }` — pre-obtained OAuth token
 * - OAuth App: `{ clientId, clientSecret }` — recommended for apps
 */
export function createLinearAdapter(config: LinearAdapterConfig) {
  const base = {
    webhookSecret: config.webhookSecret,
    userName: config.userName,
  };

  if ("apiKey" in config && config.apiKey) {
    return createChatLinearAdapter({ ...base, apiKey: config.apiKey });
  }

  if ("accessToken" in config && config.accessToken) {
    return createChatLinearAdapter({ ...base, accessToken: config.accessToken });
  }

  if ("clientId" in config && config.clientId) {
    if (!config.clientSecret) {
      throw new Error("clientId provided without clientSecret — this should be caught by validation");
    }
    return createChatLinearAdapter({
      ...base,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
  }

  // Unreachable after Zod validation, but defense-in-depth
  throw new Error(
    "Linear adapter requires either 'apiKey', 'accessToken', or 'clientId' + 'clientSecret'. " +
    "No credentials were provided.",
  );
}
