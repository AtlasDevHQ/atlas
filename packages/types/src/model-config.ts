/**
 * Workspace-level model configuration types shared across API, frontend, and SDK.
 *
 * Workspaces can configure their own LLM provider per workspace, overriding the
 * platform default. Two BYOT-only providers — anthropic, openai, azure-openai,
 * custom — always require an API key. The fifth provider, `gateway`, points at
 * the Vercel AI Gateway and accepts an optional key: omit it to ride on the
 * platform's gateway credentials (SaaS only), or supply one to BYOT against
 * your own gateway billing project.
 */

// ── Provider types ──────────────────────────────────────────────────

export const MODEL_CONFIG_PROVIDERS = [
  "anthropic",
  "openai",
  "azure-openai",
  "custom",
  "gateway",
] as const;
export type ModelConfigProvider = (typeof MODEL_CONFIG_PROVIDERS)[number];

/**
 * Per-provider "requires a BYOT API key" lookup. The `satisfies` clause forces
 * every future entry in `MODEL_CONFIG_PROVIDERS` to declare its BYOT-ness here
 * at compile time — a new provider that forgets to opt in fails the build
 * instead of drifting from the DB `chk_model_provider_key` constraint.
 */
export const PROVIDER_REQUIRES_KEY = {
  anthropic: true,
  openai: true,
  "azure-openai": true,
  custom: true,
  gateway: false,
} as const satisfies Record<ModelConfigProvider, boolean>;

export function providerRequiresKey(provider: ModelConfigProvider): boolean {
  return PROVIDER_REQUIRES_KEY[provider];
}

/** Derived list of BYOT-only providers — single source of truth. */
export const BYOT_REQUIRED_PROVIDERS: readonly ModelConfigProvider[] = (
  Object.entries(PROVIDER_REQUIRES_KEY) as [ModelConfigProvider, boolean][]
)
  .filter(([, requires]) => requires)
  .map(([provider]) => provider);

// ── Config record ───────────────────────────────────────────────────

/**
 * Status of the stored API key surfaced on `WorkspaceModelConfig`.
 * - `masked`: a valid encrypted key is present, mask returned in `apiKeyMasked`.
 * - `platform_credits`: provider is `gateway` and no BYOT key was stored —
 *   the workspace rides on the deploy's `AI_GATEWAY_API_KEY`.
 * - `decrypt_failed`: a key exists but cannot be decrypted (key rotation drift,
 *   wrong `ATLAS_ENCRYPTION_KEYS`). The admin UI must prompt re-entry; using
 *   the stored row in this state would silently fall back to the platform.
 */
export type ApiKeyStatus = "masked" | "platform_credits" | "decrypt_failed";

export interface WorkspaceModelConfig {
  id: string;
  orgId: string;
  provider: ModelConfigProvider;
  model: string;
  /** Base URL — required for azure-openai and custom providers. */
  baseUrl: string | null;
  /**
   * API key masked to last 4 characters (never sent in full). `null` only
   * when `apiKeyStatus !== "masked"` — see `ApiKeyStatus` for the cases.
   */
  apiKeyMasked: string | null;
  /** See `ApiKeyStatus`. UI consumers branch on this rather than guessing from `apiKeyMasked`. */
  apiKeyStatus: ApiKeyStatus;
  createdAt: string;
  updatedAt: string;
}

// ── Request / response shapes ───────────────────────────────────────

export interface SetWorkspaceModelConfigRequest {
  provider: ModelConfigProvider;
  model: string;
  /**
   * For BYOT providers: required on initial creation, omit to keep the
   * existing key on update. For `gateway`: omit (or pass empty) to use
   * platform credits; pass a value to BYOT against your own gateway.
   */
  apiKey?: string;
  /** Required for azure-openai and custom providers. */
  baseUrl?: string;
}

export interface TestModelConfigRequest {
  provider: ModelConfigProvider;
  model: string;
  /** Omit for `gateway` on platform credits. Required for every other case. */
  apiKey?: string;
  baseUrl?: string;
}

export interface TestModelConfigResponse {
  success: boolean;
  message: string;
  /** Model name returned by the provider, if available. */
  modelName?: string;
}

// ── Gateway catalog ─────────────────────────────────────────────────

/** Closed set of model types Vercel's gateway publishes. */
export const GATEWAY_MODEL_TYPES = ["language", "embedding", "image", "video", "reranking"] as const;
export type GatewayModelType = (typeof GATEWAY_MODEL_TYPES)[number];

/**
 * Single model entry surfaced by the Vercel AI Gateway catalog endpoint
 * (`GET https://ai-gateway.vercel.sh/v1/models`). We retain only the
 * fields the picker UI consumes — pricing tiers and architecture detail
 * stay on the server.
 */
export interface GatewayCatalogModel {
  /** Gateway model ID, e.g. `anthropic/claude-opus-4.6`. */
  id: string;
  /** Human-readable name surfaced in the picker. */
  name: string;
  /** Originating provider (e.g. `anthropic`, `openai`, `google`). */
  provider: string;
  type: GatewayModelType;
  /** Maximum context window in tokens. `null` if the catalog omits it. */
  contextWindow: number | null;
  /** Maximum output tokens. `null` if the catalog omits it. */
  maxOutputTokens: number | null;
  /** Per-token input price (USD) if surfaced by the catalog. */
  inputPrice: string | null;
  /** Per-token output price (USD) if surfaced by the catalog. */
  outputPrice: string | null;
  /** Whether this entry is in Atlas's curated "recommended" subset. */
  recommended: boolean;
}

export interface GatewayCatalogResponse {
  models: GatewayCatalogModel[];
  /** Server-side fetch time (ISO 8601). Surfaces cache age in the UI. */
  fetchedAt: string;
  /** True when the live catalog fetch failed and we returned a bundled fallback. */
  fallback: boolean;
}
