/**
 * Multi-provider LLM configuration.
 *
 * Set ATLAS_PROVIDER and the corresponding API key in your .env.
 * Supports Anthropic, OpenAI, AWS Bedrock, Ollama, and Vercel AI Gateway.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { bedrock } from "@ai-sdk/amazon-bedrock";
import { bedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { gateway } from "ai";
import type { LanguageModel } from "ai";

/** Provider strings accepted in ATLAS_PROVIDER. */
type ConfigProvider = "anthropic" | "openai" | "bedrock" | "ollama" | "gateway";

/** Resolved provider type (bedrock splits into bedrock vs bedrock-anthropic). */
export type ProviderType = ConfigProvider | "bedrock-anthropic";

const VALID_PROVIDERS: ReadonlySet<ConfigProvider> = new Set([
  "anthropic",
  "openai",
  "bedrock",
  "ollama",
  "gateway",
]);

const PROVIDER_DEFAULTS: Record<ConfigProvider, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-4o",
  bedrock: "anthropic.claude-opus-4-6-v1:0",
  ollama: "llama3.1",
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
      });
      return ollama(modelId);
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
