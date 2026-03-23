/**
 * Workspace-level model configuration types shared across API, frontend, and SDK.
 *
 * Enterprise customers can configure their own LLM provider and API key per
 * workspace, overriding the platform default. Supported providers: Anthropic,
 * OpenAI, Azure OpenAI, and custom OpenAI-compatible endpoints.
 */

// ── Provider types ──────────────────────────────────────────────────

export const MODEL_CONFIG_PROVIDERS = ["anthropic", "openai", "azure-openai", "custom"] as const;
export type ModelConfigProvider = (typeof MODEL_CONFIG_PROVIDERS)[number];

// ── Config record ───────────────────────────────────────────────────

export interface WorkspaceModelConfig {
  id: string;
  orgId: string;
  provider: ModelConfigProvider;
  model: string;
  /** Base URL — required for azure-openai and custom providers. */
  baseUrl: string | null;
  /** API key masked to last 4 characters (never sent in full). */
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}

// ── Request / response shapes ───────────────────────────────────────

export interface SetWorkspaceModelConfigRequest {
  provider: ModelConfigProvider;
  model: string;
  /** Omit to keep the existing key on update. Required on initial creation. */
  apiKey?: string;
  /** Required for azure-openai and custom providers. */
  baseUrl?: string;
}

export interface TestModelConfigRequest {
  provider: ModelConfigProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface TestModelConfigResponse {
  success: boolean;
  message: string;
  /** Model name returned by the provider, if available. */
  modelName?: string;
}
