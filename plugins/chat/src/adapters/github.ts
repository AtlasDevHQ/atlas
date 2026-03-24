/**
 * GitHub adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/github`'s `createGitHubAdapter()` for
 * import isolation. Passes through adapter credentials (PAT or GitHub App).
 * The Chat SDK adapter handles GitHub API communication, webhook signature
 * verification, and GFM formatting internally.
 */

import { createGitHubAdapter as createChatGitHubAdapter } from "@chat-adapter/github";
import type { GitHubAdapterConfig as ChatGitHubAdapterConfig } from "@chat-adapter/github";
import type { GitHubAdapterConfig } from "../config";

/**
 * Create a Chat SDK GitHub adapter from Atlas plugin config.
 *
 * Supports three auth modes:
 * - Personal Access Token: `{ token }` — simplest, for personal bots
 * - GitHub App (single-tenant): `{ appId, privateKey, installationId }` — fixed org
 * - GitHub App (multi-tenant): `{ appId, privateKey }` — public app, auto-detects installation
 */
export function createGitHubAdapter(config: GitHubAdapterConfig) {
  const base = {
    webhookSecret: config.webhookSecret,
    userName: config.userName,
  };

  let adapterConfig: ChatGitHubAdapterConfig;

  if (config.token) {
    // PAT auth
    adapterConfig = { ...base, token: config.token };
  } else if (config.appId && config.privateKey && config.installationId) {
    // GitHub App single-tenant
    adapterConfig = {
      ...base,
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    };
  } else if (config.appId && config.privateKey) {
    // GitHub App multi-tenant
    adapterConfig = {
      ...base,
      appId: config.appId,
      privateKey: config.privateKey,
    };
  } else {
    // Auto-detect from env vars
    adapterConfig = base;
  }

  return createChatGitHubAdapter(adapterConfig);
}
