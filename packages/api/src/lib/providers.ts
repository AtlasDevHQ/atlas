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
import { bedrock } from "@ai-sdk/amazon-bedrock";
import { bedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { gateway } from "ai";
import type { LanguageModel } from "ai";
import type { ModelConfigProvider } from "@useatlas/types";

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

const PROVIDER_DEFAULTS: Record<ConfigProvider, string | undefined> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-4o",
  bedrock: "anthropic.claude-opus-4-6-v1:0",
  ollama: "llama3.1",
  "openai-compatible": undefined,
  gateway: "anthropic/claude-opus-4.6",
};

/** Returns the default provider string based on runtime environment. */
export function getDefaultProvider(): ConfigProvider {
  return process.env.VERCEL ? "gateway" : "anthropic";
}

function isBedrockAnthropicModel(modelId: string): boolean {
  return modelId.includes("anthropic") || modelId.includes("claude");
}

/**
 * Read and validate ATLAS_PROVIDER / ATLAS_MODEL from env.
 * Returns the validated config provider string and the resolved model ID.
 */
function resolveProvider(): { provider: ConfigProvider; modelId: string } {
  const raw = process.env.ATLAS_PROVIDER ?? getDefaultProvider();
  if (!VALID_PROVIDERS.has(raw as ConfigProvider)) {
    throw new Error(
      `Unknown provider "${raw}". Supported: ${[...VALID_PROVIDERS].join(", ")}`
    );
  }
  // Safe: validated by VALID_PROVIDERS.has() above
  const provider = raw as ConfigProvider;
  const modelId = process.env.ATLAS_MODEL ?? PROVIDER_DEFAULTS[provider];
  if (!modelId) {
    throw new Error(
      `ATLAS_MODEL is required when using the "${provider}" provider. ` +
        "Set it to the model ID served by your inference server (e.g. ATLAS_MODEL=llama3.1)."
    );
  }
  return { provider, modelId };
}

export function getProviderType(): ProviderType {
  const { provider, modelId } = resolveProvider();
  if (provider === "bedrock" && isBedrockAnthropicModel(modelId)) {
    return "bedrock-anthropic";
  }
  return provider;
}

export function getModel(): LanguageModel {
  const { provider, modelId } = resolveProvider();

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
      throw new Error(`Unknown provider "${_exhaustive}"`);
    }
  }
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
  const raw = providerOverride ?? process.env.ATLAS_PROVIDER ?? getDefaultProvider();
  if (!VALID_PROVIDERS.has(raw as ConfigProvider)) {
    throw new Error(
      `Unknown provider "${raw}". Supported: ${[...VALID_PROVIDERS].join(", ")}`
    );
  }
  const provider = raw as ConfigProvider;
  const modelId = modelOverride ?? process.env.ATLAS_MODEL ?? PROVIDER_DEFAULTS[provider];
  if (!modelId) {
    throw new Error(
      `ATLAS_MODEL is required when using the "${provider}" provider. ` +
        "Set it to the model ID served by your inference server (e.g. ATLAS_MODEL=llama3.1)."
    );
  }

  const model = getModel(); // delegates to resolveProvider() which reads process.env

  // For the resolved model, we need to create from the override values.
  // Reuse getModel's switch logic by temporarily providing the values.
  // Since getModel reads from resolveProvider() (process.env), and we
  // want the override values, we need to build the model directly.
  let resolvedModel: LanguageModel;

  // If overrides match what process.env already has, reuse getModel()
  const envProvider = process.env.ATLAS_PROVIDER ?? getDefaultProvider();
  const envModel = process.env.ATLAS_MODEL;
  if (providerOverride === envProvider && modelOverride === envModel) {
    resolvedModel = model;
  } else {
    // Build model from the specific provider + model ID
    switch (provider) {
      case "anthropic":
        resolvedModel = anthropic(modelId);
        break;
      case "openai":
        resolvedModel = openai(modelId);
        break;
      case "bedrock":
        resolvedModel = isBedrockAnthropicModel(modelId)
          ? bedrockAnthropic(modelId)
          : bedrock(modelId);
        break;
      case "ollama": {
        const ollama = createOpenAI({
          baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
          apiKey: "not-needed",
        });
        resolvedModel = ollama(modelId);
        break;
      }
      case "openai-compatible": {
        const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
        if (!baseURL) {
          throw new Error("OPENAI_COMPATIBLE_BASE_URL is required when using the openai-compatible provider.");
        }
        const compatible = createOpenAI({
          baseURL,
          apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "not-needed",
        });
        resolvedModel = compatible(modelId);
        break;
      }
      case "gateway":
        if (!process.env.AI_GATEWAY_API_KEY) {
          throw new Error("AI_GATEWAY_API_KEY is not set. The gateway provider requires an API key.");
        }
        resolvedModel = gateway(modelId);
        break;
      default: {
        const _exhaustive: never = provider;
        throw new Error(`Unknown provider "${_exhaustive}"`);
      }
    }
  }

  const providerType: ProviderType = (provider === "bedrock" && isBedrockAnthropicModel(modelId))
    ? "bedrock-anthropic"
    : provider;

  return { model: resolvedModel, providerType, modelId };
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
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown workspace provider: ${_exhaustive}`);
    }
  }
}

/**
 * Create a LanguageModel from a workspace-level model configuration.
 * Uses the provider's SDK with the workspace's own API key and settings.
 */
export function getModelFromWorkspaceConfig(config: {
  provider: ModelConfigProvider;
  model: string;
  apiKey: string;
  baseUrl: string | null;
}): LanguageModel {
  switch (config.provider) {
    case "anthropic": {
      const client = createAnthropic({ apiKey: config.apiKey });
      return client(config.model);
    }

    case "openai": {
      const client = createOpenAI({ apiKey: config.apiKey });
      return client(config.model);
    }

    case "azure-openai": {
      if (!config.baseUrl) {
        throw new Error("Base URL is required for the azure-openai provider.");
      }
      const client = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      return client(config.model);
    }

    case "custom": {
      if (!config.baseUrl) {
        throw new Error("Base URL is required for the custom provider.");
      }
      const client = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      return client(config.model);
    }

    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown workspace provider: ${_exhaustive}`);
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
