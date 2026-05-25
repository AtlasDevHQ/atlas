/**
 * Google Chat adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/gchat`'s `createGoogleChatAdapter()` for
 * import isolation. Maps Atlas config fields to Chat SDK adapter config.
 * The Chat SDK adapter handles Google Chat event parsing, Card v2 formatting,
 * service account authentication, and Workspace Events subscriptions internally.
 */

import { createGoogleChatAdapter as createChatGoogleChatAdapter } from "@chat-adapter/gchat";
import type { GoogleChatAdapterConfig as UpstreamConfig } from "@chat-adapter/gchat";
import type { GoogleChatAdapterConfig } from "../config";

/**
 * Create a Chat SDK Google Chat adapter from Atlas plugin config.
 *
 * The Chat SDK adapter authenticates via service account credentials (JSON key)
 * or Application Default Credentials. When `pubsubTopic` is configured, the
 * adapter automatically creates Workspace Events subscriptions to receive all
 * messages (not just @mentions).
 */
export function createGoogleChatAdapter(config: GoogleChatAdapterConfig) {
  // The upstream config is a discriminated union — build the right variant
  // based on which auth fields are provided.
  //
  // `googleChatProjectNumber` + `pubsubAudience` ride on the base so
  // both auth variants honor them. The upstream adapter silently
  // degrades to "no signature verification" when these are unset (it
  // emits a warn line per inbound webhook); we surface the env-gate
  // through `register.ts` so operators see the gap at boot rather than
  // hidden in webhook-handler logs.
  const base = {
    endpointUrl: config.endpointUrl,
    pubsubTopic: config.pubsubTopic,
    impersonateUser: config.impersonateUser,
    googleChatProjectNumber: config.googleChatProjectNumber,
    pubsubAudience: config.pubsubAudience,
  };

  let upstreamConfig: UpstreamConfig;
  if (config.credentials) {
    upstreamConfig = { ...base, credentials: config.credentials };
  } else if (config.useApplicationDefaultCredentials) {
    upstreamConfig = { ...base, useApplicationDefaultCredentials: true };
  } else {
    // Auto-detect from env vars (GOOGLE_CHAT_CREDENTIALS / GOOGLE_CHAT_USE_ADC)
    upstreamConfig = base;
  }

  return createChatGoogleChatAdapter(upstreamConfig);
}
