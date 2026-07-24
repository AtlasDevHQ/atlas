/**
 * Multi-provider LLM configuration.
 *
 * Set ATLAS_PROVIDER and the corresponding API key in your .env.
 * Supports Anthropic, OpenAI, AWS Bedrock, Ollama, OpenAI-compatible
 * (vLLM, TGI, LiteLLM, etc.), and Vercel AI Gateway.
 *
 * Enterprise workspaces can override the platform default via
 * workspace-level model configuration (see ee/src/platform/model-routing.ts).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { bedrock, createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { bedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { gateway } from "ai";
import type { LanguageModel } from "ai";
import type { ModelConfigProvider } from "@useatlas/types";
import { createLogger } from "./logger";
import { isSafeExternalUrl } from "@atlas/api/lib/sandbox/validate";
import { createGuardedFetch, isInternalEgressAllowed } from "@atlas/api/lib/openapi/egress-guard";
import type { WorkspaceCredentials } from "@atlas/api/lib/auth/credentials";

const log = createLogger("providers");

/** Provider strings accepted in ATLAS_PROVIDER. */
type ConfigProvider = "anthropic" | "openai" | "bedrock" | "ollama" | "openai-compatible" | "gateway";

/** Resolved provider type (bedrock splits into bedrock vs bedrock-anthropic). */
export type ProviderType = ConfigProvider | "bedrock-anthropic";

const VALID_PROVIDERS: ReadonlySet<ConfigProvider> = new Set([
  "anthropic",
  "openai",
  "bedrock",
  "ollama",
  "openai-compatible",
  "gateway",
]);

/**
 * Whether `value` is a supported `ATLAS_PROVIDER`. Exposed so boot guards can
 * distinguish a genuinely-unknown provider (a typo — `resolveSelection()` would
 * throw on every chat) from a valid-but-keyless one (`ollama`,
 * `openai-compatible`). Mirrors the membership `resolveSelection()` enforces.
 */
export function isSupportedProvider(value: string): boolean {
  return VALID_PROVIDERS.has(value as ConfigProvider);
}

const PROVIDER_DEFAULTS: Record<ConfigProvider, string | undefined> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4o",
  bedrock: "anthropic.claude-opus-4-8",
  ollama: "llama3.1",
  "openai-compatible": undefined,
  // Hosted/gateway default: balanced Sonnet 5, NOT Opus 4.8. The gateway
  // path is the SaaS billing surface, where an unset workspace would otherwise
  // silently run (and be billed for) Opus 4.8 at ~5x the input cost while the
  // billing picker advertised Sonnet (#3098). Keep this in lockstep with the
  // billing page's displayed default — both flow through `resolveModelId()`.
  gateway: "anthropic/claude-sonnet-5",
};

/**
 * Returns the default provider string based on runtime environment.
 *
 * Hosted/SaaS deployments route through the Vercel AI Gateway (the operator's
 * metered key), so they default to `gateway`; self-hosted defaults to
 * anthropic-direct (BYO `ANTHROPIC_API_KEY`). `VERCEL` covers Vercel-hosted;
 * `ATLAS_DEPLOY_MODE=saas` covers the Railway-hosted SaaS where `VERCEL` is
 * unset (#3098). Single source of truth for "which provider when none is
 * explicitly configured" — the `ATLAS_PROVIDER` setting has no static default,
 * so an unset provider falls through to here rather than forcing `anthropic`.
 */
export function getDefaultProvider(): ConfigProvider {
  return process.env.VERCEL || process.env.ATLAS_DEPLOY_MODE === "saas"
    ? "gateway"
    : "anthropic";
}

/**
 * Maps an `ATLAS_PROVIDER` value to the env var that holds its API key.
 *
 * Single source of truth for "which key does this provider need" — consumed
 * by `startup.ts`'s per-request diagnostic (`checkProviderApiKey`, a 503 path)
 * AND by `ProviderKeyGuardLive` (the SaaS boot guard, #3178) so the two agree
 * on the exact key the runtime will require. Lives here next to
 * {@link getDefaultProvider} (the provider-resolution SSOT) rather than in
 * `startup.ts` so the boot guard can read it without pulling the startup
 * module's heavy request-path graph.
 *
 * - `ollama` → empty string: runs locally, no API key required (callers treat
 *   `""` as "no key needed", distinct from an unknown provider's `undefined`).
 * - `openai-compatible` is intentionally absent: it authenticates via a base
 *   URL, not a fixed key var, so neither the diagnostic nor the guard asserts
 *   a key for it (lookup is `undefined` → skipped).
 *
 * This map answers "which single *primary* key" — kept for display / signup-URL
 * lookups. The authoritative "is this provider fully configured" check is
 * {@link getMissingProviderConfig}, which models each provider's required env as
 * a SET (Bedrock needs an access key AND a secret; openai-compatible needs its
 * base URL) so a partial config can't boot green then fail the first chat (#3200).
 */
export const PROVIDER_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  bedrock: "AWS_ACCESS_KEY_ID",
  ollama: "", // Ollama runs locally, no API key required
  gateway: "AI_GATEWAY_API_KEY",
};

/** An env var is "set" only when present AND non-empty (mirrors the truthy
 * `!process.env[key]` check the per-request diagnostic has always used). */
function isProviderEnvSet(key: string): boolean {
  const value = process.env[key];
  return value !== undefined && value !== "";
}

/**
 * Bedrock static-credentials all-or-none rule (#3200).
 *
 * The static-credentials path needs BOTH `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY`. But a naive "require both" would false-fail the
 * deploys that set NEITHER and instead rely on the AWS credential-provider
 * chain (EC2/ECS instance profile, SSO, `~/.aws/credentials`, web-identity).
 * So the pair is treated as all-or-none: if NEITHER is set, require nothing
 * (chain-backed deploy); if EITHER is set, the deploy is using static creds and
 * the partner is required — a half-configured pair throws at first model init.
 *
 * Region is intentionally NOT asserted — it has its own chain fallbacks
 * (`AWS_REGION` / `AWS_DEFAULT_REGION` / instance metadata), so a missing region
 * env var is not necessarily a misconfig.
 */
function missingBedrockStaticCreds(): string[] {
  const pair = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;
  const anySet = pair.some(isProviderEnvSet);
  if (!anySet) return []; // credential-provider chain — nothing statically required
  return pair.filter((key) => !isProviderEnvSet(key));
}

/**
 * Required-config SSOT (#3200): the env vars that MUST be set for `provider` to
 * initialize but currently are not — `[]` when the provider's required config is
 * complete, when it needs none (`ollama`), or for an unknown provider (the
 * unsupported-provider decision is the caller's, via {@link isSupportedProvider}).
 *
 * Consumed by BOTH `ProviderKeyGuardLive` (the SaaS boot guard) and
 * `startup.ts:checkProviderApiKey` (the per-request 503 diagnostic) so the two
 * agree on exactly what "configured" means for every provider — including the
 * multi-key providers a single `PROVIDER_KEY_MAP` lookup silently passed:
 *
 *   - `bedrock` — `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (all-or-none;
 *     see {@link missingBedrockStaticCreds}).
 *   - `openai-compatible` — `OPENAI_COMPATIBLE_BASE_URL` (no `PROVIDER_KEY_MAP`
 *     entry; `buildModel()` throws without it).
 */
export function getMissingProviderConfig(provider: string): string[] {
  switch (provider) {
    case "anthropic":
      return isProviderEnvSet("ANTHROPIC_API_KEY") ? [] : ["ANTHROPIC_API_KEY"];
    case "openai":
      return isProviderEnvSet("OPENAI_API_KEY") ? [] : ["OPENAI_API_KEY"];
    case "gateway":
      return isProviderEnvSet("AI_GATEWAY_API_KEY") ? [] : ["AI_GATEWAY_API_KEY"];
    case "openai-compatible": {
      // Needs its base URL AND a model id: openai-compatible is the only
      // provider with no `PROVIDER_DEFAULTS` model, so `resolveSelection()`
      // throws "ATLAS_MODEL is required" without one — the same
      // boot-green-then-first-I/O failure the guard exists to prevent. The
      // model is resolved from `ATLAS_MODEL` on the env path this check covers
      // (resolveSelection: `modelOverride ?? process.env.ATLAS_MODEL ??
      // PROVIDER_DEFAULTS[provider]`).
      const missing: string[] = [];
      if (!isProviderEnvSet("OPENAI_COMPATIBLE_BASE_URL")) missing.push("OPENAI_COMPATIBLE_BASE_URL");
      if (!isProviderEnvSet("ATLAS_MODEL")) missing.push("ATLAS_MODEL");
      return missing;
    }
    case "bedrock":
      return missingBedrockStaticCreds();
    case "ollama":
      return []; // runs locally, no key
    default:
      // Unknown provider — not this function's concern (see isSupportedProvider).
      return [];
  }
}

/**
 * Resolve the provider the env-based model path ({@link getModel}) would select,
 * then report any env vars it still needs to make a call.
 *
 * `missing` empty ⇒ {@link getModel}'s provider is fully configured and a
 * one-shot `generateText` would succeed (modulo network/key validity). Mirrors
 * `resolveSelection`'s no-override provider resolution
 * (`ATLAS_PROVIDER ?? getDefaultProvider()`) so the answer matches what
 * {@link getModel} actually does at call time.
 *
 * Used by the wizard's two-phase generate enrich endpoint (issue #3236) to
 * fail fast with one actionable "configure a provider" message instead of
 * letting every per-table enrichment hit the same provider-auth error.
 */
export function getMissingModelConfig(): { provider: string; missing: string[] } {
  const provider = process.env.ATLAS_PROVIDER ?? getDefaultProvider();
  if (!isSupportedProvider(provider)) {
    // An unknown/typo provider would otherwise fall through to
    // getMissingProviderConfig's default `[]` (reads as "configured") and then
    // throw at getModel()/resolveSelection() time — defeating the fail-fast this
    // function exists for. Report it as missing so callers gate up front.
    return { provider, missing: [`ATLAS_PROVIDER (unsupported: "${provider}")`] };
  }
  return { provider, missing: getMissingProviderConfig(provider) };
}

/** Anthropic-family model ids contain "anthropic" or "claude". */
function isAnthropicFamilyModelId(modelId: string): boolean {
  return modelId.includes("anthropic") || modelId.includes("claude");
}

function isBedrockAnthropicModel(modelId: string): boolean {
  return isAnthropicFamilyModelId(modelId);
}

/**
 * Whether a gateway-routed model id targets an Anthropic-family model.
 *
 * Gateway model ids are `<provider>/<model>` (e.g. `anthropic/claude-opus-4.8`,
 * `vertex/claude-...`). The AI Gateway forwards `providerOptions.anthropic` to
 * the underlying provider, so any Anthropic-family route accepts — and needs —
 * the same explicit `cacheControl` markers as the direct Anthropic provider.
 * Anthropic caching is opt-in (unlike OpenAI's implicit caching), so without
 * the markers the gateway → Anthropic path runs fully uncached (#3099).
 */
export function isGatewayAnthropicModel(modelId: string): boolean {
  return isAnthropicFamilyModelId(modelId);
}

/**
 * Resolve provider + model ID from optional overrides, falling back to env
 * vars (`ATLAS_PROVIDER` / `ATLAS_MODEL`) and finally the per-provider
 * {@link PROVIDER_DEFAULTS}.
 *
 * This is the single source of truth for "which model does Atlas run". Both
 * the env path ({@link resolveProvider}) and the settings path
 * ({@link getModelForConfig} / {@link resolveModelId}) delegate here so the
 * billing UI's advertised default and the agent loop's actual default can
 * never diverge (#3098).
 *
 * @throws {Error} on an unknown provider or a provider with no resolvable model.
 */
function resolveSelection(
  providerOverride?: string,
  modelOverride?: string,
): { provider: ConfigProvider; modelId: string } {
  const raw = providerOverride ?? process.env.ATLAS_PROVIDER ?? getDefaultProvider();
  if (!VALID_PROVIDERS.has(raw as ConfigProvider)) {
    throw new Error(
      `Unknown provider "${raw}". Supported: ${[...VALID_PROVIDERS].join(", ")}`
    );
  }
  // Safe: validated by VALID_PROVIDERS.has() above
  const provider = raw as ConfigProvider;
  const modelId = modelOverride ?? process.env.ATLAS_MODEL ?? PROVIDER_DEFAULTS[provider];
  if (!modelId) {
    throw new Error(
      `ATLAS_MODEL is required when using the "${provider}" provider. ` +
        "Set it to the model ID served by your inference server (e.g. ATLAS_MODEL=llama3.1)."
    );
  }
  return { provider, modelId };
}

/**
 * Read and validate ATLAS_PROVIDER / ATLAS_MODEL from env.
 * Returns the validated config provider string and the resolved model ID.
 */
function resolveProvider(): { provider: ConfigProvider; modelId: string } {
  return resolveSelection();
}

/**
 * Resolve the model ID Atlas would actually run for the given (optional)
 * provider/model overrides — WITHOUT building an SDK client.
 *
 * This is the lightweight, side-effect-free SSOT used by surfaces that need to
 * display the effective/default model (e.g. the billing "Default AI model"
 * row) but must not instantiate a provider client or require provider API keys
 * to do so. The agent loop resolves the same value via {@link getModelForConfig}
 * (which additionally builds the client); both share {@link resolveSelection},
 * so the displayed default and the billed default cannot drift (#3098).
 *
 * @throws {Error} on an unknown provider or a provider with no resolvable model
 *   (e.g. `openai-compatible` with neither an override nor `ATLAS_MODEL`).
 */
export function resolveModelId(providerOverride?: string, modelOverride?: string): string {
  return resolveSelection(providerOverride, modelOverride).modelId;
}

// ---------------------------------------------------------------------------
// Shared model builder — single source of truth for provider→SDK mapping
// ---------------------------------------------------------------------------

/**
 * Build a LanguageModel from an explicit provider + model ID pair.
 * Both `getModel()` and `getModelForConfig()` delegate to this.
 *
 * @throws {Error} When required env vars are missing for the given provider
 *   (`OPENAI_COMPATIBLE_BASE_URL` for openai-compatible, `AI_GATEWAY_API_KEY` for gateway).
 */
function buildModel(provider: ConfigProvider, modelId: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);

    case "openai":
      return openai(modelId);

    case "bedrock":
      return isBedrockAnthropicModel(modelId)
        ? bedrockAnthropic(modelId)
        : bedrock(modelId);

    case "ollama": {
      const ollama = createOpenAI({
        baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
        // createOpenAI throws LoadAPIKeyError if no apiKey is provided and
        // OPENAI_API_KEY is unset. Local servers don't need authentication.
        apiKey: "not-needed",
      });
      return ollama(modelId);
    }

    case "openai-compatible": {
      const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
      if (!baseURL) {
        throw new Error(
          "OPENAI_COMPATIBLE_BASE_URL is required when using the openai-compatible provider. " +
            "Set it to the base URL of your inference server (e.g. http://localhost:8000/v1)."
        );
      }
      const compatible = createOpenAI({
        baseURL,
        // createOpenAI throws LoadAPIKeyError if no apiKey is provided and
        // OPENAI_API_KEY is unset. Most local servers ignore the header.
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "not-needed",
      });
      return compatible(modelId);
    }

    case "gateway":
      if (!process.env.AI_GATEWAY_API_KEY) {
        throw new Error(
          "AI_GATEWAY_API_KEY is not set. The gateway provider requires an API key. " +
            "Create one at https://vercel.com/~/ai/api-keys and set it in your .env file."
        );
      }
      return gateway(modelId);

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider "${String(_exhaustive)}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Resolve provider type
// ---------------------------------------------------------------------------

/**
 * Map a config-level provider to its runtime ProviderType.
 * Bedrock models using Anthropic's API get `bedrock-anthropic` for
 * cache-control and prompt formatting decisions.
 */
function resolveProviderType(provider: ConfigProvider, modelId: string): ProviderType {
  if (provider === "bedrock" && isBedrockAnthropicModel(modelId)) {
    return "bedrock-anthropic";
  }
  return provider;
}

export function getProviderType(): ProviderType {
  const { provider, modelId } = resolveProvider();
  return resolveProviderType(provider, modelId);
}

export function getModel(): LanguageModel {
  const { provider, modelId } = resolveProvider();
  return buildModel(provider, modelId);
}

/**
 * Create a model + provider type from explicit provider/model values.
 *
 * Used by the SaaS hot-reload path to resolve the model from settings
 * without mutating process.env. Falls back to env vars / defaults for
 * any value that is undefined.
 */
export function getModelForConfig(
  providerOverride?: string,
  modelOverride?: string,
): { model: LanguageModel; providerType: ProviderType; modelId: string } {
  const { provider, modelId } = resolveSelection(providerOverride, modelOverride);
  return {
    model: buildModel(provider, modelId),
    providerType: resolveProviderType(provider, modelId),
    modelId,
  };
}

/**
 * Resolve the model used for the compaction summarization call (#3761).
 *
 * Names a SEPARATE — typically cheaper — model for the summary, distinct from
 * the active turn model. The summary always runs on the SAME provider and
 * credentials as the turn; only the model id changes:
 * - When the turn resolved from a workspace model config (SaaS BYOT), rebuild
 *   the same workspace config with `model` swapped for `summaryModelId`, so the
 *   workspace's own provider + API key drive the cheaper call.
 * - Otherwise (platform / env-resolved provider), reuse {@link getModelForConfig}
 *   with the active provider and the summary model id override.
 *
 * Callers only invoke this when the `ATLAS_COMPACTION_SUMMARY_MODEL` knob is set
 * to a non-empty id that differs from the turn model; an unset knob keeps the
 * Compaction 1 behavior (summarize on the turn model) without touching this
 * function. Resolution failures are the caller's concern — the compaction seam
 * falls back to the turn model rather than erroring the turn.
 */
export function getSummaryModel(opts: {
  summaryModelId: string;
  /**
   * The turn's workspace model config when it resolved from one (SaaS BYOT);
   * `null` for the platform / env-resolved path.
   */
  workspaceConfig: WorkspaceModelConfig | null;
}): LanguageModel {
  const { summaryModelId, workspaceConfig } = opts;
  if (workspaceConfig) {
    return getModelFromWorkspaceConfig({ ...workspaceConfig, model: summaryModelId });
  }
  return getModelForConfig(undefined, summaryModelId).model;
}

// ── Workspace-level model resolution ────────────────────────────────

/**
 * Map a workspace ModelConfigProvider to a ProviderType for cache control
 * and system prompt formatting. Workspace providers are a subset of the
 * platform providers — we map them to the corresponding ProviderType.
 */
function workspaceProviderType(provider: ModelConfigProvider): ProviderType {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai";
    case "azure-openai":
    case "custom":
      return "openai-compatible";
    case "gateway":
      return "gateway";
    case "bedrock":
      // Workspace-saved bedrock rows are pointed at Anthropic-on-Bedrock
      // models by recommendation, but the SDK accepts any bedrock model
      // id — treat them as 'bedrock' for cache-control purposes and let
      // the underlying SDK handle dialect specifics.
      return "bedrock";
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown workspace provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * A resolved workspace-level model configuration: the provider credentials plus
 * the model id and connection details. Shared by {@link getModelFromWorkspaceConfig}
 * (which builds the turn model from it) and {@link getSummaryModel} (which rebuilds
 * it with only `model` swapped for the cheaper #3761 summary model), so the two
 * agree on the shape via one named type rather than one borrowing the other's
 * parameter list.
 */
export interface WorkspaceModelConfig {
  model: string;
  baseUrl: string | null;
  /** Required for provider='bedrock'; ignored for every other provider. */
  bedrockRegion: string | null;
  credentials: WorkspaceCredentials;
}

/**
 * Create a LanguageModel from a workspace-level model configuration.
 * Uses the provider's SDK with the workspace's own API key and settings.
 *
 * Consumes the typed `WorkspaceCredentials` union — no inline parsing
 * on the bedrock bundle. A `null` bedrock `bundle` is the union's
 * malformed-bundle signal, surfaced here as the same actionable
 * re-entry error the catalog refresh's `malformed_bedrock_bundle`
 * envelope points at.
 */
export function getModelFromWorkspaceConfig(config: WorkspaceModelConfig): LanguageModel {
  const { credentials } = config;
  switch (credentials.provider) {
    case "anthropic": {
      const client = createAnthropic({ apiKey: credentials.apiKey });
      return client(config.model);
    }

    case "openai": {
      const client = createOpenAI({ apiKey: credentials.apiKey });
      return client(config.model);
    }

    case "azure-openai":
    case "custom": {
      if (!config.baseUrl) {
        throw new Error(
          `Base URL is required for the ${credentials.provider} provider.`,
        );
      }
      // #3339 — re-validate at use time, not just at write time: configs
      // stored before the SSRF gate existed (or written through a future
      // path that skips route validation) must not aim the agent's
      // credentialed requests at internal hosts. Self-hosted internal
      // endpoints opt out via ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true.
      if (!isInternalEgressAllowed() && !isSafeExternalUrl(config.baseUrl)) {
        throw new Error(
          `Base URL for the ${credentials.provider} provider must be a public HTTPS endpoint ` +
            `(private, loopback, link-local, and internal hosts are blocked). ` +
            `Re-save the workspace model configuration with a public endpoint, or set ` +
            `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true on a self-hosted deployment.`,
        );
      }
      // Route the agent's inference request through the DNS-aware egress guard
      // (#4779): the sync `isSafeExternalUrl` above is a cheap pre-fail but is
      // DNS-blind, so a `baseUrl` hostname that RESOLVES to an internal IP would
      // otherwise reach cloud metadata / internal services on the SDK's own
      // fetch. `createGuardedFetch` resolves + validates + pins the target IP
      // immediately before connect. Self-hosted internal endpoints stay reachable
      // via the same `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS` opt-out honored above.
      const client = createOpenAI({
        apiKey: credentials.apiKey,
        baseURL: config.baseUrl,
        fetch: createGuardedFetch(),
      });
      return client(config.model);
    }

    case "gateway": {
      if (credentials.apiKey) {
        const client = createGateway({ apiKey: credentials.apiKey });
        return client(config.model);
      }
      if (!process.env.AI_GATEWAY_API_KEY) {
        throw new Error(
          "Gateway provider on platform credits requires AI_GATEWAY_API_KEY in the API env. " +
            "Set it on the deploy, or have the workspace supply its own gateway API key (BYOT).",
        );
      }
      return gateway(config.model);
    }

    case "bedrock": {
      if (!credentials.bundle) {
        // The union carries `bundle: null` when the decrypted row's
        // inner JSON failed to parse. User-facing message stays
        // generic — the admin's only fix is re-entry, which is what
        // the catalog refresh's `malformed_bedrock_bundle` 422
        // envelope already points at. The EE row mapper logs the
        // configId-scoped event; this log marks the AI-Layer surface
        // that tripped on it.
        log.warn(
          { provider: "bedrock", model: config.model },
          "Workspace bedrock bundle is null — re-entry required",
        );
        throw new Error(
          "Workspace bedrock credentials are malformed — re-enter the access key / secret on the AI Provider page.",
        );
      }
      if (!config.bedrockRegion) {
        throw new Error("AWS region is required for the bedrock provider.");
      }
      const { bundle } = credentials;
      const client = createAmazonBedrock({
        region: config.bedrockRegion,
        accessKeyId: bundle.accessKeyId,
        secretAccessKey: bundle.secretAccessKey,
        ...(bundle.sessionToken ? { sessionToken: bundle.sessionToken } : {}),
      });
      return client(config.model);
    }

    default: {
      const _exhaustive: never = credentials;
      throw new Error(`Unknown workspace provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Get the ProviderType for a workspace-level model configuration.
 * Used for cache control and system prompt formatting decisions.
 */
export function getWorkspaceProviderType(provider: ModelConfigProvider): ProviderType {
  return workspaceProviderType(provider);
}
