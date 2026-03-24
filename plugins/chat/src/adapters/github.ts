/**
 * GitHub adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/github`'s `createGitHubAdapter()` for
 * import isolation. Passes through adapter credentials (PAT or GitHub App).
 * The Chat SDK adapter handles GitHub API communication, webhook signature
 * verification, and GFM formatting internally.
 */

import { createGitHubAdapter as createChatGitHubAdapter } from "@chat-adapter/github";
import type { GitHubAdapterConfig } from "../config";

/**
 * Create a Chat SDK GitHub adapter from Atlas plugin config.
 *
 * Maps from the Atlas discriminated union config to the upstream
 * `@chat-adapter/github` config. The three auth modes correspond to:
 * - PAT: `{ token }` — personal bots or testing
 * - App single-tenant: `{ appId, privateKey, installationId }` — fixed org
 * - App multi-tenant: `{ appId, privateKey }` — public app
 */
export function createGitHubAdapter(config: GitHubAdapterConfig) {
  const base = {
    webhookSecret: config.webhookSecret,
    userName: config.userName,
  };

  if ("token" in config && config.token) {
    return createChatGitHubAdapter({ ...base, token: config.token });
  }

  if ("appId" in config && config.appId) {
    if ("installationId" in config && config.installationId) {
      return createChatGitHubAdapter({
        ...base,
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      });
    }
    return createChatGitHubAdapter({
      ...base,
      appId: config.appId,
      privateKey: config.privateKey,
    });
  }

  // Unreachable after Zod validation, but defense-in-depth
  throw new Error(
    "GitHub adapter requires either 'token' (PAT) or 'appId' + 'privateKey' (GitHub App). " +
    "No credentials were provided.",
  );
}
