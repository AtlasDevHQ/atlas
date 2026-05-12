/**
 * Workspace-level model configuration types shared across API, frontend, and SDK.
 *
 * Workspaces can configure their own LLM provider per workspace, overriding
 * the platform default. The BYOT-only providers (anthropic, openai,
 * azure-openai, custom, bedrock) always require credentials. The `gateway`
 * provider points at the Vercel AI Gateway and accepts an optional key:
 * omit it to ride on the platform's gateway credentials (SaaS only), or
 * supply one to BYOT against your own gateway billing project.
 *
 * `bedrock` takes IAM creds stored as a JSON blob in
 * `api_key_encrypted` and a separate `bedrock_region` column. The
 * catalog is region-specific.
 */

// ── Provider types ──────────────────────────────────────────────────

export const MODEL_CONFIG_PROVIDERS = [
  "anthropic",
  "openai",
  "azure-openai",
  "custom",
  "gateway",
  "bedrock",
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
  // Bedrock stores an IAM cred blob in `api_key_encrypted` — the JSON shape
  // is `{ accessKeyId, secretAccessKey, sessionToken? }`. The blob is
  // required by the DB CHECK constraint just like every other BYOT row.
  bedrock: true,
} as const satisfies Record<ModelConfigProvider, boolean>;

/**
 * AWS regions that support Bedrock model invocation. The catalog differs
 * by region — `ap-northeast-1` exposes a different set than `us-east-1`.
 * The picker surfaces this list as a region dropdown; new regions land
 * here when AWS GAs Bedrock there.
 */
export const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-central-1",
  "eu-west-1",
  "eu-west-3",
  "ap-northeast-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-south-1",
  "ca-central-1",
  "sa-east-1",
] as const;
export type BedrockRegion = (typeof BEDROCK_REGIONS)[number];

/**
 * Bedrock-specific credential bundle. Stored as JSON in `api_key_encrypted`
 * after `encryptSecret`; the helper round-trips a string, so callers stringify
 * before encrypt and parse after decrypt.
 */
export interface BedrockCredentialBundle {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional STS session token for federated / temporary creds. */
  sessionToken?: string;
}

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

/**
 * Tracks whether the saved `model` is still present in the upstream
 * provider's catalog. Updated server-side after a discovery refresh:
 * a missing model flips to `deprecated` + populates
 * `modelSuggestedReplacement`. The admin UI surfaces a warning row
 * with "Apply suggestion" / "Keep current" actions. Resetting the
 * model via `setWorkspaceModelConfig` flips status back to `healthy`.
 */
export type ModelStatus = "healthy" | "deprecated";

export interface WorkspaceModelConfig {
  id: string;
  orgId: string;
  provider: ModelConfigProvider;
  model: string;
  /** Base URL — required for azure-openai and custom providers. */
  baseUrl: string | null;
  /**
   * AWS region for `bedrock` rows. `null` for every other provider (the
   * DB-side `chk_model_provider_region` constraint enforces NOT NULL when
   * `provider='bedrock'`).
   */
  bedrockRegion: BedrockRegion | null;
  /**
   * API key masked to last 4 characters (never sent in full). `null` only
   * when `apiKeyStatus !== "masked"` — see `ApiKeyStatus` for the cases.
   * For `bedrock` rows the masked value is the `accessKeyId` tail; the
   * `secretAccessKey` half of the bundle is never echoed to the wire.
   */
  apiKeyMasked: string | null;
  /** See `ApiKeyStatus`. UI consumers branch on this rather than guessing from `apiKeyMasked`. */
  apiKeyStatus: ApiKeyStatus;
  /**
   * Health of the saved `model` against the most recent provider catalog
   * refresh. `deprecated` when the upstream catalog no longer surfaces
   * the saved ID. The admin UI surfaces a warning row.
   */
  modelStatus: ModelStatus;
  /**
   * Atlas's best-effort closest-match for the deprecated model, sourced
   * from the most recent provider catalog at refresh time. `null` when
   * `modelStatus === "healthy"` (enforced by the Zod refine + DB write
   * gating), or when the suggestion algorithm couldn't find a confident
   * match. Use the `isDeprecatedConfig` guard below to access this
   * without a manual null check.
   */
  modelSuggestedReplacement: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Narrowed views ──────────────────────────────────────────────────
//
// The Zod schema keeps the wire shape flat so consumers that just
// stringify the row don't need to discriminate. These narrowed aliases
// + type guards give code paths that DO care about the invariant a
// compile-time-enforced view. Keeping `WorkspaceModelConfig` flat
// preserves the `satisfies z.ZodType<WorkspaceModelConfig, unknown>`
// check in `@useatlas/schemas` — a true discriminated union there
// would need a `z.discriminatedUnion` rewrite, which is out of scope.

/** Narrowed view: `bedrockRegion` is non-null. */
export type BedrockModelConfig = WorkspaceModelConfig & {
  provider: "bedrock";
  bedrockRegion: BedrockRegion;
};

/** Narrowed view: provider is everything except bedrock; region is null. */
export type NonBedrockModelConfig = WorkspaceModelConfig & {
  provider: Exclude<ModelConfigProvider, "bedrock">;
  bedrockRegion: null;
};

/** Narrowed view: status is `deprecated` (suggestion may still be null on inconclusive matches). */
export type DeprecatedModelConfig = WorkspaceModelConfig & {
  modelStatus: "deprecated";
};

/** Narrowed view: status is `healthy`; suggestion is null. */
export type HealthyModelConfig = WorkspaceModelConfig & {
  modelStatus: "healthy";
  modelSuggestedReplacement: null;
};

export function isBedrockConfig(c: WorkspaceModelConfig): c is BedrockModelConfig {
  return c.provider === "bedrock" && c.bedrockRegion !== null;
}

export function isDeprecatedConfig(c: WorkspaceModelConfig): c is DeprecatedModelConfig {
  return c.modelStatus === "deprecated";
}

export function isHealthyConfig(c: WorkspaceModelConfig): c is HealthyModelConfig {
  return c.modelStatus === "healthy";
}

// ── Request / response shapes ───────────────────────────────────────

export interface SetWorkspaceModelConfigRequest {
  provider: ModelConfigProvider;
  model: string;
  /**
   * For BYOT providers: required on initial creation, omit to keep the
   * existing key on update. For `gateway`: omit (or pass empty) to use
   * platform credits; pass a value to BYOT against your own gateway. For
   * `bedrock`: a JSON-encoded `BedrockCredentialBundle` (the helper
   * stringifies before encrypting); the picker UI handles the encoding.
   */
  apiKey?: string;
  /** Required for azure-openai and custom providers. */
  baseUrl?: string;
  /** Required when `provider='bedrock'`. AWS region for ListFoundationModels + Converse. */
  bedrockRegion?: BedrockRegion;
}

export interface TestModelConfigRequest {
  provider: ModelConfigProvider;
  model: string;
  /** Omit for `gateway` on platform credits. Required for every other case. */
  apiKey?: string;
  baseUrl?: string;
  /** Required when `provider='bedrock'`. AWS region for the Converse probe. */
  bedrockRegion?: BedrockRegion;
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
